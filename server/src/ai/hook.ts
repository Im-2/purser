import type { Policy } from "@purser/shared";
import type { Repos } from "../db/repos.js";
import type { HookContext, PipelineHooks } from "../gateway/pipeline.js";
import { fromMinor } from "../money.js";
import { computeTrustSignals } from "../trust/signals.js";
import type { PolicySummary, RecentAttempt, Reviewer } from "./reviewer.js";

const isRefund = (tool: string) => /refund/i.test(tool);

export function summarizePolicy(p: Policy): PolicySummary {
  return {
    currency_allowed: p.currency_allowed,
    per_tx_cap: p.limits.per_tx_cap,
    daily_cap: p.limits.daily_cap,
    approval_threshold: p.approval_threshold,
    payee_mode: p.payees.mode,
    allowlist_size: p.payees.allowlist.length,
  };
}

function recentAttempts(repos: Repos, agentId: string, nowMs: number): RecentAttempt[] {
  return repos.attempts.list({ agent: agentId, limit: 8 }).map((a) => ({
    tool: a.tool,
    amount: a.amount === null ? null : fromMinor(a.amount),
    payee: a.payee_email,
    decision: a.decision,
    age_sec: Math.max(0, Math.round((nowMs - a.ts) / 1000)),
  }));
}

/** SPEC section 4 stage 4 applicability: reviewer enabled, and signals present, or amount >= min_amount, or money_out. */
export function reviewApplies(ctx: Pick<HookContext, "policy" | "toolClass" | "extracted" | "signals">): boolean {
  if (!ctx.policy.ai_review.enabled) return false;
  if (ctx.signals.length > 0 || ctx.toolClass === "money_out") return true;
  const min = Math.round(ctx.policy.ai_review.min_amount * 100);
  return ctx.extracted.amountMinor !== null && ctx.extracted.amountMinor >= min;
}

/** Wire stage 3 (deterministic payee trust) and stage 4 (AI reviewer) into runPipeline(). */
export function createPipelineHooks(deps: { repos: Repos; reviewer: Reviewer }): PipelineHooks {
  const { repos, reviewer } = deps;
  return {
    trust(ctx) {
      // Trust signals apply to payments to a payee. Refunds go back to the original payer, so they are skipped.
      if (ctx.toolClass !== "money_out" || isRefund(ctx.tool) || !ctx.extracted.payeeEmail) return { signals: [] };
      const known = repos.payees.list().map((p) => ({ email: p.email, display_name: p.display_name }));
      const r = computeTrustSignals({ payeeEmail: ctx.extracted.payeeEmail, knownPayees: known, reason: ctx.reason, source: ctx.source, args: ctx.args, policy: ctx.policy });
      return { signals: r.signals.map((s) => ({ id: s.id, severity: s.severity, evidence: s.evidence })), decision: r.decision };
    },

    async aiReview(ctx) {
      if (!reviewApplies(ctx)) return { ai: null };
      const trustSignals = computeSignalEvidence(repos, ctx);
      const verdict = await reviewer.review({
        mandate: ctx.agent.mandate || ctx.policy.mandate,
        policy: summarizePolicy(ctx.policy),
        tool: ctx.tool,
        amount: ctx.extracted.amountMinor === null ? null : fromMinor(ctx.extracted.amountMinor),
        currency: ctx.extracted.currency,
        payeeEmail: ctx.extracted.payeeEmail,
        reason: ctx.reason,
        source: ctx.source,
        args: ctx.args,
        signals: trustSignals,
        ruleHits: ctx.ruleHits.map((h) => h.id),
        advisory: ctx.advisory,
        recent: recentAttempts(repos, ctx.agent.id, ctx.nowMs),
      });
      const ai = { ...verdict, advisory: ctx.advisory || undefined };
      // The reviewer can only tighten: "allow" proposes nothing, so the earlier decision stands.
      return { ai, decision: verdict.verdict === "allow" ? undefined : verdict.verdict };
    },
  };
}

/** Signals with evidence, recomputed deterministically so the reviewer sees why each one fired. */
function computeSignalEvidence(repos: Repos, ctx: HookContext): { id: string; evidence?: string }[] {
  if (ctx.toolClass !== "money_out" || isRefund(ctx.tool) || !ctx.extracted.payeeEmail) return ctx.signals.map((id) => ({ id }));
  const known = repos.payees.list().map((p) => ({ email: p.email, display_name: p.display_name }));
  return computeTrustSignals({ payeeEmail: ctx.extracted.payeeEmail, knownPayees: known, reason: ctx.reason, source: ctx.source, args: ctx.args, policy: ctx.policy }).signals.map((s) => ({ id: s.id, evidence: s.evidence }));
}
