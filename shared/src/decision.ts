import { z } from "zod";

export const Decision = z.enum(["allow", "deny", "escalate"]);
export type Decision = z.infer<typeof Decision>;

export const ToolClass = z.enum([
  "read",
  "money_in",
  "capture",
  "money_out",
  "outbound_comms",
  "unknown",
]);
export type ToolClass = z.infer<typeof ToolClass>;

export const DecisionStage = z.enum([
  "auth",
  "killswitch",
  "classify",
  "rules",
  "trust",
  "ai",
  "approval",
  "execute",
]);
export type DecisionStage = z.infer<typeof DecisionStage>;

export const TrustSignal = z.enum([
  "first_time_payee",
  "lookalike_payee",
  "vendor_mismatch",
  "payee_recently_changed",
  "free_mail_for_business",
]);
export type TrustSignal = z.infer<typeof TrustSignal>;
