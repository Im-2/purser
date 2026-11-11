import type { ApprovalRow, Repos } from "../db/repos.js";

export type ApprovalStatus = "pending" | "approved" | "denied" | "expired";

export interface ApprovalSummary {
  approval_id: string;
  /** "pending" past its expiry is reported as "expired" even before the sweeper persists it. */
  status: ApprovalStatus;
  expires_at: string;
  /** Present once the approval was approved: what happened when Purser executed the stored call. */
  result?: { executed: boolean; payout_batch_id?: string; ledger_status?: string; error?: string };
}

export const effectiveStatus = (a: ApprovalRow, nowMs: number): ApprovalStatus => (a.status === "pending" && a.expires_at <= nowMs ? "expired" : a.status);

/** Status plus, for approved calls, a short summary of the execution (no raw upstream payloads). */
export function approvalSummary(repos: Repos, a: ApprovalRow, nowMs = Date.now()): ApprovalSummary {
  const out: ApprovalSummary = { approval_id: a.id, status: effectiveStatus(a, nowMs), expires_at: new Date(a.expires_at).toISOString() };
  if (a.status !== "approved") return out;
  const attempt = repos.attempts.get(a.attempt_id);
  if (!attempt) return out;
  const ledger = attempt.ledger_id ? repos.ledger.get(attempt.ledger_id) : undefined;
  const ref = ledger ? (JSON.parse(ledger.paypal_ref_json) as Record<string, unknown>) : {};
  const failed = attempt.decision_stage === "execute" || ledger?.status === "failed" || ledger?.status === "unknown";
  let error: string | undefined;
  if (failed) {
    try {
      const r = JSON.parse(attempt.upstream_result_json ?? "null") as { error?: { code?: string; status?: number; error?: string } } | null;
      error = r?.error?.code ?? r?.error?.error ?? (r?.error?.status ? `HTTP ${r.error.status}` : "execution failed");
    } catch {
      error = "execution failed";
    }
  }
  out.result = {
    executed: Boolean(ledger) && !failed,
    ...(typeof ref.payout_batch_id === "string" ? { payout_batch_id: ref.payout_batch_id } : {}),
    ...(ledger ? { ledger_status: ledger.status } : {}),
    ...(error ? { error } : {}),
  };
  return out;
}
