import type { ToolClass } from "@purser/shared";

export interface ClassifierConfig {
  /** Exact tool name -> class. Checked first. */
  exact: Record<string, ToolClass>;
  /** Ordered regex fallbacks. First match wins. Anything unmatched is "unknown" (denied). */
  patterns: { re: RegExp; cls: ToolClass }[];
}

export const DEFAULT_CLASSIFIER: ClassifierConfig = {
  exact: {
    // read
    purser_status: "read",
    purser_check_approval: "read",
    // money_in
    create_order: "money_in",
    create_invoice: "money_in",
    create_product: "money_in",
    create_plan: "money_in",
    // outbound comms
    send_invoice: "outbound_comms",
    send_invoice_reminder: "outbound_comms",
    // capture
    pay_order: "capture",
    capture_order: "capture",
    // money out
    create_refund: "money_out",
    purser_payout: "money_out",
  },
  patterns: [
    { re: /^(get|list|show)_/i, cls: "read" },
    { re: /^create_subscription/i, cls: "money_in" },
    { re: /^send_/i, cls: "outbound_comms" },
    { re: /^(pay|capture)_/i, cls: "capture" },
    { re: /(refund|payout|transfer|withdraw)/i, cls: "money_out" },
  ],
};

/** Classify a tool by name. Unknown tools return "unknown" so the pipeline denies them (fail closed). */
export function classifyTool(tool: string, cfg: ClassifierConfig = DEFAULT_CLASSIFIER): ToolClass {
  const name = tool.trim();
  if (!name) return "unknown";
  const exact = Object.hasOwn(cfg.exact, name) ? cfg.exact[name] : undefined;
  if (exact) return exact;
  for (const { re, cls } of cfg.patterns) if (re.test(name)) return cls;
  return "unknown";
}
