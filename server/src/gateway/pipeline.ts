import type { AiVerdict, Decision, DecisionStage, Policy, ToolClass } from "@purser/shared";
import type { AgentRow, AttemptRow, Repos } from "../db/repos.js";
import { attemptRowToRecord, type EventBus } from "../events.js";
import { fromMinor } from "../money.js";
import { PayPalError, createPayout, getCapture, payoutIdsForAttempt, type PayPalClient, type UpstreamClient, type UpstreamResult } from "../paypal/index.js";
import { classifyTool, type ClassifierConfig } from "../policy/classify.js";
import { extractCall, type Extracted } from "../policy/extract.js";
import { evaluateRules, type RuleHit } from "../policy/rules.js";

export const NATIVE_TOOLS = ["purser_payout", "purser_check_approval", "purser_status"] as const;
export const GLOBAL_FREEZE_KEY = "global_freeze";
const DAY = 24 * 60 * 60 * 1000;
const REASON_SOURCE_MAX = 1000;

/** A trust signal as stored on the attempt: a bare id, or id plus severity and the evidence behind it. */
export type SignalItem = string | { id: string; severity?: string; evidence?: string };
const signalId = (s: SignalItem) => (typeof s === "string" ? s : s.id);

export interface PipelineHooks {
  /** Stage 3: payee trust signals. May only tighten (escalate/deny); never loosen. */
  trust?(ctx: HookContext): Promise<{ signals: SignalItem[]; decision?: "escalate" | "deny" }> | { signals: SignalItem[]; decision?: "escalate" | "deny" };
  /**
   * Stage 4: AI reviewer. On an allowed call it may tighten (escalate/deny) and failure must escalate.
   * On an already-escalated call it is advisory: it records a rationale for the human approver and can never loosen.
   */
  aiReview?(ctx: HookContext): Promise<{ ai: AiVerdict | null; decision?: "escalate" | "deny" }> | { ai: AiVerdict | null; decision?: "escalate" | "deny" };
}

export interface HookContext {
  agent: AgentRow;
  tool: string;
  toolClass: ToolClass;
  args: Record<string, unknown>;
  extracted: Extracted;
  reason: string | null;
  source: string | null;
  signals: string[];
  ruleHits: RuleHit[];
  policy: Policy;
  nowMs: number;
  /** True when the call was already escalated before the reviewer ran. */
  advisory: boolean;
}

export interface GatewayDeps {
  repos: Repos;
  upstream: UpstreamClient;
  /** Null disables payouts and capture lookups (fail closed). */
  paypal: PayPalClient | null;
  bus: EventBus;
  classifier?: ClassifierConfig;
  hooks?: PipelineHooks;
  /** Upstream tools classified "unknown" stay hidden from tools/list unless named here. Calls are still denied. */
  exposeUnknown?: string[];
  now?: () => number;
}

export interface ToolResponse {
  content: { type: "text"; text: string; [k: string]: unknown }[] | { type: string; [k: string]: unknown }[];
  isError?: boolean;
  [k: string]: unknown;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const text = (o: unknown): ToolResponse => ({ content: [{ type: "text", text: typeof o === "string" ? o : JSON.stringify(o) }] });

/** Strictest wins: deny > escalate > allow. A hook can only move a decision toward deny. */
export function tighten(current: Decision, proposed: Decision | undefined): Decision {
  const rank = { allow: 0, escalate: 1, deny: 2 } as const;
  return proposed && rank[proposed] > rank[current] ? proposed : current;
}

/** Remove the Purser-only fields before anything is forwarded upstream. */
export function splitMeta(args: Record<string, unknown>): { forward: Record<string, unknown>; reason: string | null; source: string | null } {
  const { reason, source, ...forward } = args;
  const clean = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim().slice(0, REASON_SOURCE_MAX) : null);
  return { forward, reason: clean(reason), source: clean(source) };
}

const SECRET_KEY = /token|secret|password|authorization|api[_-]?key|credential/i;

/** Copy of the args that is safe to store: secret-looking keys redacted, oversized payloads replaced. */
export function sanitizeArgs(args: unknown, maxBytes = 20_000): unknown {
  const walk = (v: unknown, depth: number): unknown => {
    if (depth > 8) return "[depth limit]";
    if (Array.isArray(v)) return v.slice(0, 200).map((x) => walk(x, depth + 1));
    if (isObj(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, SECRET_KEY.test(k) ? "[redacted]" : walk(x, depth + 1)]));
    return v;
  };
  const clean = walk(args, 0);
  const s = JSON.stringify(clean) ?? "null";
  return s.length > maxBytes ? { _truncated: true, _bytes: s.length } : clean;
}

function truncateResult(r: unknown, max = 50_000): unknown {
  const s = JSON.stringify(r) ?? "null";
  return s.length > max ? { _truncated: true, _bytes: s.length, head: s.slice(0, 2000) } : r;
}

const deniedShape = (attemptId: string, message: string) => ({ purser: "denied", attempt_id: attemptId, message, retry_allowed: false });

/**
 * The decision pipeline (SPEC section 4) as one function.
 *   0 auth is done by the transport; kill switch here
 *   1 classify + extract
 *   2 hard rules
 *   3 payee trust (hook)         4 AI reviewer (hook)
 *   5 execute + ledger           6 escalate -> approval row
 * Every call writes exactly one attempt row, whatever the outcome.
 */
export async function runPipeline(deps: GatewayDeps, agentId: string, tool: string, rawArgs: unknown): Promise<ToolResponse> {
  const { repos, bus } = deps;
  const clock = deps.now ?? Date.now;
  const t0 = performance.now();
  const now = clock();

  const args = isObj(rawArgs) ? rawArgs : {};
  const { forward, reason, source } = splitMeta(args);
  const safeArgs = sanitizeArgs(forward);
  const toolClass = classifyTool(tool, deps.classifier);
  let extracted = extractCall(tool, forward);

  const finish = (): number => Math.round(performance.now() - t0);
  const record = (decision: Decision, stage: DecisionStage, hits: unknown[], signals: SignalItem[], ai: AiVerdict | null): AttemptRow => {
    const row = repos.attempts.create({
      agent_id: agentId,
      tool,
      tool_class: toolClass,
      args: safeArgs,
      amount: extracted.amountMinor,
      currency: extracted.currency,
      payee_email: extracted.payeeEmail,
      reason,
      source,
      decision,
      decision_stage: stage,
      rule_hits: hits,
      signals,
      ai: ai ?? undefined,
      latency_ms: finish(),
      ts: now,
    });
    bus.publish({ type: "attempt", data: attemptRowToRecord(row) });
    return row;
  };
  const deny = (stage: DecisionStage, hits: unknown[], message: string, signals: SignalItem[] = [], ai: AiVerdict | null = null): ToolResponse => {
    const row = record("deny", stage, hits, signals, ai);
    return text(deniedShape(row.id, message));
  };

  // Stage 0: kill switch (applies to every tool, reads included). The agent row is re-read so a freeze is instant.
  const agent = repos.agents.get(agentId);
  if (!agent) return deny("auth", [{ id: "unknown_agent" }], "This request was blocked.");
  if (repos.kv.get(GLOBAL_FREEZE_KEY) === "1" || agent.status === "frozen") {
    return deny("killswitch", [{ id: repos.kv.get(GLOBAL_FREEZE_KEY) === "1" ? "global_freeze" : "agent_frozen" }], "This agent is suspended.");
  }

  // Stage 1: classify. Unknown tools are denied (fail closed).
  if (toolClass === "unknown") {
    return deny("classify", [{ id: "unknown_tool", severity: "deny", message: `Tool "${tool}" is not classified`, detail: { tool } }], "This request was blocked by spending policy.");
  }

  // A refund without an amount means "refund the full capture": resolve the real amount, or fail closed (rules escalate).
  if (tool === "create_refund" && extracted.amountMinor === null && typeof forward.capture_id === "string" && deps.paypal) {
    try {
      const cap = await getCapture(deps.paypal, forward.capture_id);
      if (cap.amountMinor !== null) extracted = { ...extracted, amountMinor: cap.amountMinor, currency: extracted.currency ?? cap.currency };
    } catch {
      // lookup failed: amount stays unknown and stage 2 escalates
    }
  }

  // Stage 2: hard rules from the active policy.
  const policy = repos.policies.getActive(agentId);
  if (!policy) return deny("rules", [{ id: "no_active_policy", severity: "deny", message: "Agent has no active policy" }], "This request was blocked by spending policy.");
  const history = repos.attempts.history(agentId, now - 30 * DAY);
  const rules = evaluateRules({
    call: { toolClass, tool, amountMinor: extracted.amountMinor, currency: extracted.currency, payeeEmail: extracted.payeeEmail },
    policy,
    history,
    nowMs: now,
  });
  let decision: Decision = rules.decision;
  let stage: DecisionStage = "rules";
  let signals: SignalItem[] = [];
  let ai: AiVerdict | null = null;

  if (decision === "deny") return deny("rules", rules.hits, rules.agentMessage);

  const hookCtx = (): HookContext => ({ agent, tool, toolClass, args: forward, extracted, reason, source, signals: signals.map(signalId), ruleHits: rules.hits, policy, nowMs: now, advisory: decision === "escalate" });

  // Stage 3: payee trust (HOOK, prompt 5). Can only tighten.
  if (deps.hooks?.trust) {
    try {
      const t = await deps.hooks.trust(hookCtx());
      signals = [...signals, ...t.signals];
      const next = tighten(decision, t.decision);
      if (next !== decision) stage = "trust";
      decision = next;
    } catch {
      decision = tighten(decision, "escalate"); // fail closed
      stage = "trust";
    }
  }
  if (decision === "deny") return deny(stage, rules.hits, "This request was blocked by spending policy.", signals);

  // Stage 4: AI reviewer. Can only tighten; failure escalates. On an already-escalated call it is advisory
  // (rationale for the human approver) and its verdict never changes the decision.
  if (deps.hooks?.aiReview) {
    const advisory = decision === "escalate";
    try {
      const r = await deps.hooks.aiReview(hookCtx());
      ai = r.ai;
      if (!advisory) {
        const next = tighten(decision, r.decision);
        if (next !== decision) stage = "ai";
        decision = next;
      }
    } catch {
      if (!advisory) {
        decision = tighten(decision, "escalate"); // fail closed
        stage = "ai";
      }
    }
  }
  if ((decision as Decision) === "deny") return deny(stage, rules.hits, "This request was blocked by spending policy.", signals, ai); // set by a non-advisory AI deny

  // Stage 6: escalate -> approval row (HOOK: notifications and execute-on-approve arrive in prompt 6).
  if (decision === "escalate") {
    const row = record("escalate", stage, rules.hits, signals, ai);
    const approval = repos.approvals.create({ attempt_id: row.id, ttlSec: policy.approval_ttl_sec, channel: "web" });
    bus.publish({ type: "approval_created", data: { approval_id: approval.id, attempt_id: row.id, expires_at: new Date(approval.expires_at).toISOString() } });
    return text({
      purser: "pending_approval",
      attempt_id: row.id,
      approval_id: approval.id,
      message: "This request needs human approval before it can proceed.",
      retry_allowed: false,
    });
  }

  // Stage 5: allowed -> execute and write the ledger.
  const row = record("allow", stage, rules.hits, signals, ai);
  return executeAllowed(deps, agent, row, tool, toolClass, forward, extracted, finish);
}

/** Execute an allowed call. Also used when a human approves an escalated attempt (prompt 6). */
export async function executeAllowed(
  deps: GatewayDeps,
  agent: AgentRow,
  row: AttemptRow,
  tool: string,
  toolClass: ToolClass,
  forward: Record<string, unknown>,
  extracted: Extracted,
  finish: () => number = () => 0,
): Promise<ToolResponse> {
  const { repos, bus } = deps;
  const settle = (patch: Parameters<Repos["attempts"]["update"]>[1]) => {
    repos.attempts.update(row.id, { ...patch, latency_ms: finish() });
    bus.publish({ type: "attempt", data: attemptRowToRecord(repos.attempts.get(row.id)!) });
  };

  try {
    // Native read tools
    if (tool === "purser_status") {
      const pending = repos.approvals.list("pending").filter((a) => repos.attempts.get(a.attempt_id)?.agent_id === agent.id).length;
      const out = { purser: "status", agent: agent.name, status: repos.agents.get(agent.id)?.status ?? "unknown", global_freeze: repos.kv.get(GLOBAL_FREEZE_KEY) === "1", pending_approvals: pending };
      settle({ upstream_result_json: JSON.stringify(out) });
      return text(out);
    }
    if (tool === "purser_check_approval") {
      const id = typeof forward.approval_id === "string" ? forward.approval_id : "";
      const ap = id ? repos.approvals.get(id) : undefined;
      const mine = ap && repos.attempts.get(ap.attempt_id)?.agent_id === agent.id;
      const out = mine ? { purser: "approval", approval_id: ap.id, status: ap.status } : { purser: "approval", approval_id: id, status: "not_found" };
      settle({ upstream_result_json: JSON.stringify(out) });
      return text(out);
    }

    // Native payout through the PayPal adapter, idempotent per attempt
    if (tool === "purser_payout") {
      if (!deps.paypal) throw new Error("PayPal client is not configured");
      if (extracted.amountMinor === null || !extracted.currency || !extracted.payeeEmail) throw new Error("payout is missing amount, currency or payee");
      const ids = payoutIdsForAttempt(row.id);
      const note = typeof forward.note === "string" ? forward.note.slice(0, 200) : "Payment";
      const created = await createPayout(deps.paypal, { receiverEmail: extracted.payeeEmail, amountMinor: extracted.amountMinor, currency: extracted.currency, note, ...ids });
      const batchId = created.batch_header.payout_batch_id;
      const ledger = repos.ledger.create({
        attempt_id: row.id,
        paypal_ref: { payout_batch_id: batchId, sender_batch_id: ids.senderBatchId, sender_item_id: ids.senderItemId, batch_status: created.batch_header.batch_status },
        amount: extracted.amountMinor,
        currency: extracted.currency,
        status: created.batch_header.batch_status,
      });
      settle({ upstream_result_json: JSON.stringify(truncateResult({ payout_batch_id: batchId, batch_status: created.batch_header.batch_status })) });
      return text({
        purser: "executed",
        attempt_id: row.id,
        ledger_id: ledger.id,
        payout_batch_id: batchId,
        status: created.batch_header.batch_status,
        amount: `${fromMinor(extracted.amountMinor)} ${extracted.currency}`,
        recipient: extracted.payeeEmail,
      });
    }

    // Everything else is a proxied upstream tool (reason/source already stripped)
    const result: UpstreamResult = await deps.upstream.callTool(tool, forward);
    const failed = Boolean(result.isError);
    if (toolClass !== "read") {
      repos.ledger.create({
        attempt_id: row.id,
        paypal_ref: { tool, result: truncateResult(result.structuredContent ?? result.content, 8_000) },
        amount: extracted.amountMinor,
        currency: extracted.currency,
        status: failed ? "failed" : "executed",
      });
    }
    settle({ upstream_result_json: JSON.stringify(truncateResult({ isError: failed, content: result.content })), ...(failed ? { decision_stage: "execute" } : {}) });
    return result as ToolResponse;
  } catch (err) {
    // Execution failed after an allow. A clear PayPal rejection moved no money; anything else is ambiguous.
    const ambiguous = !(err instanceof PayPalError);
    const detail = err instanceof PayPalError ? { status: err.status, code: err.code, debug_id: err.debugId } : { error: (err as Error).message };
    if (toolClass !== "read") {
      repos.ledger.create({ attempt_id: row.id, paypal_ref: { tool, error: detail }, amount: extracted.amountMinor, currency: extracted.currency, status: ambiguous ? "unknown" : "failed" });
    }
    settle({ decision_stage: "execute", upstream_result_json: JSON.stringify({ error: detail }) });
    return { ...text({ purser: "error", attempt_id: row.id, message: "The request could not be completed.", retry_allowed: false }), isError: true };
  }
}
