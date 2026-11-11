import { toMinor } from "../money.js";
import { PayPalError, PayPalNetworkError, getPayoutBatch, type PayPalClient, type PayoutBatch } from "../paypal/index.js";
import type { Envelope, Observed } from "./events.js";
import { applyObserved, recorder, type FindingOut, type ReconDeps } from "./matcher.js";

const HOUR = 60 * 60 * 1000;
/** Sandbox Transaction Search can trail real time by hours. Beyond this we call it "lagging". */
const LAG_THRESHOLD_MS = 30 * 60 * 1000;
/** Reporting transaction codes for money leaving the account: T0001 payouts (MassPay), T1107 refunds. Fees and holds are ignored. */
const OUTGOING_CODES = new Set(["T0001", "T1107"]);

export interface RunDeps extends ReconDeps {
  paypal: PayPalClient | null;
  now?: () => number;
}

export interface TransactionSearchReport {
  status: "ok" | "lagging" | "unavailable" | "skipped";
  /** Plain-language explanation for the dashboard. */
  note: string;
  transactions_seen?: number;
  outgoing_seen?: number;
  last_refreshed?: string;
  lag_minutes?: number;
  error?: { status?: number; code?: string | null; message: string };
}

export interface RunResult {
  ran_at: string;
  since: string;
  ledger: { checked: number; matched: number; errors: string[] };
  transaction_search: TransactionSearchReport;
  matched: number;
  findings: FindingOut[];
}

function itemObserved(batch: PayoutBatch, item: NonNullable<PayoutBatch["items"]>[number]): Observed {
  const amt = item.payout_item?.amount;
  const minor = toMinor(amt?.value);
  return {
    kind: "payout_item",
    eventId: `run:${item.payout_item_id}`,
    eventType: "RECONCILIATION_RUN",
    status: item.transaction_status === "SUCCESS" ? "SUCCESS" : item.transaction_status,
    ids: {
      payout_batch_id: batch.batch_header.payout_batch_id,
      payout_item_id: item.payout_item_id,
      sender_batch_id: item.sender_batch_id ?? batch.batch_header.sender_batch_header?.sender_batch_id ?? null,
      sender_item_id: item.payout_item?.sender_item_id ?? null,
      transaction_id: item.transaction_id ?? null,
      capture_id: null,
      refund_id: null,
      order_id: null,
    },
    amountMinor: minor !== null && minor > 0 ? minor : null,
    currency: amt?.currency ? amt.currency.toUpperCase() : null,
    receiver: item.payout_item?.receiver ?? null,
  };
}

const errText = (e: unknown) => (e instanceof PayPalError ? `HTTP ${e.status} ${e.code ?? ""}`.trim() : e instanceof PayPalNetworkError ? "network error" : (e as Error).message);

/**
 * Manual reconciliation run: (1) look up the batch for every payout ledger row since `sinceMs` and reconcile it, then
 * (2) pull recent transactions from Transaction Search and flag outgoing payouts or refunds Purser has no record of.
 * It never throws: a failed or lagging search is reported in `transaction_search` and the rest of the run still counts.
 */
export async function runReconciliation(deps: RunDeps, o: { sinceMs?: number } = {}): Promise<RunResult> {
  const { repos, paypal } = deps;
  const nowMs = (deps.now ?? Date.now)();
  const sinceMs = o.sinceMs ?? nowMs - 24 * HOUR;
  const errors: string[] = [];
  const findings: FindingOut[] = [];
  let matchedTotal = 0;
  let checked = 0;

  // ---- 1. ledger rows -> batch lookups ----
  const payoutRows = repos.ledger.list(500).filter((l) => l.created_at >= sinceMs && typeof (JSON.parse(l.paypal_ref_json) as { payout_batch_id?: unknown }).payout_batch_id === "string");
  for (const row of payoutRows.slice(0, 50)) {
    if (!paypal) {
      errors.push("PayPal is not configured; batch lookups skipped");
      break;
    }
    const batchId = (JSON.parse(row.paypal_ref_json) as { payout_batch_id: string }).payout_batch_id;
    try {
      const batch = await getPayoutBatch(paypal, batchId);
      checked++;
      repos.ledger.setStatus(row.id, batch.batch_header.batch_status === "SUCCESS" ? "SUCCESS" : batch.batch_header.batch_status);
      const items = batch.items ?? [];
      if (items.length === 0) errors.push(`batch ${batchId} returned no items yet`);
      for (const item of items) {
        const obs = itemObserved(batch, item);
        const env: Envelope = { id: obs.eventId, event_type: obs.eventType, resource: {} };
        const r = applyObserved(deps, obs, env, "run");
        findings.push(...r.findings);
        matchedTotal += r.matched;
      }
    } catch (e) {
      errors.push(`batch ${batchId}: ${errText(e)}`);
    }
  }

  // ---- 2. Transaction Search ----
  const searchRec = recorder(deps);
  const search = paypal ? await searchTransactions(deps, paypal, sinceMs, nowMs, searchRec) : ({ status: "skipped", note: "PayPal is not configured." } as TransactionSearchReport);
  findings.push(...searchRec.findings);

  return {
    ran_at: new Date(nowMs).toISOString(),
    since: new Date(sinceMs).toISOString(),
    ledger: { checked, matched: matchedTotal, errors },
    transaction_search: search,
    matched: matchedTotal,
    findings,
  };
}

async function searchTransactions(deps: RunDeps, paypal: PayPalClient, sinceMs: number, nowMs: number, rec: ReturnType<typeof recorder>): Promise<TransactionSearchReport> {
  const { repos } = deps;
  // PayPal limits the window to 31 days.
  const startMs = Math.max(sinceMs, nowMs - 30 * 24 * HOUR);
  type Txn = { transaction_info?: { transaction_id?: string; paypal_reference_id?: string; transaction_event_code?: string; transaction_initiation_date?: string; transaction_amount?: { value?: string; currency_code?: string } } };
  let all: Txn[] = [];
  let lastRefreshed: string | undefined;
  try {
    for (let page = 1; page <= 3; page++) {
      const r = await paypal.request<{ transaction_details?: Txn[]; last_refreshed_datetime?: string; total_pages?: number }>("GET", "/v1/reporting/transactions", {
        query: { start_date: new Date(startMs).toISOString(), end_date: new Date(nowMs).toISOString(), fields: "transaction_info", page_size: 100, page },
      });
      all = all.concat(r.transaction_details ?? []);
      lastRefreshed = r.last_refreshed_datetime ?? lastRefreshed;
      if (!r.total_pages || page >= r.total_pages) break;
    }
  } catch (e) {
    // Search not enabled, rate limited, or the sandbox simply failing: not a reconciliation failure.
    const status = e instanceof PayPalError ? e.status : undefined;
    return {
      status: "unavailable",
      note: "Transaction Search could not be queried, so only ledger and webhook reconciliation ran. Try again later; the sandbox search endpoint is often slow or unavailable.",
      error: { status, code: e instanceof PayPalError ? e.code : null, message: errText(e) },
    };
  }

  // Money leaving the account that no ledger row accounts for.
  let outgoing = 0;
  for (const t of all) {
    const i = t.transaction_info;
    const value = Number(i?.transaction_amount?.value);
    if (!i?.transaction_id || !(value < 0) || !OUTGOING_CODES.has(i.transaction_event_code ?? "")) continue;
    outgoing++;
    if (repos.ledger.findByText(i.transaction_id)) continue; // a ledger row recorded this transaction id
    if (repos.reconciliation.findingMentioning("unrecorded_movement", i.transaction_id)) continue; // already reported
    rec.finding({
      type: "unrecorded_movement",
      ledger_id: null,
      event_id: null,
      event_type: "TRANSACTION_SEARCH",
      ref_key: `movement:txn:${i.transaction_id}`,
      detail: {
        source: "transaction_search",
        transaction_id: i.transaction_id,
        paypal_reference_id: i.paypal_reference_id ?? null,
        event_code: i.transaction_event_code,
        amount: `${Math.abs(value).toFixed(2)} ${i.transaction_amount?.currency_code ?? ""}`.trim(),
        initiated: i.transaction_initiation_date ?? null,
        money_may_have_moved: true,
        message: "Transaction Search shows money leaving the account that Purser has no ledger record of.",
      },
    });
  }

  const lagMs = lastRefreshed ? nowMs - Date.parse(lastRefreshed) : 0;
  const lagging = lastRefreshed !== undefined && Number.isFinite(lagMs) && lagMs > LAG_THRESHOLD_MS;
  return {
    status: lagging ? "lagging" : "ok",
    note: lagging
      ? `Sandbox transaction search is behind: it was last refreshed at ${lastRefreshed} (${Math.round(lagMs / 60000)} minutes ago). Activity after that time is not searchable yet; webhooks and batch lookups still cover it.`
      : "Transaction Search is up to date.",
    transactions_seen: all.length,
    outgoing_seen: outgoing,
    ...(lastRefreshed ? { last_refreshed: lastRefreshed, lag_minutes: Math.max(0, Math.round(lagMs / 60000)) } : {}),
  };
}
