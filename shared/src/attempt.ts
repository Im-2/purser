import { z } from "zod";
import { Decision, DecisionStage, ToolClass } from "./decision.js";

export const AiVerdict = z.object({
  verdict: Decision,
  risk: z.number().min(0).max(100),
  rationale: z.string(),
  flags: z.array(z.string()),
  model: z.string().optional(),
  cached: z.boolean().optional(),
  stale: z.boolean().optional(),
  latency_ms: z.number().optional(),
  advisory: z.boolean().optional(),
  error: z.string().optional(),
});
export type AiVerdict = z.infer<typeof AiVerdict>;

export const AttemptRecord = z.object({
  id: z.string(),
  agent_id: z.string(),
  ts: z.string(),
  tool: z.string(),
  tool_class: ToolClass,
  args: z.record(z.string(), z.unknown()),
  amount: z.number().nullable(),
  currency: z.string().nullable(),
  payee_email: z.string().nullable(),
  reason: z.string().nullable(),
  source: z.string().nullable(),
  decision: Decision,
  decision_stage: DecisionStage,
  rule_hits: z.array(z.string()),
  signals: z.array(z.string()),
  ai: AiVerdict.nullable(),
  approval_id: z.string().nullable(),
  upstream_result: z.unknown().nullable(),
  ledger_id: z.string().nullable(),
  latency_ms: z.number().nullable(),
});
export type AttemptRecord = z.infer<typeof AttemptRecord>;
