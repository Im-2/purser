export function money(minor: number | null | undefined, currency: string | null | undefined = "USD"): string {
  if (minor === null || minor === undefined) return "n/a";
  const sign = minor < 0 ? "-" : "";
  const abs = Math.abs(minor);
  const whole = Math.floor(abs / 100).toLocaleString("en-US");
  const frac = String(abs % 100).padStart(2, "0");
  const sym = !currency || currency === "USD" ? "$" : `${currency} `;
  return `${sign}${sym}${whole}.${frac}`;
}

const two = (n: number) => String(n).padStart(2, "0");

/** 14:02:11 in the viewer's local time. */
export function clock(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : `${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`;
}

export function relTime(iso: string, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (s < 5) return "just now";
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

/** mm:ss, or h:mm:ss past an hour. Negative becomes 00:00. */
export function countdown(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h ? `${h}:${two(m)}:${two(s % 60)}` : `${two(m)}:${two(s % 60)}`;
}

export const STAGE_LABEL: Record<string, string> = {
  auth: "Auth",
  killswitch: "Kill switch",
  classify: "Classify",
  rules: "Hard rules",
  trust: "Payee trust",
  ai: "AI reviewer",
  approval: "Human approval",
  execute: "Execution",
};

export const SIGNAL_LABEL: Record<string, string> = {
  first_time_payee: "first-time payee",
  lookalike_payee: "look-alike payee",
  vendor_mismatch: "vendor mismatch",
  payee_recently_changed: "payee changed",
  free_mail_for_business: "free-mail for business",
};

export const RULE_LABEL: Record<string, string> = {
  unknown_tool: "unknown tool",
  action_not_allowed: "action not allowed",
  amount_unknown: "amount unknown",
  currency_unknown: "currency unknown",
  currency_not_allowed: "currency not allowed",
  per_tx_cap: "per-payment cap",
  daily_cap: "daily cap",
  weekly_cap: "weekly cap",
  monthly_cap: "monthly cap",
  velocity: "velocity",
  structuring: "structuring",
  payee_blocklisted: "payee blocklisted",
  payee_unknown: "payee unknown",
  approval_threshold: "approval threshold",
  payee_not_allowlisted: "payee not allowlisted",
  no_active_policy: "no active policy",
  agent_frozen: "agent frozen",
  global_freeze: "global freeze",
  approval_denied: "denied by a human",
  approval_expired: "approval expired",
};

export const label = (map: Record<string, string>, id: string) => map[id] ?? id.replace(/_/g, " ");
