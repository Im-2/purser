import { freezeAgent, getFreezeInfo, type ControlDeps } from "./killswitch.js";

/**
 * Circuit breaker (SPEC section 4): `breaker.max_denies` denies within `breaker.window_sec` freezes the agent.
 * Call it after a deny has been recorded. Returns true if this call tripped the breaker.
 * The reason and numbers are stored with the freeze (visible in GET /api/agents) and published as breaker_tripped.
 */
export function checkBreaker(deps: ControlDeps, agentId: string, nowMs: number): boolean {
  const { repos, bus } = deps;
  const agent = repos.agents.get(agentId);
  if (!agent || agent.status === "frozen") return false;
  const policy = repos.policies.getActive(agentId);
  if (!policy) return false;
  const { max_denies, window_sec } = policy.breaker;
  const denies = repos.attempts.countDenies(agentId, nowMs - window_sec * 1000);
  if (denies < max_denies) return false;

  freezeAgent(deps, agentId, { reason: "circuit_breaker", detail: { denies, max_denies, window_sec } }, nowMs);
  bus.publish({ type: "breaker_tripped", data: { agent_id: agentId, denies, window_sec } });
  return true;
}

export { getFreezeInfo };
