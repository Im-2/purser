import { fromMinor } from "../money.js";
import type { PayPalClient } from "./client.js";

export interface CreatePayoutInput {
  receiverEmail: string;
  /** Integer minor units (cents). Never a float. */
  amountMinor: number;
  currency: string;
  note?: string;
  /** Derived from the Purser attempt id so reconciliation can match PayPal events back to the ledger. */
  senderItemId: string;
  /** Sent as PayPal-Request-Id so retries cannot double-pay. */
  idempotencyKey: string;
  /** Defaults to `batch_<senderItemId>`. */
  senderBatchId?: string;
  emailSubject?: string;
}

export type BatchStatus = "DENIED" | "PENDING" | "PROCESSING" | "SUCCESS" | "CANCELED";
export type ItemStatus = "SUCCESS" | "FAILED" | "PENDING" | "UNCLAIMED" | "RETURNED" | "ONHOLD" | "BLOCKED" | "REFUNDED" | "REVERSED";

export interface PayoutBatchHeader {
  payout_batch_id: string;
  batch_status: BatchStatus;
  time_created?: string;
  time_completed?: string;
  sender_batch_header?: { sender_batch_id?: string; email_subject?: string };
  amount?: { currency: string; value: string };
  fees?: { currency: string; value: string };
}

export interface PayoutBatch {
  batch_header: PayoutBatchHeader;
  items?: {
    payout_item_id: string;
    transaction_id?: string;
    transaction_status: ItemStatus;
    payout_batch_id: string;
    sender_batch_id?: string;
    payout_item: { receiver: string; amount: { currency: string; value: string }; sender_item_id?: string; note?: string };
    errors?: { name?: string; message?: string };
  }[];
}

/** Ids derived from a Purser attempt id. PayPal allows up to 30 chars for sender_batch_id in some regions, so keep them short. */
export function payoutIdsForAttempt(attemptId: string): { senderBatchId: string; senderItemId: string; idempotencyKey: string } {
  return { senderBatchId: `batch_${attemptId}`, senderItemId: attemptId, idempotencyKey: `purser-payout-${attemptId}` };
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** POST /v1/payments/payouts. Returns the 201 body ({ batch_header, links }). */
export async function createPayout(client: PayPalClient, input: CreatePayoutInput): Promise<{ batch_header: PayoutBatchHeader }> {
  if (!EMAIL.test(input.receiverEmail)) throw new Error("createPayout: invalid receiver email");
  if (!Number.isSafeInteger(input.amountMinor) || input.amountMinor <= 0) throw new Error("createPayout: amountMinor must be a positive integer");
  if (!/^[A-Za-z]{3}$/.test(input.currency)) throw new Error("createPayout: invalid currency");
  if (!input.senderItemId || !input.idempotencyKey) throw new Error("createPayout: senderItemId and idempotencyKey are required");

  const body = {
    sender_batch_header: {
      sender_batch_id: input.senderBatchId ?? `batch_${input.senderItemId}`,
      email_subject: input.emailSubject ?? "You have a payment",
    },
    items: [
      {
        recipient_type: "EMAIL",
        receiver: input.receiverEmail,
        amount: { value: fromMinor(input.amountMinor), currency: input.currency.toUpperCase() },
        note: input.note ?? "Payment",
        sender_item_id: input.senderItemId,
      },
    ],
  };
  return client.request("POST", "/v1/payments/payouts", { body, requestId: input.idempotencyKey });
}

/** GET /v1/payments/payouts/{batch_id} */
export function getPayoutBatch(client: PayPalClient, batchId: string): Promise<PayoutBatch> {
  if (!/^[A-Za-z0-9_-]+$/.test(batchId)) throw new Error("getPayoutBatch: invalid batch id");
  return client.request("GET", `/v1/payments/payouts/${batchId}`);
}

export const FINAL_BATCH_STATUSES: ReadonlySet<BatchStatus> = new Set(["SUCCESS", "DENIED", "CANCELED"]);

/** Poll until the batch reaches a final status or the timeout passes. Returns the last batch seen. */
export async function waitForPayoutBatch(
  client: PayPalClient,
  batchId: string,
  o: { timeoutMs?: number; intervalMs?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<PayoutBatch> {
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const deadline = Date.now() + (o.timeoutMs ?? 60_000);
  for (;;) {
    const batch = await getPayoutBatch(client, batchId);
    if (FINAL_BATCH_STATUSES.has(batch.batch_header.batch_status) || Date.now() >= deadline) return batch;
    await sleep(o.intervalMs ?? 3_000);
  }
}
