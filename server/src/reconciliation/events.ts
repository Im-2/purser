import { z } from "zod";
import { toMinor } from "../money.js";

/**
 * PayPal webhook event handling. Event names and payload shapes follow PayPal's current docs
 * (developer.paypal.com/api/rest/webhooks/event-names): payout item events carry the payout_item object, batch events carry
 * batch_header (no items), capture events carry the capture, and PAYMENT.CAPTURE.REFUNDED carries the refund.
 */

/** Envelope of a webhook notification. Extra fields are kept. */
export const EnvelopeSchema = z
  .object({
    id: z.string().min(1).max(200),
    event_type: z.string().min(1).max(100),
    create_time: z.string().optional(),
    resource_type: z.string().optional(),
    summary: z.string().optional(),
    resource: z.record(z.string(), z.unknown()),
  })
  .passthrough();
export type Envelope = z.infer<typeof EnvelopeSchema>;

export type ObservedKind = "payout_item" | "payout_batch" | "capture" | "refund";

/** Statuses that mean a payout did not complete as paid (unclaimed, failed, blocked, held, returned, refunded, canceled, denied). */
export const PAYOUT_PROBLEM_STATUSES: ReadonlySet<string> = new Set(["FAILED", "BLOCKED", "HELD", "RETURNED", "REFUNDED", "UNCLAIMED", "CANCELED", "DENIED"]);
/** Statuses that mean money may have left the account even though the payout did not finish cleanly. */
export const MONEY_MAY_HAVE_MOVED: ReadonlySet<string> = new Set(["SUCCESS", "UNCLAIMED", "HELD", "REFUNDED", "RETURNED", "PROCESSING", "PENDING"]);

const ITEM_EVENTS: Record<string, string> = {
  "PAYMENT.PAYOUTS-ITEM.SUCCEEDED": "SUCCESS",
  "PAYMENT.PAYOUTS-ITEM.FAILED": "FAILED",
  "PAYMENT.PAYOUTS-ITEM.BLOCKED": "BLOCKED",
  "PAYMENT.PAYOUTS-ITEM.HELD": "HELD",
  "PAYMENT.PAYOUTS-ITEM.RETURNED": "RETURNED",
  "PAYMENT.PAYOUTS-ITEM.REFUNDED": "REFUNDED",
  "PAYMENT.PAYOUTS-ITEM.UNCLAIMED": "UNCLAIMED",
  "PAYMENT.PAYOUTS-ITEM.CANCELED": "CANCELED",
  // Not in PayPal's current event list, but accepted so older docs and test fixtures still work.
  "PAYMENT.PAYOUTS-ITEM.DENIED": "DENIED",
};
const BATCH_EVENTS: Record<string, string> = {
  "PAYMENT.PAYOUTSBATCH.PROCESSING": "PROCESSING",
  "PAYMENT.PAYOUTSBATCH.SUCCESS": "SUCCESS",
  "PAYMENT.PAYOUTSBATCH.DENIED": "DENIED",
};
const CAPTURE_EVENTS: Record<string, string> = {
  "PAYMENT.CAPTURE.COMPLETED": "COMPLETED",
  "PAYMENT.CAPTURE.PENDING": "PENDING",
  "PAYMENT.CAPTURE.REVERSED": "REVERSED",
  "PAYMENT.CAPTURE.DENIED": "DENIED",
  "PAYMENT.CAPTURE.DECLINED": "DECLINED",
};
const REFUND_EVENTS: Record<string, string> = { "PAYMENT.CAPTURE.REFUNDED": "REFUNDED" };

export const HANDLED_EVENT_TYPES: string[] = [...Object.keys(ITEM_EVENTS), ...Object.keys(BATCH_EVENTS), ...Object.keys(CAPTURE_EVENTS), ...Object.keys(REFUND_EVENTS)];

export interface Observed {
  kind: ObservedKind;
  eventId: string;
  eventType: string;
  status: string;
  ids: {
    payout_batch_id: string | null;
    payout_item_id: string | null;
    sender_batch_id: string | null;
    sender_item_id: string | null;
    transaction_id: string | null;
    capture_id: string | null;
    refund_id: string | null;
    order_id: string | null;
  };
  /** Integer minor units, or null if absent or unparseable. */
  amountMinor: number | null;
  currency: string | null;
  receiver: string | null;
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);

function money(v: unknown): { minor: number | null; currency: string | null } {
  if (!isObj(v)) return { minor: null, currency: null };
  const minor = toMinor(v.value);
  const cur = str(v.currency_code) ?? str(v.currency);
  return { minor: minor !== null && minor > 0 ? minor : null, currency: cur ? cur.toUpperCase() : null };
}

const emptyIds = (): Observed["ids"] => ({ payout_batch_id: null, payout_item_id: null, sender_batch_id: null, sender_item_id: null, transaction_id: null, capture_id: null, refund_id: null, order_id: null });

/** Turn a webhook envelope into what PayPal says happened. Returns null for events Purser does not reconcile. */
export function normalizeEvent(env: Envelope): Observed | null {
  const r = env.resource;
  const base = { eventId: env.id, eventType: env.event_type };

  if (ITEM_EVENTS[env.event_type]) {
    const item = isObj(r.payout_item) ? r.payout_item : {};
    const m = money(item.amount ?? r.amount);
    return {
      ...base,
      kind: "payout_item",
      status: ITEM_EVENTS[env.event_type]!,
      ids: { ...emptyIds(), payout_batch_id: str(r.payout_batch_id), payout_item_id: str(r.payout_item_id), sender_batch_id: str(r.sender_batch_id), sender_item_id: str(item.sender_item_id) ?? str(r.sender_item_id), transaction_id: str(r.transaction_id) },
      amountMinor: m.minor,
      currency: m.currency,
      receiver: str(item.receiver),
    };
  }

  if (BATCH_EVENTS[env.event_type]) {
    const h = isObj(r.batch_header) ? r.batch_header : r;
    const sbh = isObj(h.sender_batch_header) ? h.sender_batch_header : {};
    const m = money(h.amount);
    return {
      ...base,
      kind: "payout_batch",
      status: BATCH_EVENTS[env.event_type]!,
      ids: { ...emptyIds(), payout_batch_id: str(h.payout_batch_id), sender_batch_id: str(sbh.sender_batch_id) },
      amountMinor: m.minor,
      currency: m.currency,
      receiver: null,
    };
  }

  if (CAPTURE_EVENTS[env.event_type]) {
    const related = isObj(r.supplementary_data) && isObj(r.supplementary_data.related_ids) ? r.supplementary_data.related_ids : {};
    const m = money(r.amount);
    return { ...base, kind: "capture", status: CAPTURE_EVENTS[env.event_type]!, ids: { ...emptyIds(), capture_id: str(r.id), order_id: str(related.order_id) }, amountMinor: m.minor, currency: m.currency, receiver: null };
  }

  if (REFUND_EVENTS[env.event_type]) {
    // PAYMENT.CAPTURE.REFUNDED carries the refund object; its "up" link points at the capture that was refunded.
    const links = Array.isArray(r.links) ? r.links.filter(isObj) : [];
    const up = str(links.find((l) => l.rel === "up")?.href);
    const captureId = up ? (/\/captures\/([^/?#]+)/.exec(up)?.[1] ?? null) : null;
    const m = money(r.amount);
    return { ...base, kind: "refund", status: REFUND_EVENTS[env.event_type]!, ids: { ...emptyIds(), refund_id: str(r.id), capture_id: captureId }, amountMinor: m.minor, currency: m.currency, receiver: null };
  }

  return null;
}
