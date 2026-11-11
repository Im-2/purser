import type { AttemptRow, LedgerRow, Repos } from "../db/repos.js";
import type { EventBus } from "../events.js";
import { fromMinor } from "../money.js";
import { MONEY_MAY_HAVE_MOVED, PAYOUT_PROBLEM_STATUSES, normalizeEvent, type Envelope, type Observed } from "./events.js";

export type FindingType = "unrecorded_movement" | "amount_mismatch" | "duplicate" | "payout_denied_or_unclaimed";

export interface ReconDeps {
  repos: Repos;
  bus: EventBus;
}

export interface FindingOut {
  id: string;
  finding_type: FindingType;
  detail: Record<string, unknown>;
}

export interface ProcessResult {
  /** duplicate_event: this event id was already processed (replay), nothing was done. ignored: not an event we reconcile. */
  outcome: "processed" | "duplicate_event" | "ignored";
  event_id: string;
  event_type: string;
  matched: number;
  findings: FindingOut[];
}

/** Row writer shared by webhook processing and the manual run. Publishes reconciliation_finding for anything that is not ok. */
export function recorder(deps: ReconDeps) {
  const findings: FindingOut[] = [];
  let matched = 0;
  return {
    findings,
    get matched() {
      return matched;
    },
    ok(a: { ledger_id: string | null; event_id: string | null; event_type: string | null; ref_key: string; detail: Record<string, unknown> }) {
      deps.repos.reconciliation.create({ ledger_id: a.ledger_id, paypal_event_id: a.event_id, event_type: a.event_type, matched: true, detail: a.detail, ref_key: a.ref_key });
      matched++;
    },
    finding(a: { type: FindingType; ledger_id: string | null; event_id: string | null; event_type: string | null; ref_key: string | null; detail: Record<string, unknown> }) {
      const row = deps.repos.reconciliation.create({ ledger_id: a.ledger_id, paypal_event_id: a.event_id, event_type: a.event_type, matched: false, finding_type: a.type, detail: a.detail, ref_key: a.ref_key });
      const out: FindingOut = { id: row.id, finding_type: a.type, detail: a.detail };
      findings.push(out);
      deps.bus.publish({ type: "reconciliation_finding", data: { id: row.id, finding_type: a.type, detail: a.detail } });
      return out;
    },
    note(a: { ledger_id: string | null; event_id: string | null; event_type: string | null; ref_key: string | null; detail: Record<string, unknown> }) {
      deps.repos.reconciliation.create({ ledger_id: a.ledger_id, paypal_event_id: a.event_id, event_type: a.event_type, matched: false, detail: a.detail, ref_key: a.ref_key });
    },
  };
}
export type Recorder = ReturnType<typeof recorder>;

/** Find the ledger row (and attempt) a payout belongs to: sender_item_id is the attempt id, else the stored batch id. */
export function resolvePayout(repos: Repos, ids: Observed["ids"]): { ledger?: LedgerRow; attempt?: AttemptRow; via?: string } {
  let attempt: AttemptRow | undefined;
  let via: string | undefined;
  if (ids.sender_item_id) {
    attempt = repos.attempts.get(ids.sender_item_id);
    if (attempt) via = "sender_item_id";
  }
  if (!attempt && ids.sender_batch_id?.startsWith("batch_")) {
    attempt = repos.attempts.get(ids.sender_batch_id.slice("batch_".length));
    if (attempt) via = "sender_batch_id";
  }
  let ledger = attempt?.ledger_id ? repos.ledger.get(attempt.ledger_id) : undefined;
  if (!ledger && ids.payout_batch_id) {
    ledger = repos.ledger.findByRef("payout_batch_id", ids.payout_batch_id);
    if (ledger) {
      via = "payout_batch_id";
      attempt ??= repos.attempts.get(ledger.attempt_id);
    }
  }
  return { ledger, attempt, via };
}

const amountText = (minor: number | null, cur: string | null) => (minor === null ? null : `${fromMinor(minor)} ${cur ?? ""}`.trim());

/** Compare what PayPal says with what Purser recorded. Empty array means they agree. */
function compare(obs: Pick<Observed, "amountMinor" | "currency" | "receiver">, ledger: LedgerRow, attempt?: AttemptRow): string[] {
  const out: string[] = [];
  if (ledger.amount !== null && obs.amountMinor !== null && ledger.amount !== obs.amountMinor) out.push(`amount: recorded ${amountText(ledger.amount, ledger.currency)}, PayPal ${amountText(obs.amountMinor, obs.currency)}`);
  if (ledger.currency && obs.currency && ledger.currency.toUpperCase() !== obs.currency) out.push(`currency: recorded ${ledger.currency}, PayPal ${obs.currency}`);
  if (attempt?.payee_email && obs.receiver && attempt.payee_email.toLowerCase() !== obs.receiver.toLowerCase()) out.push(`receiver: approved ${attempt.payee_email}, PayPal paid ${obs.receiver}`);
  return out;
}

/**
 * Reconcile one verified (or simulated) webhook event against the ledger.
 * Replays of the same event id are ignored. Everything here is database-only, so the route can answer 200 quickly.
 */
export function processWebhookEvent(deps: ReconDeps, env: Envelope, source: "webhook" | "simulated"): ProcessResult {
  const { repos } = deps;
  const base = { event_id: env.id, event_type: env.event_type };

  if (!repos.webhookEvents.tryInsert(env.id, env.event_type, source)) return { outcome: "duplicate_event", matched: 0, findings: [], ...base };

  const obs = normalizeEvent(env);
  if (!obs) {
    repos.webhookEvents.setOutcome(env.id, "ignored");
    return { outcome: "ignored", matched: 0, findings: [], ...base };
  }

  const rec = applyObserved(deps, obs, env, source);

  repos.webhookEvents.setOutcome(env.id, rec.findings.length ? "finding" : "ok");
  return { outcome: "processed", matched: rec.matched, findings: rec.findings, ...base };
}

/**
 * Reconcile something PayPal says happened. `run` is the manual reconciliation run: anything already reconciled (by a webhook
 * or an earlier run) is skipped silently, rather than reported as a duplicate.
 */
export function applyObserved(deps: ReconDeps, obs: Observed, env: Envelope, source: "webhook" | "simulated" | "run"): Recorder {
  const rec = recorder(deps);
  const ctx: Ctx = { rec, repos: deps.repos, env, obs, source };
  if (obs.kind === "payout_item" || obs.kind === "payout_batch") reconcilePayout(ctx);
  else if (obs.kind === "refund") reconcileRefund(ctx);
  else reconcileCapture(ctx);
  return rec;
}

/** A manual run must see its own earlier rows as "already reconciled", so it excludes nothing; webhooks exclude their own event id. */
const exceptFor = (c: { source: string; env: { id: string } }) => (c.source === "run" ? undefined : c.env.id);

/**
 * True when this is a manual run, or when the earlier row came from a manual run: the same fact seen through two channels
 * (run then webhook, or webhook then run) is not PayPal repeating itself, so it is skipped rather than reported as a duplicate.
 */
const reconciledElsewhere = (c: { source: string }, prior: { paypal_event_id: string | null }) => c.source === "run" || Boolean(prior.paypal_event_id?.startsWith("run:"));

interface Ctx {
  rec: Recorder;
  repos: Repos;
  env: Envelope;
  obs: Observed;
  source: "webhook" | "simulated" | "run";
}

function observedDetail(c: Ctx): Record<string, unknown> {
  const { obs } = c;
  return {
    event_type: obs.eventType,
    status: obs.status,
    simulated: c.source === "simulated",
    ...Object.fromEntries(Object.entries(obs.ids).filter(([, v]) => v !== null)),
    ...(obs.receiver ? { receiver: obs.receiver } : {}),
    ...(obs.amountMinor !== null ? { amount: amountText(obs.amountMinor, obs.currency) } : {}),
  };
}

function reconcilePayout(c: Ctx) {
  const { rec, repos, env, obs } = c;
  const { ledger, attempt, via } = resolvePayout(repos, obs.ids);
  const subject = obs.ids.payout_batch_id ?? obs.ids.payout_item_id ?? env.id;
  const common = { event_id: env.id, event_type: env.event_type };

  // PayPal moved (or tried to move) money that Purser has no executed record of.
  if (!ledger) {
    const key = `movement:payout:${subject}`;
    if (repos.reconciliation.byRefKey(key, env.id)) return; // already reported (for example the item event came first, now the batch event)
    rec.finding({
      type: "unrecorded_movement",
      ledger_id: null,
      ref_key: key,
      ...common,
      detail: {
        ...observedDetail(c),
        reason: attempt ? "attempt_not_executed" : "no_attempt",
        ...(attempt ? { attempt_id: attempt.id, attempt_decision: attempt.decision } : {}),
        money_may_have_moved: MONEY_MAY_HAVE_MOVED.has(obs.status),
        message: attempt
          ? `PayPal reports a payout for attempt ${attempt.id}, which Purser did not execute (decision: ${attempt.decision}).`
          : "PayPal reports a payout that Purser has no attempt for. This looks like activity that bypassed Purser.",
      },
    });
    return;
  }

  // A different event id for the same payout item and status is a duplicate, not a second payment.
  const refKey = `${obs.kind}:${obs.ids.payout_item_id ?? obs.ids.payout_batch_id ?? ledger.id}:${obs.status}`;
  const prior = repos.reconciliation.byRefKey(refKey, exceptFor(c));
  if (prior) {
    if (reconciledElsewhere(c, prior)) return; // already reconciled by an earlier webhook, run or search
    rec.finding({ type: "duplicate", ledger_id: ledger.id, ref_key: refKey, ...common, detail: { ...observedDetail(c), original_event_id: prior.paypal_event_id, original_finding: prior.finding_type, message: "PayPal sent this outcome for the same payout more than once under different event ids." } });
    return;
  }

  repos.ledger.mergeRef(ledger.id, { ...(obs.ids.transaction_id ? { transaction_id: obs.ids.transaction_id } : {}), ...(obs.ids.payout_item_id ? { payout_item_id: obs.ids.payout_item_id } : {}) });

  if (obs.status === "PROCESSING" || obs.status === "PENDING") {
    repos.ledger.setStatus(ledger.id, obs.status);
    return;
  }

  repos.ledger.setStatus(ledger.id, obs.status);
  const mismatches = compare(obs, ledger, attempt);

  if (PAYOUT_PROBLEM_STATUSES.has(obs.status)) {
    rec.finding({ type: "payout_denied_or_unclaimed", ledger_id: ledger.id, ref_key: refKey, ...common, detail: { ...observedDetail(c), attempt_id: ledger.attempt_id, message: `PayPal reports the payout as ${obs.status}. The recipient may not have been paid, so the ledger and PayPal disagree.` } });
    return;
  }
  if (mismatches.length) {
    rec.finding({ type: "amount_mismatch", ledger_id: ledger.id, ref_key: refKey, ...common, detail: { ...observedDetail(c), attempt_id: ledger.attempt_id, mismatches, matched_via: via, message: `PayPal's record differs from what Purser approved: ${mismatches.join("; ")}.` } });
    return;
  }
  rec.ok({ ledger_id: ledger.id, event_id: env.id, event_type: env.event_type, ref_key: refKey, detail: { ...observedDetail(c), attempt_id: ledger.attempt_id, matched_via: via } });
}

function reconcileRefund(c: Ctx) {
  const { rec, repos, env, obs } = c;
  const common = { event_id: env.id, event_type: env.event_type };
  const refundId = obs.ids.refund_id;
  const captureId = obs.ids.capture_id;

  // Match by the refund id stored from the upstream result, else by an executed create_refund attempt for that capture.
  let ledger = refundId ? repos.ledger.findByText(refundId) : undefined;
  let attempt: AttemptRow | undefined = ledger ? repos.attempts.get(ledger.attempt_id) : undefined;
  if (!ledger && captureId) {
    attempt = repos.attempts.refundsForCapture(captureId)[0];
    ledger = attempt?.ledger_id ? repos.ledger.get(attempt.ledger_id) : undefined;
  }

  if (!ledger) {
    const key = `movement:refund:${refundId ?? env.id}`;
    if (repos.reconciliation.byRefKey(key, env.id)) return;
    rec.finding({ type: "unrecorded_movement", ledger_id: null, ref_key: key, ...common, detail: { ...observedDetail(c), reason: "no_attempt", money_may_have_moved: true, message: "PayPal reports a refund that Purser has no executed refund for. The merchant account may have been used outside Purser." } });
    return;
  }

  const refKey = `refund:${refundId ?? ledger.id}`;
  const prior = repos.reconciliation.byRefKey(refKey, exceptFor(c));
  if (prior) {
    if (reconciledElsewhere(c, prior)) return;
    rec.finding({ type: "duplicate", ledger_id: ledger.id, ref_key: refKey, ...common, detail: { ...observedDetail(c), original_event_id: prior.paypal_event_id, message: "This refund was reported more than once under different event ids." } });
    return;
  }
  // A second, different refund id landing on a ledger row that already has one is a second refund for one approval.
  const known = ledger ? (JSON.parse(ledger.paypal_ref_json) as { refund_id?: string }).refund_id : undefined;
  if (known && refundId && known !== refundId) {
    rec.finding({ type: "duplicate", ledger_id: ledger.id, ref_key: refKey, ...common, detail: { ...observedDetail(c), first_refund_id: known, message: "A second refund was issued for a capture that Purser approved a refund for once." } });
    return;
  }
  if (refundId) repos.ledger.mergeRef(ledger.id, { refund_id: refundId });
  const mismatches = compare(obs, ledger, attempt);
  if (mismatches.length) {
    rec.finding({ type: "amount_mismatch", ledger_id: ledger.id, ref_key: refKey, ...common, detail: { ...observedDetail(c), attempt_id: ledger.attempt_id, mismatches, message: `Refund differs from what Purser approved: ${mismatches.join("; ")}.` } });
    return;
  }
  rec.ok({ ledger_id: ledger.id, event_id: env.id, event_type: env.event_type, ref_key: refKey, detail: { ...observedDetail(c), attempt_id: ledger.attempt_id } });
}

function reconcileCapture(c: Ctx) {
  const { rec, repos, env, obs } = c;
  const common = { event_id: env.id, event_type: env.event_type };
  const captureId = obs.ids.capture_id;
  const ledger = (captureId ? repos.ledger.findByText(captureId) : undefined) ?? (obs.ids.order_id ? repos.ledger.findByText(obs.ids.order_id) : undefined);
  const refKey = `capture:${captureId ?? env.id}:${obs.status}`;

  if (!ledger) {
    // Inbound customer payments are normal business and are not Purser's to approve: record, do not raise a finding.
    rec.note({ ledger_id: null, ref_key: refKey, ...common, detail: { ...observedDetail(c), note: "Capture not initiated through Purser (for example a customer checkout); no finding." } });
    return;
  }
  const prior = repos.reconciliation.byRefKey(refKey, exceptFor(c));
  if (prior) {
    if (reconciledElsewhere(c, prior)) return;
    rec.finding({ type: "duplicate", ledger_id: ledger.id, ref_key: refKey, ...common, detail: { ...observedDetail(c), original_event_id: prior.paypal_event_id, message: "This capture outcome was reported more than once under different event ids." } });
    return;
  }
  if (captureId) repos.ledger.mergeRef(ledger.id, { capture_id: captureId });
  if (obs.status === "REVERSED" || obs.status === "DENIED" || obs.status === "DECLINED") {
    repos.ledger.setStatus(ledger.id, obs.status);
    rec.finding({ type: "payout_denied_or_unclaimed", ledger_id: ledger.id, ref_key: refKey, ...common, detail: { ...observedDetail(c), attempt_id: ledger.attempt_id, message: `PayPal reports the capture as ${obs.status}; Purser recorded it as executed.` } });
    return;
  }
  if (obs.status === "PENDING") return;
  const mismatches = compare(obs, ledger);
  if (mismatches.length) {
    rec.finding({ type: "amount_mismatch", ledger_id: ledger.id, ref_key: refKey, ...common, detail: { ...observedDetail(c), attempt_id: ledger.attempt_id, mismatches, message: `Capture differs from what Purser recorded: ${mismatches.join("; ")}.` } });
    return;
  }
  rec.ok({ ledger_id: ledger.id, event_id: env.id, event_type: env.event_type, ref_key: refKey, detail: { ...observedDetail(c), attempt_id: ledger.attempt_id } });
}
