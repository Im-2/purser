import { z } from "zod";
import { AttemptRecord } from "./attempt.js";

export const EventName = z.enum([
  "attempt",
  "approval_created",
  "approval_resolved",
  "agent_status",
  "breaker_tripped",
  "reconciliation_finding",
  "scenario_log",
]);
export type EventName = z.infer<typeof EventName>;

export const PurserEvent = z.discriminatedUnion("type", [
  z.object({ type: z.literal("attempt"), data: AttemptRecord }),
  z.object({
    type: z.literal("approval_created"),
    data: z.object({ approval_id: z.string(), attempt_id: z.string(), expires_at: z.string() }),
  }),
  z.object({
    type: z.literal("approval_resolved"),
    data: z.object({
      approval_id: z.string(),
      attempt_id: z.string(),
      status: z.enum(["approved", "denied", "expired"]),
      decided_by: z.string().nullable(),
    }),
  }),
  z.object({
    type: z.literal("agent_status"),
    data: z.object({ agent_id: z.string(), status: z.enum(["active", "frozen"]) }),
  }),
  z.object({
    type: z.literal("breaker_tripped"),
    data: z.object({ agent_id: z.string(), denies: z.number(), window_sec: z.number() }),
  }),
  z.object({
    type: z.literal("reconciliation_finding"),
    data: z.object({
      id: z.string(),
      finding_type: z.enum([
        "unrecorded_movement",
        "amount_mismatch",
        "duplicate",
        "payout_denied_or_unclaimed",
      ]),
      detail: z.record(z.string(), z.unknown()),
    }),
  }),
  z.object({
    type: z.literal("scenario_log"),
    data: z.object({
      run_id: z.string(),
      scenario: z.string(),
      mode: z.enum(["replay", "live"]),
      /** 1-based order of this entry within the run. */
      step: z.number(),
      kind: z.enum(["start", "info", "agent", "tool_call", "tool_result", "decision", "error", "done"]),
      message: z.string(),
      data: z.record(z.string(), z.unknown()).optional(),
    }),
  }),
]);
export type PurserEvent = z.infer<typeof PurserEvent>;
