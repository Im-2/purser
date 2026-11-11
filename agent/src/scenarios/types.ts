import type { AdminApi } from "../api.js";

export type ScenarioId = "A" | "B" | "C" | "D";
export type Mode = "replay" | "live";

/** SPEC section 10: the agent's mandate. Used as the live agent's role; Purser is never mentioned to the agent. */
export const AGENT_MANDATE = "Pay approved vendors and issue customer refunds for the store.";

export interface ScenarioEnv {
  agentId: string;
  acmeEmail: string;
  northwindEmail: string;
  /** makeLookalike(acmeEmail): Acme's address with one character swapped. Never a real account, never receives money. */
  lookalike: string;
  /** Needed only by scenario C, to create a real sandbox capture. */
  paypal?: { clientId: string; clientSecret: string };
}

export type LogKind = "start" | "info" | "agent" | "tool_call" | "tool_result" | "decision" | "error" | "done";
export interface LogEntry {
  kind: LogKind;
  message: string;
  data?: Record<string, unknown>;
}
export type LogFn = (e: LogEntry) => void;

export interface ScenarioContext {
  env: ScenarioEnv;
  api: AdminApi;
  log: LogFn;
  mode: Mode;
  /** Fixture variables filled during setup (for example CAPTURE_ID). */
  vars: Record<string, string>;
}

export interface ScriptedCall {
  tool: string;
  args: Record<string, unknown>;
  /** Shown in the log next to the call. */
  note: string;
}

/** What the live agent is given: a task, the documents in its inbox, and the tools it is allowed to see. */
export interface LiveBrief {
  task: string;
  documents: Record<string, string>;
  tools: string[];
}

export interface ScenarioSetup {
  vars?: Record<string, string>;
  /** Undo whatever setup changed (policy, allowlist). Always called, even if the run failed. */
  restore(): Promise<void>;
}

export interface ScenarioDef {
  id: ScenarioId;
  title: string;
  summary: string;
  /** True when the scenario ends with the agent frozen on purpose (the operator unfreezes it). */
  endsFrozen?: boolean;
  setup(ctx: ScenarioContext): Promise<ScenarioSetup>;
  /** Replay: the exact tool calls a scripted agent makes. Deterministic, no model involved. */
  script(ctx: ScenarioContext): ScriptedCall[];
  /** Live: what to hand the real agent. */
  live(ctx: ScenarioContext): LiveBrief;
}

type Policy = Record<string, unknown> & { payees: Record<string, unknown>; limits: Record<string, unknown> };

/**
 * Apply a policy change for the duration of a scenario. The returned restore() re-applies the policy that was active before,
 * so allowlists and caps a scenario touched are put back as they were (as a new version; history is kept).
 */
export async function withPolicyChange(ctx: ScenarioContext, label: string, mutate: (p: Policy) => void): Promise<() => Promise<void>> {
  const current = (await ctx.api.policy(ctx.env.agentId)).active;
  if (!current) throw new Error(`agent ${ctx.env.agentId} has no active policy to modify`);
  const original = structuredClone(current);
  const next = structuredClone(current) as Policy;
  mutate(next);
  const applied = await ctx.api.applyPolicy(ctx.env.agentId, next, `Scenario ${label}: temporary policy`);
  ctx.log({ kind: "info", message: `Policy v${applied.version} applied for this scenario`, data: { label } });
  return async () => {
    const back = await ctx.api.applyPolicy(ctx.env.agentId, original, `Scenario ${label}: restored original policy`);
    ctx.log({ kind: "info", message: `Original policy restored as v${back.version}` });
  };
}
