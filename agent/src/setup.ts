import { createLlmClient, supportsToolCalling, type ToolCallingClient } from "@purser/shared/llm";
import { makeLookalike } from "@purser/shared/lookalike";
import type { AgentEnv } from "./env.js";
import type { RunnerOptions, ScenarioLogEntry, ScenarioResult } from "./runner.js";

export const SEEDED_AGENT_ID = "agent_ops_01";

/** Turn the environment into runner options. Throws a plain message listing anything missing (never the values). */
export function runnerOptions(env: AgentEnv, o: { live?: boolean; log?: (e: ScenarioLogEntry) => void; baseUrl?: string; maxSteps?: number } = {}): RunnerOptions {
  const missing = [
    ["AGENT_API_KEY", env.agentKey],
    ["PURSER_ADMIN_TOKEN", env.adminToken],
    ["VENDOR_ACME_EMAIL", env.acmeEmail],
    ["VENDOR_NORTHWIND_EMAIL", env.northwindEmail],
  ]
    .filter(([, v]) => !v)
    .map(([k]) => k);
  if (missing.length) throw new Error(`Missing in .env: ${missing.join(", ")}`);

  let llm: ToolCallingClient | null = null;
  if (o.live) {
    const client = createLlmClient(env.llm);
    if (!supportsToolCalling(client)) throw new Error("Live mode needs LLM_PROVIDER=openai_compat with LLM_BASE_URL, LLM_API_KEY and LLM_MODEL (the agent uses OpenAI-style tool calling)");
    llm = client;
  }
  return {
    baseUrl: o.baseUrl ?? env.baseUrl,
    agentKey: env.agentKey!,
    adminToken: env.adminToken!,
    llm,
    log: o.log,
    maxSteps: o.maxSteps,
    env: {
      agentId: SEEDED_AGENT_ID,
      acmeEmail: env.acmeEmail!,
      northwindEmail: env.northwindEmail!,
      lookalike: makeLookalike(env.acmeEmail!),
      ...(env.paypalClientId && env.paypalClientSecret ? { paypal: { clientId: env.paypalClientId, clientSecret: env.paypalClientSecret } } : {}),
    },
  };
}

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
export const c = {
  green: (s: string) => (useColor ? `\x1b[32m${s}\x1b[0m` : s),
  red: (s: string) => (useColor ? `\x1b[31m${s}\x1b[0m` : s),
  yellow: (s: string) => (useColor ? `\x1b[33m${s}\x1b[0m` : s),
  dim: (s: string) => (useColor ? `\x1b[2m${s}\x1b[0m` : s),
  bold: (s: string) => (useColor ? `\x1b[1m${s}\x1b[0m` : s),
};

const DECISION_COLOR = { allow: c.green, escalate: c.yellow, deny: c.red } as const;

/** Print what Purser decided for each attempt: the same rows the dashboard shows. */
export function printResult(r: ScenarioResult): void {
  console.log(`\n${c.bold(`Scenario ${r.scenario}: ${r.title}`)} ${c.dim(`[${r.mode}] ${(r.duration_ms / 1000).toFixed(1)}s`)}`);
  for (const a of r.attempts.filter((x) => x.tool_class !== "read")) {
    const color = DECISION_COLOR[a.decision];
    const hits = a.rule_hits_detail.map((h) => h.id).join(",");
    const sigs = a.signals_detail.map((s) => (typeof s === "string" ? s : s.id)).filter((s) => s !== "first_time_payee").join(",");
    console.log(`  ${color(a.decision.toUpperCase().padEnd(8))} ${a.tool} ${a.amount_display ?? "?"} ${a.currency ?? ""} -> ${a.payee_email ?? "-"}  ${c.dim(`stage=${a.decision_stage}${hits ? ` rules=[${hits}]` : ""}${sigs ? ` signals=[${sigs}]` : ""}`)}`);
    if (a.ai) console.log(`           ${c.dim(`AI ${a.ai.verdict} risk ${a.ai.risk}${a.ai.cached ? " (cached)" : ""}${a.ai.advisory ? " advisory" : ""}${a.ai.error ? ` ERROR ${a.ai.error}` : ""}: ${a.ai.rationale.slice(0, 140)}`)}`);
  }
  if (r.agent_frozen) console.log(`  ${c.red("AGENT FROZEN")} ${c.dim(`(${r.freeze_reason ?? "?"})`)}`);
  if (r.pending_approvals.length) console.log(`  ${c.yellow("Awaiting human approval:")} ${r.pending_approvals.join(", ")}`);
  if (r.live?.final_text) console.log(`  ${c.dim("Agent's closing message:")} ${r.live.final_text.replace(/\s+/g, " ").slice(0, 400)}`);
  if (r.error) console.log(`  ${c.red("Error:")} ${r.error}`);
}

export function consoleLog(e: ScenarioLogEntry): void {
  const tag = { start: c.bold("▶"), info: c.dim("·"), agent: c.yellow("agent"), tool_call: c.dim("→"), tool_result: c.dim("←"), decision: c.bold("⚑"), error: c.red("✖"), done: c.bold("■") }[e.kind];
  console.log(`  ${tag} ${e.message}`);
}
