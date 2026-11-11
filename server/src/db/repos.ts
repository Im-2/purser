import { createHash, randomUUID } from "node:crypto";
import type { Db } from "./index.js";
import { PolicySchema, type Decision, type Policy, type ToolClass } from "@purser/shared";
import type { HistoryEntry } from "../policy/rules.js";

export const hashApiKey = (key: string): string => createHash("sha256").update(key).digest("hex");
const newId = (prefix: string) => `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
const j = (v: unknown) => JSON.stringify(v ?? null);

export interface AgentRow {
  id: string;
  name: string;
  api_key_hash: string;
  status: "active" | "frozen";
  mandate: string;
  created_at: number;
}
export interface PolicyRow {
  id: string;
  agent_id: string;
  version: number;
  json: string;
  source_text: string | null;
  active: number;
  created_at: number;
}
export interface PayeeRow {
  id: string;
  email: string;
  display_name: string | null;
  domain: string;
  first_seen_at: number;
  trusted: number;
  notes: string | null;
}
export interface AttemptRow {
  id: string;
  agent_id: string;
  ts: number;
  tool: string;
  tool_class: ToolClass;
  args_json: string;
  amount: number | null;
  currency: string | null;
  payee_email: string | null;
  reason: string | null;
  source: string | null;
  decision: Decision;
  decision_stage: string;
  rule_hits_json: string;
  signals_json: string;
  ai_json: string | null;
  approval_id: string | null;
  upstream_result_json: string | null;
  ledger_id: string | null;
  latency_ms: number | null;
}
export interface ApprovalRow {
  id: string;
  attempt_id: string;
  status: "pending" | "approved" | "denied" | "expired";
  channel: string | null;
  decided_by: string | null;
  decided_at: number | null;
  expires_at: number;
}
export interface LedgerRow {
  id: string;
  attempt_id: string;
  paypal_ref_json: string;
  amount: number | null;
  currency: string | null;
  status: string;
  created_at: number;
}
export interface ReconciliationRow {
  id: string;
  ledger_id: string | null;
  paypal_event_id: string | null;
  event_type: string | null;
  matched: number;
  finding_type: string | null;
  detail_json: string;
  ts: number;
}

export interface NewAttempt {
  agent_id: string;
  tool: string;
  tool_class: ToolClass;
  args: unknown;
  amount: number | null;
  currency: string | null;
  payee_email: string | null;
  reason?: string | null;
  source?: string | null;
  decision: Decision;
  decision_stage: string;
  rule_hits?: unknown[];
  signals?: unknown[];
  ai?: unknown;
  latency_ms?: number | null;
  ts?: number;
}

export function createRepos(db: Db) {
  const agents = {
    create(a: { name: string; apiKey: string; mandate?: string; id?: string }): AgentRow {
      const row: AgentRow = {
        id: a.id ?? newId("agent"),
        name: a.name,
        api_key_hash: hashApiKey(a.apiKey),
        status: "active",
        mandate: a.mandate ?? "",
        created_at: Date.now(),
      };
      db.prepare(
        "INSERT INTO agents (id,name,api_key_hash,status,mandate,created_at) VALUES (@id,@name,@api_key_hash,@status,@mandate,@created_at)",
      ).run(row);
      return row;
    },
    get: (id: string) => db.prepare("SELECT * FROM agents WHERE id = ?").get(id) as AgentRow | undefined,
    byApiKey: (key: string) =>
      db.prepare("SELECT * FROM agents WHERE api_key_hash = ?").get(hashApiKey(key)) as AgentRow | undefined,
    list: () => db.prepare("SELECT * FROM agents ORDER BY created_at").all() as AgentRow[],
    setStatus: (id: string, status: "active" | "frozen") =>
      db.prepare("UPDATE agents SET status = ? WHERE id = ?").run(status, id).changes > 0,
    setAllStatus: (status: "active" | "frozen") => db.prepare("UPDATE agents SET status = ?").run(status).changes,
  };

  const policies = {
    /** Insert a new version and make it the only active policy for the agent. History is kept. */
    apply(agentId: string, policy: Policy, sourceText?: string): PolicyRow {
      const valid = PolicySchema.parse(policy);
      return db.transaction(() => {
        const maxV = (db.prepare("SELECT COALESCE(MAX(version),0) v FROM policies WHERE agent_id = ?").get(agentId) as { v: number }).v;
        db.prepare("UPDATE policies SET active = 0 WHERE agent_id = ?").run(agentId);
        const row: PolicyRow = {
          id: newId("pol"),
          agent_id: agentId,
          version: maxV + 1,
          json: JSON.stringify({ ...valid, version: maxV + 1 }),
          source_text: sourceText ?? null,
          active: 1,
          created_at: Date.now(),
        };
        db.prepare(
          "INSERT INTO policies (id,agent_id,version,json,source_text,active,created_at) VALUES (@id,@agent_id,@version,@json,@source_text,@active,@created_at)",
        ).run(row);
        return row;
      })();
    },
    getActive(agentId: string): Policy | undefined {
      const r = db.prepare("SELECT json FROM policies WHERE agent_id = ? AND active = 1").get(agentId) as { json: string } | undefined;
      return r ? PolicySchema.parse(JSON.parse(r.json)) : undefined;
    },
    history: (agentId: string) =>
      db.prepare("SELECT * FROM policies WHERE agent_id = ? ORDER BY version DESC").all(agentId) as PolicyRow[],
  };

  const payees = {
    upsert(p: { email: string; display_name?: string; trusted?: boolean; notes?: string }): PayeeRow {
      const email = p.email.trim().toLowerCase();
      const existing = payees.byEmail(email);
      if (existing) {
        db.prepare("UPDATE payees SET display_name = COALESCE(?, display_name), trusted = ?, notes = COALESCE(?, notes) WHERE id = ?").run(
          p.display_name ?? null,
          p.trusted === undefined ? existing.trusted : p.trusted ? 1 : 0,
          p.notes ?? null,
          existing.id,
        );
        return payees.byEmail(email)!;
      }
      const row: PayeeRow = {
        id: newId("payee"),
        email,
        display_name: p.display_name ?? null,
        domain: email.split("@")[1] ?? "",
        first_seen_at: Date.now(),
        trusted: p.trusted ? 1 : 0,
        notes: p.notes ?? null,
      };
      db.prepare(
        "INSERT INTO payees (id,email,display_name,domain,first_seen_at,trusted,notes) VALUES (@id,@email,@display_name,@domain,@first_seen_at,@trusted,@notes)",
      ).run(row);
      return row;
    },
    byEmail: (email: string) =>
      db.prepare("SELECT * FROM payees WHERE email = ?").get(email.trim().toLowerCase()) as PayeeRow | undefined,
    list: () => db.prepare("SELECT * FROM payees ORDER BY first_seen_at").all() as PayeeRow[],
  };

  const attempts = {
    create(a: NewAttempt): AttemptRow {
      const row: AttemptRow = {
        id: newId("att"),
        agent_id: a.agent_id,
        ts: a.ts ?? Date.now(),
        tool: a.tool,
        tool_class: a.tool_class,
        args_json: j(a.args),
        amount: a.amount,
        currency: a.currency,
        payee_email: a.payee_email ? a.payee_email.trim().toLowerCase() : null,
        reason: a.reason ?? null,
        source: a.source ?? null,
        decision: a.decision,
        decision_stage: a.decision_stage,
        rule_hits_json: j(a.rule_hits ?? []),
        signals_json: j(a.signals ?? []),
        ai_json: a.ai === undefined ? null : j(a.ai),
        approval_id: null,
        upstream_result_json: null,
        ledger_id: null,
        latency_ms: a.latency_ms ?? null,
      };
      db.prepare(
        `INSERT INTO attempts (id,agent_id,ts,tool,tool_class,args_json,amount,currency,payee_email,reason,source,decision,decision_stage,rule_hits_json,signals_json,ai_json,approval_id,upstream_result_json,ledger_id,latency_ms)
         VALUES (@id,@agent_id,@ts,@tool,@tool_class,@args_json,@amount,@currency,@payee_email,@reason,@source,@decision,@decision_stage,@rule_hits_json,@signals_json,@ai_json,@approval_id,@upstream_result_json,@ledger_id,@latency_ms)`,
      ).run(row);
      return row;
    },
    get: (id: string) => db.prepare("SELECT * FROM attempts WHERE id = ?").get(id) as AttemptRow | undefined,
    list(f: { agent?: string; decision?: Decision; limit?: number } = {}): AttemptRow[] {
      const where: string[] = [];
      const params: unknown[] = [];
      if (f.agent) {
        where.push("agent_id = ?");
        params.push(f.agent);
      }
      if (f.decision) {
        where.push("decision = ?");
        params.push(f.decision);
      }
      params.push(Math.min(Math.max(f.limit ?? 100, 1), 1000));
      return db
        .prepare(`SELECT * FROM attempts ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY ts DESC, rowid DESC LIMIT ?`)
        .all(...params) as AttemptRow[];
    },
    update(id: string, patch: Partial<Pick<AttemptRow, "decision" | "decision_stage" | "approval_id" | "upstream_result_json" | "ledger_id" | "latency_ms" | "ai_json" | "signals_json" | "rule_hits_json">>) {
      const keys = Object.keys(patch) as (keyof typeof patch)[];
      if (!keys.length) return;
      db.prepare(`UPDATE attempts SET ${keys.map((k) => `${k} = @${k}`).join(", ")} WHERE id = @id`).run({ ...patch, id });
    },
    /** History for the rule engine: attempts since `sinceMs`. */
    history(agentId: string, sinceMs: number, excludeId?: string): HistoryEntry[] {
      const rows = db
        .prepare("SELECT ts, tool_class, amount, payee_email, decision FROM attempts WHERE agent_id = ? AND ts > ? AND id != ? ORDER BY ts")
        .all(agentId, sinceMs, excludeId ?? "") as { ts: number; tool_class: ToolClass; amount: number | null; payee_email: string | null; decision: Decision }[];
      return rows.map((r) => ({
        tsMs: r.ts,
        toolClass: r.tool_class,
        amountMinor: r.amount,
        payeeEmail: r.payee_email,
        decision: r.decision,
      }));
    },
    /**
     * Denies the circuit breaker counts: decisions made by the rules, trust or AI. Kill-switch, auth and human
     * approval denials are excluded, so a frozen agent cannot keep re-tripping the breaker.
     */
    countDenies(agentId: string, sinceMs: number): number {
      return (
        db
          .prepare("SELECT COUNT(*) c FROM attempts WHERE agent_id = ? AND decision = 'deny' AND ts > ? AND decision_stage NOT IN ('killswitch','auth','approval')")
          .get(agentId, sinceMs) as { c: number }
      ).c;
    },
    /** Dashboard stats since `sinceMs`: allowed money-out spend, blocked (denied) money calls, and their amounts. */
    stats(sinceMs: number): { spend_minor: number; blocked_count: number; blocked_minor: number } {
      const spend = db
        .prepare("SELECT COALESCE(SUM(amount),0) s FROM attempts WHERE ts >= ? AND tool_class = 'money_out' AND decision = 'allow' AND decision_stage != 'execute'")
        .get(sinceMs) as { s: number };
      const blocked = db
        .prepare("SELECT COUNT(*) c, COALESCE(SUM(amount),0) s FROM attempts WHERE ts >= ? AND decision = 'deny' AND tool_class != 'read'")
        .get(sinceMs) as { c: number; s: number };
      return { spend_minor: spend.s, blocked_count: blocked.c, blocked_minor: blocked.s };
    },
    clearAll() {
      db.exec("DELETE FROM reconciliation; DELETE FROM ledger; DELETE FROM approvals; DELETE FROM attempts;");
    },
  };

  const approvals = {
    create(a: { attempt_id: string; ttlSec: number; channel?: string }): ApprovalRow {
      const row: ApprovalRow = {
        id: newId("apr"),
        attempt_id: a.attempt_id,
        status: "pending",
        channel: a.channel ?? null,
        decided_by: null,
        decided_at: null,
        expires_at: Date.now() + a.ttlSec * 1000,
      };
      db.prepare(
        "INSERT INTO approvals (id,attempt_id,status,channel,decided_by,decided_at,expires_at) VALUES (@id,@attempt_id,@status,@channel,@decided_by,@decided_at,@expires_at)",
      ).run(row);
      attempts.update(a.attempt_id, { approval_id: row.id });
      return row;
    },
    get: (id: string) => db.prepare("SELECT * FROM approvals WHERE id = ?").get(id) as ApprovalRow | undefined,
    list: (status?: ApprovalRow["status"]) =>
      (status
        ? db.prepare("SELECT * FROM approvals WHERE status = ? ORDER BY expires_at").all(status)
        : db.prepare("SELECT * FROM approvals ORDER BY expires_at").all()) as ApprovalRow[],
    /** Resolve only if still pending. Returns false if already resolved (idempotent). */
    resolve: (id: string, status: "approved" | "denied" | "expired", decidedBy: string | null) =>
      db
        .prepare("UPDATE approvals SET status = ?, decided_by = ?, decided_at = ? WHERE id = ? AND status = 'pending'")
        .run(status, decidedBy, Date.now(), id).changes > 0,
  };

  const ledger = {
    create(l: { attempt_id: string; paypal_ref?: unknown; amount: number | null; currency: string | null; status: string }): LedgerRow {
      const row: LedgerRow = {
        id: newId("led"),
        attempt_id: l.attempt_id,
        paypal_ref_json: j(l.paypal_ref ?? {}),
        amount: l.amount,
        currency: l.currency,
        status: l.status,
        created_at: Date.now(),
      };
      db.prepare(
        "INSERT INTO ledger (id,attempt_id,paypal_ref_json,amount,currency,status,created_at) VALUES (@id,@attempt_id,@paypal_ref_json,@amount,@currency,@status,@created_at)",
      ).run(row);
      attempts.update(l.attempt_id, { ledger_id: row.id });
      return row;
    },
    get: (id: string) => db.prepare("SELECT * FROM ledger WHERE id = ?").get(id) as LedgerRow | undefined,
    list: (limit = 200) => db.prepare("SELECT * FROM ledger ORDER BY created_at DESC LIMIT ?").all(limit) as LedgerRow[],
    setStatus: (id: string, status: string) => db.prepare("UPDATE ledger SET status = ? WHERE id = ?").run(status, id).changes > 0,
  };

  const reconciliation = {
    create(r: { ledger_id?: string | null; paypal_event_id?: string | null; event_type?: string | null; matched: boolean; finding_type?: string | null; detail?: unknown }): ReconciliationRow {
      const row: ReconciliationRow = {
        id: newId("rec"),
        ledger_id: r.ledger_id ?? null,
        paypal_event_id: r.paypal_event_id ?? null,
        event_type: r.event_type ?? null,
        matched: r.matched ? 1 : 0,
        finding_type: r.finding_type ?? null,
        detail_json: j(r.detail ?? {}),
        ts: Date.now(),
      };
      db.prepare(
        "INSERT INTO reconciliation (id,ledger_id,paypal_event_id,event_type,matched,finding_type,detail_json,ts) VALUES (@id,@ledger_id,@paypal_event_id,@event_type,@matched,@finding_type,@detail_json,@ts)",
      ).run(row);
      return row;
    },
    list: (limit = 200) => db.prepare("SELECT * FROM reconciliation ORDER BY ts DESC LIMIT ?").all(limit) as ReconciliationRow[],
    hasEvent: (eventId: string) => !!db.prepare("SELECT 1 FROM reconciliation WHERE paypal_event_id = ?").get(eventId),
  };

  const kv = {
    get: (key: string) => (db.prepare("SELECT value FROM kv WHERE key = ?").get(key) as { value: string } | undefined)?.value,
    set: (key: string, value: string) =>
      void db.prepare("INSERT INTO kv (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value),
    delete: (key: string) => void db.prepare("DELETE FROM kv WHERE key = ?").run(key),
  };

  /** Persistent AI verdict cache. Only validated model verdicts are stored; fail-closed defaults never are. */
  const verdicts = {
    get(key: string): { verdict: unknown; model: string; created_at: number } | undefined {
      const r = db.prepare("SELECT verdict_json, model, created_at FROM ai_verdicts WHERE key = ?").get(key) as { verdict_json: string; model: string; created_at: number } | undefined;
      if (!r) return undefined;
      try {
        return { verdict: JSON.parse(r.verdict_json), model: r.model, created_at: r.created_at };
      } catch {
        return undefined; // corrupt row is treated as a miss
      }
    },
    put(key: string, verdict: unknown, model: string, now = Date.now()) {
      db.prepare(
        "INSERT INTO ai_verdicts (key,verdict_json,model,created_at,hits) VALUES (?,?,?,?,0) ON CONFLICT(key) DO UPDATE SET verdict_json = excluded.verdict_json, model = excluded.model, created_at = excluded.created_at",
      ).run(key, JSON.stringify(verdict), model, now);
    },
    touch(key: string, now = Date.now()) {
      db.prepare("UPDATE ai_verdicts SET hits = hits + 1, last_hit_at = ? WHERE key = ?").run(now, key);
    },
    count: () => (db.prepare("SELECT COUNT(*) c FROM ai_verdicts").get() as { c: number }).c,
    purgeOlderThan: (ts: number) => db.prepare("DELETE FROM ai_verdicts WHERE created_at < ?").run(ts).changes,
    clear: () => db.prepare("DELETE FROM ai_verdicts").run().changes,
  };

  return { agents, policies, payees, attempts, approvals, ledger, reconciliation, kv, verdicts };
}

export type Repos = ReturnType<typeof createRepos>;
