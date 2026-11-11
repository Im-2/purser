/** Shapes returned by the Purser admin API and SSE feed (see server/src/admin/api.ts). */

export type Decision = "allow" | "deny" | "escalate";

export interface AiInfo {
  verdict: Decision;
  risk: number;
  rationale: string;
  flags: string[];
  model?: string;
  cached?: boolean;
  stale?: boolean;
  latency_ms?: number;
  advisory?: boolean;
  error?: string;
}

/** An attempt as streamed over SSE (the shared AttemptRecord). Amounts are integer minor units. */
export interface Attempt {
  id: string;
  agent_id: string;
  ts: string;
  tool: string;
  tool_class: string;
  args: Record<string, unknown>;
  amount: number | null;
  currency: string | null;
  payee_email: string | null;
  reason: string | null;
  source: string | null;
  decision: Decision;
  decision_stage: string;
  rule_hits: string[];
  signals: string[];
  ai: AiInfo | null;
  approval_id: string | null;
  upstream_result: unknown;
  ledger_id: string | null;
  latency_ms: number | null;
}

export interface RuleHitDetail {
  id: string;
  severity?: "deny" | "escalate";
  message?: string;
  detail?: Record<string, unknown>;
}
export type SignalDetail = string | { id: string; severity?: "info" | "escalate" | "deny"; evidence?: string };

export interface ApprovalInfo {
  approval_id: string;
  status: "pending" | "approved" | "denied" | "expired";
  expires_at: string;
  decided_by?: string | null;
  decided_at?: string | null;
  result?: { executed: boolean; payout_batch_id?: string; ledger_status?: string; error?: string };
}

/** GET /api/attempts and /api/attempts/:id */
export interface AttemptDetail extends Attempt {
  amount_display: string | null;
  rule_hits_detail: RuleHitDetail[];
  signals_detail: SignalDetail[];
  approval: ApprovalInfo | null;
  ledger: { id: string; status: string; amount: number | null; currency: string | null; paypal_ref: Record<string, unknown> } | null;
}

export interface ApprovalItem extends ApprovalInfo {
  attempt_id: string;
  channel: string | null;
  attempt: AttemptDetail | null;
}

export interface AgentInfo {
  id: string;
  name: string;
  mandate: string;
  status: "active" | "frozen";
  effective_status: "active" | "frozen";
  freeze: { reason: "admin" | "freeze_all" | "circuit_breaker"; at: string; detail?: Record<string, unknown> } | null;
  pending_approvals: number;
  created_at: string;
}

export interface Stats {
  window: string;
  since: string;
  spend_today_minor: number;
  spend_today: string;
  blocked_count: number;
  blocked_amount_minor: number;
  blocked_amount: string;
  pending_approvals: number;
  agents_frozen: number;
  global_freeze: boolean;
}

export type ScenarioLogKind = "start" | "info" | "agent" | "tool_call" | "tool_result" | "decision" | "error" | "done";
export interface ScenarioLog {
  run_id: string;
  scenario: string;
  mode: "replay" | "live";
  step: number;
  kind: ScenarioLogKind;
  message: string;
  data?: Record<string, unknown>;
}

export interface DemoStatus {
  running: { run_id: string; scenario: string; mode: "replay" | "live"; started_at: string } | null;
  last: { run_id: string; scenario: string; mode: string; started_at: string; duration_ms: number; decisions: string[]; agent_frozen: boolean; pending_approvals: string[]; error?: string } | null;
}

// ---------------------------------------------------------------- policies
export interface PolicyDiffEntry {
  path: string;
  change: "added" | "removed" | "changed";
  before: unknown;
  after: unknown;
}
export interface PolicyWarning {
  code: string;
  level: "warning" | "info";
  message: string;
}
export type PolicyDoc = Record<string, unknown>;
export interface CompileResult {
  policy: PolicyDoc;
  warnings: PolicyWarning[];
  diff: PolicyDiffEntry[];
  unsupported: string[];
  model: string;
  latency_ms: number;
}
export interface PolicyHistoryRow {
  id: string;
  version: number;
  active: boolean;
  source_text: string | null;
  created_at: string;
}
export interface PolicyState {
  active: PolicyDoc | null;
  history: PolicyHistoryRow[];
}

// ---------------------------------------------------------------- reconciliation
export type FindingType = "unrecorded_movement" | "amount_mismatch" | "duplicate" | "payout_denied_or_unclaimed";
export interface ReconFinding {
  id: string;
  ts: string;
  matched: boolean;
  finding_type: FindingType | null;
  ledger_id: string | null;
  paypal_event_id: string | null;
  event_type: string | null;
  detail: Record<string, unknown>;
}
export interface ReconList {
  counts: Record<string, number>;
  findings: ReconFinding[];
}
export type SearchStatus = "ok" | "lagging" | "unavailable" | "skipped";
export interface ReconRun {
  ran_at: string;
  since: string;
  ledger: { checked: number; matched: number; errors: string[] };
  transaction_search: { status: SearchStatus; note: string; transactions_seen?: number; outgoing_seen?: number; lag_minutes?: number };
  matched: number;
  findings: { id: string; finding_type: FindingType; detail: Record<string, unknown> }[];
}
