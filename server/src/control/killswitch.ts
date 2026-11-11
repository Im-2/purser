import type { Repos } from "../db/repos.js";
import type { EventBus } from "../events.js";

/** Persisted kill switch: per-agent status in SQLite plus a global flag in kv. Checked first in the pipeline (stage 0). */
export const GLOBAL_FREEZE_KEY = "global_freeze";
const freezeKey = (agentId: string) => `freeze:${agentId}`;

export interface FreezeInfo {
  reason: "admin" | "freeze_all" | "circuit_breaker";
  at: string;
  /** Extra context for the dashboard, for example { denies, max_denies, window_sec } when the breaker trips. */
  detail?: Record<string, unknown>;
}

export interface ControlDeps {
  repos: Repos;
  bus: EventBus;
}

export function isGloballyFrozen(repos: Repos): boolean {
  return repos.kv.get(GLOBAL_FREEZE_KEY) === "1";
}

export function getFreezeInfo(repos: Repos, agentId: string): FreezeInfo | null {
  const raw = repos.kv.get(freezeKey(agentId));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as FreezeInfo;
  } catch {
    return null;
  }
}

/** Freeze one agent. Returns false if the agent does not exist. */
export function freezeAgent(deps: ControlDeps, agentId: string, info: Omit<FreezeInfo, "at">, nowMs = Date.now()): boolean {
  if (!deps.repos.agents.setStatus(agentId, "frozen")) return false;
  deps.repos.kv.set(freezeKey(agentId), JSON.stringify({ ...info, at: new Date(nowMs).toISOString() } satisfies FreezeInfo));
  deps.bus.publish({ type: "agent_status", data: { agent_id: agentId, status: "frozen" } });
  return true;
}

export function unfreezeAgent(deps: ControlDeps, agentId: string): boolean {
  if (!deps.repos.agents.setStatus(agentId, "active")) return false;
  deps.repos.kv.delete(freezeKey(agentId));
  deps.bus.publish({ type: "agent_status", data: { agent_id: agentId, status: "active" } });
  return true;
}

/** Global freeze: every agent is denied at stage 0, whatever its own status. */
export function freezeAll(deps: ControlDeps, nowMs = Date.now()): number {
  deps.repos.kv.set(GLOBAL_FREEZE_KEY, "1");
  const agents = deps.repos.agents.list();
  for (const a of agents) freezeAgent(deps, a.id, { reason: "freeze_all" }, nowMs);
  return agents.length;
}

/** Clears the global flag and unfreezes every agent (including ones the breaker froze). */
export function unfreezeAll(deps: ControlDeps): number {
  deps.repos.kv.delete(GLOBAL_FREEZE_KEY);
  const agents = deps.repos.agents.list();
  for (const a of agents) unfreezeAgent(deps, a.id);
  return agents.length;
}
