/** Thin client for Purser's admin REST API (bearer admin token). Used by scenarios for setup and by verify for assertions. */

export class ApiError extends Error {
  override name = "ApiError";
  constructor(
    message: string,
    readonly status: number,
    readonly body: unknown,
  ) {
    super(message);
  }
}

export interface AttemptView {
  id: string;
  ts: string;
  tool: string;
  tool_class: string;
  amount: number | null;
  amount_display: string | null;
  currency: string | null;
  payee_email: string | null;
  reason: string | null;
  source: string | null;
  decision: "allow" | "deny" | "escalate";
  decision_stage: string;
  rule_hits_detail: { id: string; severity?: string; message?: string }[];
  signals_detail: ({ id: string; severity?: string; evidence?: string } | string)[];
  ai: { verdict: string; risk: number; rationale: string; cached?: boolean; stale?: boolean; advisory?: boolean; error?: string; model?: string; flags?: string[] } | null;
  approval: { approval_id: string; status: string; result?: { executed: boolean; payout_batch_id?: string } } | null;
  ledger: { id: string; status: string; amount: number | null } | null;
}

export interface AgentView {
  id: string;
  name: string;
  status: string;
  effective_status: string;
  freeze: { reason: string; detail?: Record<string, unknown> } | null;
  pending_approvals: number;
}

export class AdminApi {
  constructor(
    readonly baseUrl: string,
    private readonly token: string,
  ) {}

  private async call<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: { Authorization: `Bearer ${this.token}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(60_000),
    });
    const text = await res.text();
    let json: unknown;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = text;
    }
    if (!res.ok) throw new ApiError(`${method} ${path} -> HTTP ${res.status}`, res.status, json);
    return json as T;
  }

  get = <T = unknown>(path: string) => this.call<T>("GET", path);
  post = <T = unknown>(path: string, body?: unknown) => this.call<T>("POST", path, body ?? {});

  reset = () => this.post<{ attempts_cleared: number; policy_restored: boolean }>("/api/demo/reset");
  agents = () => this.get<{ global_freeze: boolean; agents: AgentView[] }>("/api/agents");
  freeze = (id: string) => this.post(`/api/agents/${id}/freeze`);
  unfreeze = (id: string) => this.post(`/api/agents/${id}/unfreeze`);
  policy = (agentId: string) => this.get<{ active: Record<string, unknown> | null; history: { version: number; active: boolean }[] }>(`/api/policies/${agentId}`);
  applyPolicy = (agentId: string, policy: unknown, sourceText: string) => this.post<{ version: number }>("/api/policies/apply", { agent_id: agentId, policy, source_text: sourceText });
  attempts = (limit = 200) => this.get<{ attempts: AttemptView[] }>(`/api/attempts?limit=${limit}`).then((r) => r.attempts);
  approvals = (status?: string) => this.get<{ approvals: { approval_id: string; status: string; attempt_id: string }[] }>(`/api/approvals${status ? `?status=${status}` : ""}`).then((r) => r.approvals);
  approve = (id: string) => this.post(`/api/approvals/${id}/approve`);
  deny = (id: string) => this.post(`/api/approvals/${id}/deny`);
}

/** Wait for GET /health to answer ok. */
export async function waitForHealth(baseUrl: string, timeoutMs = 60_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(2000) });
      if (r.ok) return true;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  return false;
}
