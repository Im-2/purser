import { unfreezeAll, type ControlDeps } from "./killswitch.js";
import { defaultPolicy, SEEDED_AGENT_ID } from "../policy/defaults.js";

export interface DemoResetResult {
  attempts_cleared: number;
  agents_unfrozen: number;
  policy_restored: boolean;
  policy_version: number | null;
}

/**
 * Reset to the seeded demo state: wipe attempts, approvals, ledger and reconciliation, unfreeze everything and restore the
 * seeded policy (a new version only if the active one differs). The AI verdict cache is kept so replay still works.
 */
export function resetDemo(deps: ControlDeps): DemoResetResult {
  const { repos } = deps;
  const attempts_cleared = repos.attempts.list({ limit: 1000 }).length;
  repos.attempts.clearAll();
  const agents_unfrozen = unfreezeAll(deps);

  let policy_restored = false;
  let policy_version: number | null = null;
  if (repos.agents.get(SEEDED_AGENT_ID)) {
    const allowlist = repos.payees.list().filter((p) => p.trusted).map((p) => p.email);
    const seeded = defaultPolicy({ agentId: SEEDED_AGENT_ID, allowlist });
    const active = repos.policies.getActive(SEEDED_AGENT_ID);
    const same = active && JSON.stringify({ ...active, version: 0 }) === JSON.stringify({ ...seeded, version: 0 });
    if (!same) {
      const row = repos.policies.apply(SEEDED_AGENT_ID, seeded, "Demo reset: restored seeded policy");
      policy_restored = true;
      policy_version = row.version;
    } else policy_version = active.version;
  }
  return { attempts_cleared, agents_unfrozen, policy_restored, policy_version };
}
