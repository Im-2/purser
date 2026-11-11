import type { ToolClass } from "@purser/shared";
import { isGloballyFrozen } from "../control/killswitch.js";
import type { ApprovalRow, AttemptRow } from "../db/repos.js";
import { attemptRowToRecord } from "../events.js";
import { executeAllowed, type GatewayDeps, type ToolResponse } from "../gateway/pipeline.js";
import { evaluateRules } from "../policy/rules.js";
import { approvalSummary, effectiveStatus, type ApprovalSummary } from "./summary.js";

const DAY = 24 * 60 * 60 * 1000;

export type ApprovalFailure =
  | { ok: false; code: "not_found"; message: string }
  | { ok: false; code: "already_resolved"; message: string; approval: ApprovalSummary }
  | { ok: false; code: "expired"; message: string; approval: ApprovalSummary }
  | { ok: false; code: "agent_frozen"; message: string }
  | { ok: false; code: "no_policy" | "not_executable"; message: string }
  | { ok: false; code: "policy_denies"; message: string; rule_hits: string[] };

export type ApproveOutcome = { ok: true; approval: ApprovalSummary; result: unknown } | ApprovalFailure;
export type DenyOutcome = { ok: true; approval: ApprovalSummary } | ApprovalFailure;

const clock = (d: GatewayDeps) => (d.now ?? Date.now)();

function appendHit(row: AttemptRow, id: string, message: string): string {
  const hits = JSON.parse(row.rule_hits_json) as unknown[];
  hits.push({ id, severity: "deny", message });
  return JSON.stringify(hits);
}

/** Close an approval that was not approved: attempt becomes a (human or timeout) denial and clients are told. */
function closeAttempt(deps: GatewayDeps, ap: ApprovalRow, status: "denied" | "expired", decidedBy: string | null) {
  const attempt = deps.repos.attempts.get(ap.attempt_id);
  if (attempt) {
    const hit = status === "expired" ? "approval_expired" : "approval_denied";
    deps.repos.attempts.update(attempt.id, { decision: "deny", decision_stage: "approval", rule_hits_json: appendHit(attempt, hit, status === "expired" ? "Approval expired before a human decided" : "A human denied this call") });
    deps.bus.publish({ type: "attempt", data: attemptRowToRecord(deps.repos.attempts.get(attempt.id)!) });
  }
  deps.bus.publish({ type: "approval_resolved", data: { approval_id: ap.id, attempt_id: ap.attempt_id, status, decided_by: decidedBy } });
}

/** Mark every pending approval past its expiry as expired. Safe to call repeatedly. Returns how many were expired. */
export function sweepExpiredApprovals(deps: GatewayDeps): number {
  const now = clock(deps);
  let n = 0;
  for (const ap of deps.repos.approvals.list("pending")) {
    if (ap.expires_at > now) continue;
    if (deps.repos.approvals.resolve(ap.id, "expired", null)) {
      closeAttempt(deps, ap, "expired", null);
      n++;
    }
  }
  return n;
}

/** Start the background sweeper. Returns a stop function. */
export function startApprovalSweeper(deps: GatewayDeps, intervalMs = 30_000): () => void {
  const timer = setInterval(() => {
    try {
      sweepExpiredApprovals(deps);
    } catch {
      // never let the sweeper crash the process
    }
  }, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}

/**
 * Approve an escalated call and execute the STORED call through the same path as an allowed call.
 * Exactly-once: the pending -> approved claim is a single atomic UPDATE done before any await, so concurrent or repeated
 * approvals lose the claim and never execute; the payout also carries an idempotency key derived from the attempt id.
 */
export async function approveApproval(deps: GatewayDeps, approvalId: string, decidedBy: string): Promise<ApproveOutcome> {
  const { repos } = deps;
  const now = clock(deps);
  const ap = repos.approvals.get(approvalId);
  if (!ap) return { ok: false, code: "not_found", message: "Approval not found." };

  const summary = () => approvalSummary(repos, repos.approvals.get(approvalId)!, now);
  if (ap.status !== "pending") return { ok: false, code: "already_resolved", message: `This approval is already ${ap.status}.`, approval: summary() };
  if (effectiveStatus(ap, now) === "expired") {
    if (repos.approvals.resolve(ap.id, "expired", null)) closeAttempt(deps, ap, "expired", null);
    return { ok: false, code: "expired", message: "This approval has expired and can no longer be approved.", approval: summary() };
  }

  const attempt = repos.attempts.get(ap.attempt_id);
  if (!attempt) return { ok: false, code: "not_executable", message: "The stored call no longer exists." };
  const agent = repos.agents.get(attempt.agent_id);
  if (!agent) return { ok: false, code: "not_executable", message: "The agent no longer exists." };

  // Kill switch again, right before executing.
  if (agent.status === "frozen" || isGloballyFrozen(repos)) return { ok: false, code: "agent_frozen", message: "The agent is frozen. Unfreeze it before approving." };

  // The stored arguments are sanitized (secrets redacted, oversized payloads dropped). Refuse rather than guess.
  let forward: Record<string, unknown>;
  try {
    forward = JSON.parse(attempt.args_json) as Record<string, unknown>;
  } catch {
    return { ok: false, code: "not_executable", message: "The stored arguments are unreadable." };
  }
  if (forward === null || typeof forward !== "object" || "_truncated" in forward) return { ok: false, code: "not_executable", message: "The stored call was too large to store; it cannot be replayed." };

  // Human approval overrides ESCALATE-level rules, never DENY-level ones: re-check the hard rules as of now.
  const policy = repos.policies.getActive(attempt.agent_id);
  if (!policy) return { ok: false, code: "no_policy", message: "The agent has no active policy." };
  const rules = evaluateRules({
    call: { toolClass: attempt.tool_class, tool: attempt.tool, amountMinor: attempt.amount, currency: attempt.currency, payeeEmail: attempt.payee_email },
    policy,
    history: repos.attempts.history(attempt.agent_id, now - 30 * DAY, attempt.id),
    nowMs: now,
  });
  if (rules.decision === "deny") {
    return { ok: false, code: "policy_denies", message: "Current policy now denies this call (for example a cap was reached). It cannot be approved.", rule_hits: rules.hits.filter((h) => h.severity === "deny").map((h) => h.id) };
  }

  // Claim. Everything above is synchronous, so two concurrent approvals cannot both reach this line as pending.
  if (!repos.approvals.resolve(ap.id, "approved", decidedBy)) return { ok: false, code: "already_resolved", message: "This approval was just resolved.", approval: summary() };

  repos.attempts.update(attempt.id, { decision: "allow", decision_stage: "approval" }); // now counts as spend
  const row = repos.attempts.get(attempt.id)!;
  const response: ToolResponse = await executeAllowed(deps, agent, row, attempt.tool, attempt.tool_class as ToolClass, forward, { amountMinor: attempt.amount, currency: attempt.currency, payeeEmail: attempt.payee_email });
  deps.bus.publish({ type: "approval_resolved", data: { approval_id: ap.id, attempt_id: ap.attempt_id, status: "approved", decided_by: decidedBy } });

  return { ok: true, approval: summary(), result: parseResponse(response) };
}

/** Deny an escalated call. The attempt is closed as a denial. */
export function denyApproval(deps: GatewayDeps, approvalId: string, decidedBy: string): DenyOutcome {
  const { repos } = deps;
  const now = clock(deps);
  const ap = repos.approvals.get(approvalId);
  if (!ap) return { ok: false, code: "not_found", message: "Approval not found." };
  if (ap.status !== "pending") return { ok: false, code: "already_resolved", message: `This approval is already ${ap.status}.`, approval: approvalSummary(repos, ap, now) };
  if (effectiveStatus(ap, now) === "expired") {
    if (repos.approvals.resolve(ap.id, "expired", null)) closeAttempt(deps, ap, "expired", null);
    return { ok: false, code: "expired", message: "This approval has already expired.", approval: approvalSummary(repos, repos.approvals.get(ap.id)!, now) };
  }
  if (!repos.approvals.resolve(ap.id, "denied", decidedBy)) return { ok: false, code: "already_resolved", message: "This approval was just resolved.", approval: approvalSummary(repos, repos.approvals.get(ap.id)!, now) };
  closeAttempt(deps, ap, "denied", decidedBy);
  return { ok: true, approval: approvalSummary(repos, repos.approvals.get(ap.id)!, now) };
}

function parseResponse(r: ToolResponse): unknown {
  const first = r.content[0] as { type?: string; text?: string } | undefined;
  if (first?.type === "text" && typeof first.text === "string") {
    try {
      return JSON.parse(first.text);
    } catch {
      return { text: first.text.slice(0, 500), isError: Boolean(r.isError) };
    }
  }
  return { isError: Boolean(r.isError) };
}
