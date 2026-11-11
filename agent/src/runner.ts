import { randomUUID } from "node:crypto";
import type { ToolCallingClient } from "@purser/shared/llm";
import { AdminApi, type AttemptView } from "./api.js";
import { runLiveAgent, summarizeArgs, describeResult, type LiveAgentResult } from "./live.js";
import { McpSession } from "./mcp.js";
import { ALL_ORDER, SCENARIOS, type LogEntry, type Mode, type ScenarioContext, type ScenarioEnv, type ScenarioId } from "./scenarios/index.js";

export interface ScenarioLogEntry extends LogEntry {
  run_id: string;
  scenario: ScenarioId;
  mode: Mode;
  step: number;
}

export interface RunnerOptions {
  baseUrl: string;
  agentKey: string;
  adminToken: string;
  env: ScenarioEnv;
  /** Required for mode "live". */
  llm?: ToolCallingClient | null;
  log?: (e: ScenarioLogEntry) => void;
  /** Reset demo state before the scenario (wipes attempts, unfreezes, restores the seeded policy). Default true. */
  reset?: boolean;
  /** Cap on model turns for the live agent. Default 8. */
  maxSteps?: number;
  /** Supply the run id up front (the server returns it to the caller before the run finishes). */
  runId?: string;
}

export interface CallRecord {
  tool: string;
  args: Record<string, unknown>;
  outcome: string;
  message: string;
  attempt_id: string | null;
  approval_id: string | null;
}

export interface ScenarioResult {
  run_id: string;
  scenario: ScenarioId;
  title: string;
  mode: Mode;
  started_at: string;
  duration_ms: number;
  calls: CallRecord[];
  /** The attempts this run created, oldest first, exactly as the dashboard shows them. */
  attempts: AttemptView[];
  pending_approvals: string[];
  agent_frozen: boolean;
  freeze_reason: string | null;
  /** Live mode only. */
  live?: LiveAgentResult;
  error?: string;
}

function outcomeOf(json: Record<string, unknown> | null, isError: boolean): string {
  if (json && typeof json.purser === "string") return json.purser;
  return isError ? "error" : "executed";
}

export async function runScenario(id: ScenarioId, mode: Mode, opts: RunnerOptions): Promise<ScenarioResult> {
  const def = SCENARIOS[id];
  const runId = opts.runId ?? `run_${randomUUID().replace(/-/g, "").slice(0, 10)}`;
  const api = new AdminApi(opts.baseUrl, opts.adminToken);
  let step = 0;
  const log = (e: LogEntry) => opts.log?.({ ...e, run_id: runId, scenario: id, mode, step: ++step });

  if (mode === "live" && !opts.llm) throw new Error("Live mode needs a tool-calling LLM (set LLM_PROVIDER=openai_compat with LLM_BASE_URL, LLM_API_KEY and LLM_MODEL)");

  log({ kind: "start", message: `Scenario ${id}: ${def.title} (${mode} mode)`, data: { summary: def.summary } });
  if (opts.reset ?? true) {
    const r = await api.reset();
    log({ kind: "info", message: `Demo state reset (${r.attempts_cleared} earlier attempts cleared, agents unfrozen, seeded policy restored)` });
  } else {
    const agent = (await api.agents()).agents.find((a) => a.id === opts.env.agentId);
    if (agent?.effective_status === "frozen") {
      await api.unfreeze(opts.env.agentId);
      log({ kind: "info", message: "Agent was frozen; unfroze it" });
    }
  }

  const startedMs = Date.now();
  const ctx: ScenarioContext = { env: opts.env, api, log, mode, vars: {} };
  const calls: CallRecord[] = [];
  let live: LiveAgentResult | undefined;
  let error: string | undefined;
  let mcp: McpSession | null = null;
  let restore: (() => Promise<void>) | null = null;

  try {
    const setup = await def.setup(ctx);
    restore = setup.restore;
    ctx.vars = { ...ctx.vars, ...(setup.vars ?? {}) };
    mcp = await McpSession.connect(opts.baseUrl, opts.agentKey);
    log({ kind: "info", message: `Agent connected to the gateway (${mcp.tools.length} tools visible)` });

    if (mode === "replay") {
      for (const call of def.script(ctx)) {
        log({ kind: "tool_call", message: `${call.tool}(${summarizeArgs(call.args)})  [${call.note}]`, data: { tool: call.tool, args: call.args } });
        const r = await mcp.callTool(call.tool, call.args);
        const outcome = outcomeOf(r.json, r.isError);
        const message = describeResult(r.json, r.raw);
        calls.push({ tool: call.tool, args: call.args, outcome, message, attempt_id: typeof r.json?.attempt_id === "string" ? r.json.attempt_id : null, approval_id: typeof r.json?.approval_id === "string" ? r.json.approval_id : null });
        log({ kind: outcome === "executed" ? "tool_result" : "decision", message, data: { tool: call.tool, outcome } });
      }
    } else {
      live = await runLiveAgent({ llm: opts.llm!, mcp, brief: def.live(ctx), log, maxSteps: opts.maxSteps });
      for (const t of live.tool_calls.filter((c) => c.name !== "read_document")) {
        let json: Record<string, unknown> | null = null;
        try {
          const p = JSON.parse(t.result);
          if (p && typeof p === "object" && !Array.isArray(p)) json = p as Record<string, unknown>;
        } catch {
          // passthrough text
        }
        calls.push({ tool: t.name, args: t.args, outcome: outcomeOf(json, false), message: describeResult(json, t.result), attempt_id: typeof json?.attempt_id === "string" ? json.attempt_id : null, approval_id: typeof json?.approval_id === "string" ? json.approval_id : null });
      }
      if (live.error) error = live.error;
    }
  } catch (e) {
    error = (e as Error).message;
    log({ kind: "error", message: error });
  } finally {
    await mcp?.close();
    if (restore) {
      try {
        await restore();
      } catch (e) {
        log({ kind: "error", message: `Restoring the policy failed: ${(e as Error).message}` });
        error ??= `restore failed: ${(e as Error).message}`;
      }
    }
  }

  const attempts = (await api.attempts(300)).filter((a) => Date.parse(a.ts) >= startedMs - 2000).reverse();
  const ids = new Set(attempts.map((a) => a.id));
  const pending = (await api.approvals("pending")).filter((a) => ids.has(a.attempt_id)).map((a) => a.approval_id);
  const agent = (await api.agents()).agents.find((a) => a.id === opts.env.agentId);
  const result: ScenarioResult = {
    run_id: runId,
    scenario: id,
    title: def.title,
    mode,
    started_at: new Date(startedMs).toISOString(),
    duration_ms: Date.now() - startedMs,
    calls,
    attempts,
    pending_approvals: pending,
    agent_frozen: agent?.effective_status === "frozen",
    freeze_reason: agent?.freeze?.reason ?? null,
    ...(live ? { live } : {}),
    ...(error ? { error } : {}),
  };
  log({
    kind: "done",
    message: `Scenario ${id} finished in ${(result.duration_ms / 1000).toFixed(1)}s: ${attempts.length} attempts (${attempts.filter((a) => a.decision === "allow").length} allowed, ${attempts.filter((a) => a.decision === "escalate").length} escalated, ${attempts.filter((a) => a.decision === "deny").length} denied)${result.agent_frozen ? "; agent frozen" : ""}`,
    data: { decisions: attempts.map((a) => a.decision), frozen: result.agent_frozen, ...(error ? { error } : {}) },
  });
  return result;
}

/** Run scenarios one after another, resetting the demo state before each so rolling windows never pollute the next one. */
export async function runAll(mode: Mode, opts: RunnerOptions, ids: ScenarioId[] = ALL_ORDER): Promise<ScenarioResult[]> {
  const out: ScenarioResult[] = [];
  for (const id of ids) out.push(await runScenario(id, mode, { ...opts, reset: true }));
  return out;
}
