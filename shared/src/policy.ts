import { z } from "zod";

const Money = z.number().nonnegative();

export const PolicySchema = z.object({
  version: z.number().int().positive(),
  agent_id: z.string().min(1),
  mandate: z.string(),
  currency_allowed: z.array(z.string().length(3)).min(1),
  allowed_actions: z.array(z.string()),
  limits: z.object({
    per_tx_cap: Money,
    daily_cap: Money,
    weekly_cap: Money,
    monthly_cap: Money,
  }),
  approval_threshold: Money,
  payees: z.object({
    mode: z.enum(["strict", "first_time_requires_approval", "open"]),
    allowlist: z.array(z.string()),
    blocklist: z.array(z.string()),
  }),
  velocity: z.object({
    max_count: z.number().int().positive(),
    window_sec: z.number().int().positive(),
  }),
  structuring: z.object({
    window_sec: z.number().int().positive(),
    min_count: z.number().int().positive(),
    near_cap_ratio: z.number().min(0).max(1),
    action: z.enum(["deny", "escalate"]),
  }),
  trust: z.object({
    lookalike: z.enum(["escalate", "deny"]),
    vendor_mismatch: z.enum(["escalate", "deny"]),
    free_mail_for_business: z.enum(["escalate", "deny"]),
  }),
  ai_review: z.object({
    enabled: z.boolean(),
    min_amount: Money,
  }),
  breaker: z.object({
    max_denies: z.number().int().positive(),
    window_sec: z.number().int().positive(),
  }),
  approval_ttl_sec: z.number().int().positive(),
});
export type Policy = z.infer<typeof PolicySchema>;
