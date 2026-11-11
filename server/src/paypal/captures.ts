import { toMinor } from "../money.js";
import type { PayPalClient } from "./client.js";

export interface CaptureDetails {
  id: string;
  status: string;
  /** Integer minor units, or null if PayPal returned something unparseable (callers must escalate). */
  amountMinor: number | null;
  currency: string | null;
  /** Amount already refunded, if reported. */
  refundedMinor: number | null;
}

/** GET /v2/payments/captures/{id}. Used to resolve a refund with no amount to the real captured amount. */
export async function getCapture(client: PayPalClient, captureId: string): Promise<CaptureDetails> {
  if (!/^[A-Za-z0-9_-]{5,64}$/.test(captureId)) throw new Error("getCapture: invalid capture id");
  const c = await client.request<{
    id: string;
    status: string;
    amount?: { value?: string; currency_code?: string };
    seller_receivable_breakdown?: unknown;
  }>("GET", `/v2/payments/captures/${captureId}`);
  const amountMinor = toMinor(c.amount?.value);
  return {
    id: c.id,
    status: c.status,
    amountMinor: amountMinor && amountMinor > 0 ? amountMinor : null,
    currency: c.amount?.currency_code?.toUpperCase() ?? null,
    refundedMinor: null,
  };
}
