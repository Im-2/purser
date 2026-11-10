import type { Policy } from "@purser/shared";

/** The example policy from SPEC section 6. Allowlist comes from the real sandbox vendor emails. */
export function defaultPolicy(opts: { agentId: string; allowlist: string[]; mandate?: string }): Policy {
  return {
    version: 1,
    agent_id: opts.agentId,
    mandate: opts.mandate ?? "Pays approved vendors and issues customer refunds for the online store.",
    currency_allowed: ["USD"],
    allowed_actions: ["purser_payout", "create_refund", "create_invoice", "create_order", "list_*", "get_*"],
    limits: { per_tx_cap: 200, daily_cap: 500, weekly_cap: 1500, monthly_cap: 4000 },
    approval_threshold: 150,
    payees: { mode: "first_time_requires_approval", allowlist: opts.allowlist, blocklist: [] },
    velocity: { max_count: 8, window_sec: 60 },
    structuring: { window_sec: 900, min_count: 3, near_cap_ratio: 0.8, action: "deny" },
    trust: { lookalike: "escalate", vendor_mismatch: "escalate", free_mail_for_business: "escalate" },
    ai_review: { enabled: true, min_amount: 50 },
    breaker: { max_denies: 4, window_sec: 120 },
    approval_ttl_sec: 900,
  };
}
