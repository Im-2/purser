import type { Decision, Policy, ToolClass } from "@purser/shared";

/**
 * Stage 2 hard rules (SPEC section 4). Pure and deterministic: no network, no clock, no model.
 * Every rule runs and reports; the final decision is the strictest hit (deny > escalate > allow),
 * so no combination of rules can ever turn a deny into an allow.
 * Money is integer minor units (cents).
 */

export interface HistoryEntry {
  tsMs: number;
  toolClass: ToolClass;
  amountMinor: number | null;
  payeeEmail: string | null;
  /** Decision recorded for that attempt. Spend sums count only "allow" money_out. */
  decision: Decision;
}

export interface RuleCall {
  toolClass: ToolClass;
  tool: string;
  amountMinor: number | null;
  currency: string | null;
  payeeEmail: string | null;
}

export interface RuleInput {
  call: RuleCall;
  policy: Policy;
  /** Prior attempts for this agent, at least covering the longest window (30 days). Excludes the current call. */
  history: HistoryEntry[];
  /** Injected clock (epoch ms). */
  nowMs: number;
}

export type RuleId =
  | "unknown_tool"
  | "action_not_allowed"
  | "amount_unknown"
  | "currency_unknown"
  | "currency_not_allowed"
  | "per_tx_cap"
  | "daily_cap"
  | "weekly_cap"
  | "monthly_cap"
  | "velocity"
  | "structuring"
  | "payee_blocklisted"
  | "payee_unknown"
  | "approval_threshold"
  | "payee_not_allowlisted";

export interface RuleHit {
  id: RuleId;
  severity: "deny" | "escalate";
  /** Internal explanation for the dashboard. Never sent to the agent. */
  message: string;
  /** Internal numbers (caps, sums). Never sent to the agent. */
  detail: Record<string, unknown>;
}

export interface RuleResult {
  decision: Decision;
  hits: RuleHit[];
  /** Safe, non-leaky message for the agent. */
  agentMessage: string;
}

const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const MONEY_CLASSES: ReadonlySet<ToolClass> = new Set(["money_in", "capture", "money_out", "outbound_comms"]);
const AMOUNT_CLASSES: ReadonlySet<ToolClass> = new Set(["money_in", "capture", "money_out"]);

const toCapMinor = (dollars: number) => Math.round(dollars * 100);
const norm = (e: string) => e.trim().toLowerCase();

/** Glob match for allowed_actions: "*" is a wildcard, everything else is literal. Case-insensitive. */
export function matchesAction(tool: string, patterns: string[]): boolean {
  const t = tool.toLowerCase();
  return patterns.some((p) => {
    const re = new RegExp("^" + p.toLowerCase().replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$");
    return re.test(t);
  });
}

/** Combine hits into a decision. Strictest wins. */
export function combine(hits: RuleHit[]): Decision {
  if (hits.some((h) => h.severity === "deny")) return "deny";
  if (hits.some((h) => h.severity === "escalate")) return "escalate";
  return "allow";
}

export function agentMessageFor(decision: Decision): string {
  switch (decision) {
    case "deny":
      return "This request was blocked by spending policy.";
    case "escalate":
      return "This request needs human approval before it can proceed.";
    default:
      return "Allowed.";
  }
}

const isRefund = (tool: string) => /refund/i.test(tool);

export function evaluateRules(input: RuleInput): RuleResult {
  const { call, policy, history, nowMs } = input;
  const hits: RuleHit[] = [];
  const add = (id: RuleId, severity: "deny" | "escalate", message: string, detail: Record<string, unknown> = {}) =>
    hits.push({ id, severity, message, detail });

  const finish = (): RuleResult => {
    const decision = combine(hits);
    return { decision, hits, agentMessage: agentMessageFor(decision) };
  };

  // Unknown tools are denied (fail closed).
  if (call.toolClass === "unknown") {
    add("unknown_tool", "deny", `Tool "${call.tool}" is not classified`, { tool: call.tool });
    return finish();
  }

  // Read tools: only the kill switch applies (handled before this stage).
  if (call.toolClass === "read") return finish();

  const payee = call.payeeEmail ? norm(call.payeeEmail) : null;
  const isMoneyOut = call.toolClass === "money_out";
  const hasAmountRules = AMOUNT_CLASSES.has(call.toolClass);
  const lim = policy.limits;

  // allowed_actions
  if (!matchesAction(call.tool, policy.allowed_actions)) {
    add("action_not_allowed", "deny", `Action "${call.tool}" is not in allowed_actions`, { tool: call.tool });
  }

  // amount and currency (money_in, capture, money_out)
  if (hasAmountRules) {
    if (call.amountMinor === null || !(call.amountMinor > 0)) {
      add("amount_unknown", "escalate", "Amount could not be determined; failing closed", { tool: call.tool });
    }
    if (call.currency === null) {
      add("currency_unknown", "escalate", "Currency could not be determined; failing closed");
    } else if (!policy.currency_allowed.map((c) => c.toUpperCase()).includes(call.currency.toUpperCase())) {
      add("currency_not_allowed", "deny", `Currency ${call.currency} is not allowed`, { allowed: policy.currency_allowed });
    }
  }

  const amount = call.amountMinor !== null && call.amountMinor > 0 ? call.amountMinor : null;

  // per-transaction cap
  if (hasAmountRules && amount !== null) {
    const cap = toCapMinor(lim.per_tx_cap);
    if (amount > cap) add("per_tx_cap", "deny", "Amount exceeds the per-transaction cap", { amount, cap });
  }

  // rolling spend caps (money leaving the account)
  if (isMoneyOut && amount !== null) {
    const windows: [RuleId, number, number][] = [
      ["daily_cap", DAY, lim.daily_cap],
      ["weekly_cap", 7 * DAY, lim.weekly_cap],
      ["monthly_cap", 30 * DAY, lim.monthly_cap],
    ];
    for (const [id, windowMs, capDollars] of windows) {
      const spent = history
        .filter((h) => h.toolClass === "money_out" && h.decision === "allow" && h.amountMinor !== null && h.tsMs > nowMs - windowMs && h.tsMs <= nowMs)
        .reduce((s, h) => s + (h.amountMinor ?? 0), 0);
      const cap = toCapMinor(capDollars);
      if (spent + amount > cap) add(id, "deny", `Rolling spend would exceed the ${id.replace("_cap", "")} cap`, { spent, amount, cap });
    }
  }

  // velocity: this call counts toward the window
  if (MONEY_CLASSES.has(call.toolClass)) {
    const windowMs = policy.velocity.window_sec * 1000;
    const recent = history.filter((h) => MONEY_CLASSES.has(h.toolClass) && h.tsMs > nowMs - windowMs && h.tsMs <= nowMs).length;
    if (recent + 1 > policy.velocity.max_count) {
      add("velocity", "deny", "Too many money calls in the velocity window", { count: recent + 1, max: policy.velocity.max_count, window_sec: policy.velocity.window_sec });
    }
  }

  // structuring: repeated payments to one payee that stay under the cap or add up past it
  if (isMoneyOut && payee && amount !== null) {
    const windowMs = policy.structuring.window_sec * 1000;
    const prior = history.filter(
      (h) => h.toolClass === "money_out" && h.payeeEmail && norm(h.payeeEmail) === payee && h.amountMinor !== null && h.tsMs > nowMs - windowMs && h.tsMs <= nowMs,
    );
    const amounts = [...prior.map((h) => h.amountMinor as number), amount];
    const cap = toCapMinor(lim.per_tx_cap);
    // amount >= ratio * cap, in integers (ratio in 1/10000ths)
    const ratioBp = Math.round(policy.structuring.near_cap_ratio * 10_000);
    const nearCap = (a: number) => a * 10_000 >= ratioBp * cap;
    const sum = amounts.reduce((s, a) => s + a, 0);
    if (amounts.length >= policy.structuring.min_count && (amounts.every(nearCap) || sum > cap)) {
      add("structuring", policy.structuring.action === "deny" ? "deny" : "escalate", "Repeated payments to one payee look like structuring", {
        count: amounts.length,
        sum,
        cap,
        window_sec: policy.structuring.window_sec,
      });
    }
  }

  // payee rules
  if (payee && policy.payees.blocklist.map(norm).includes(payee)) {
    add("payee_blocklisted", "deny", "Payee is on the blocklist", { payee });
  }

  if (isMoneyOut) {
    if (amount !== null && amount > Math.round(policy.approval_threshold * 100)) {
      add("approval_threshold", "escalate", "Amount is above the approval threshold", { amount, threshold: Math.round(policy.approval_threshold * 100) });
    }

    // Refunds go back to the original payer, so allowlist rules do not apply to them.
    if (!isRefund(call.tool)) {
      if (!payee) {
        add("payee_unknown", "escalate", "Payee could not be determined; failing closed");
      } else if (!policy.payees.allowlist.map(norm).includes(payee)) {
        if (policy.payees.mode === "strict") add("payee_not_allowlisted", "deny", "Payee is not on the allowlist (strict mode)", { payee });
        else if (policy.payees.mode === "first_time_requires_approval")
          add("payee_not_allowlisted", "escalate", "Payee is not on the allowlist; approval required", { payee });
      }
    }
  }

  return finish();
}
