import { randomUUID } from "node:crypto";
import { runScenario, type Mode, type RunnerOptions, type ScenarioId, type ScenarioResult } from "@purser/agent";
import { supportsToolCalling, type LlmClient, type ToolCallingClient } from "@purser/shared/llm";
import type { EventBus } from "../events.js";

export interface DemoRunnerDeps {
  bus: EventBus;
  /** Loopback URL of this server (127.0.0.1 and the configured port). The agent talks to the gateway like any other client. */
  baseUrl: string;
  agentKey: string | undefined;
  adminToken: string | undefined;
  /** Scenario environment (vendor emails, look-alike, PayPal credentials for scenario C). Null disables the Attack Lab. */
  env: RunnerOptions["env"] | null;
  llm: LlmClient | null;
  /** Injected in tests. */
  run?: (id: ScenarioId, mode: Mode, opts: RunnerOptions) => Promise<ScenarioResult>;
}

export type StartOutcome = { ok: true; run_id: string; scenario: ScenarioId; mode: Mode } | { ok: false; code: "busy" | "not_configured" | "live_unavailable"; message: string };

export interface RunSummary {
  run_id: string;
  scenario: ScenarioId;
  mode: Mode;
  started_at: string;
  duration_ms: number;
  decisions: string[];
  agent_frozen: boolean;
  pending_approvals: string[];
  error?: string;
}

export interface DemoRunner {
  start(id: ScenarioId, o: { mode: Mode; reset: boolean }): StartOutcome;
  status(): { running: { run_id: string; scenario: ScenarioId; mode: Mode; started_at: string } | null; last: RunSummary | null };
}

/**
 * Runs Attack Lab scenarios as background jobs. One at a time. Progress is streamed as scenario_log events on the event bus,
 * so the dashboard sees the same log over SSE that the CLI prints.
 */
export function createDemoRunner(deps: DemoRunnerDeps): DemoRunner {
  let running: ReturnType<DemoRunner["status"]>["running"] = null;
  let last: RunSummary | null = null;
  const run = deps.run ?? runScenario;

  return {
    status: () => ({ running, last }),
    start(id, o) {
      if (!deps.agentKey || !deps.adminToken || !deps.env) {
        return { ok: false, code: "not_configured", message: "The Attack Lab needs AGENT_API_KEY, PURSER_ADMIN_TOKEN and both vendor emails in .env." };
      }
      if (running) return { ok: false, code: "busy", message: `Scenario ${running.scenario} is still running.` };
      let llm: ToolCallingClient | null = null;
      if (o.mode === "live") {
        if (!supportsToolCalling(deps.llm)) return { ok: false, code: "live_unavailable", message: "Live mode needs LLM_PROVIDER=openai_compat with LLM_BASE_URL, LLM_API_KEY and LLM_MODEL." };
        llm = deps.llm;
      }

      const runId = `run_${randomUUID().replace(/-/g, "").slice(0, 10)}`;
      const startedAt = new Date().toISOString();
      running = { run_id: runId, scenario: id, mode: o.mode, started_at: startedAt };

      void run(id, o.mode, {
        baseUrl: deps.baseUrl,
        agentKey: deps.agentKey,
        adminToken: deps.adminToken,
        env: deps.env,
        llm,
        reset: o.reset,
        runId,
        log: (e) => deps.bus.publish({ type: "scenario_log", data: { run_id: e.run_id, scenario: e.scenario, mode: e.mode, step: e.step, kind: e.kind, message: e.message, ...(e.data ? { data: e.data } : {}) } }),
      })
        .then((r) => {
          last = { run_id: r.run_id, scenario: r.scenario, mode: r.mode, started_at: r.started_at, duration_ms: r.duration_ms, decisions: r.attempts.filter((a) => a.tool_class !== "read").map((a) => a.decision), agent_frozen: r.agent_frozen, pending_approvals: r.pending_approvals, ...(r.error ? { error: r.error } : {}) };
        })
        .catch((e: Error) => {
          last = { run_id: runId, scenario: id, mode: o.mode, started_at: startedAt, duration_ms: Date.now() - Date.parse(startedAt), decisions: [], agent_frozen: false, pending_approvals: [], error: e.message };
          deps.bus.publish({ type: "scenario_log", data: { run_id: runId, scenario: id, mode: o.mode, step: 999, kind: "error", message: `Scenario failed: ${e.message}` } });
          deps.bus.publish({ type: "scenario_log", data: { run_id: runId, scenario: id, mode: o.mode, step: 1000, kind: "done", message: `Scenario ${id} stopped with an error` } });
        })
        .finally(() => {
          running = null;
        });

      return { ok: true, run_id: runId, scenario: id, mode: o.mode };
    },
  };
}
