import type Database from "better-sqlite3";

/** Ordered, append-only migrations. Money columns hold integer minor units (cents). Timestamps are epoch ms. */
export const MIGRATIONS: { id: number; name: string; sql: string }[] = [
  {
    id: 1,
    name: "initial_schema",
    sql: `
      CREATE TABLE agents (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        api_key_hash TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','frozen')),
        mandate TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL
      );

      CREATE TABLE policies (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL REFERENCES agents(id),
        version INTEGER NOT NULL,
        json TEXT NOT NULL,
        source_text TEXT,
        active INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        UNIQUE (agent_id, version)
      );
      CREATE UNIQUE INDEX policies_one_active ON policies(agent_id) WHERE active = 1;

      CREATE TABLE payees (
        id TEXT PRIMARY KEY,
        email TEXT NOT NULL UNIQUE,
        display_name TEXT,
        domain TEXT NOT NULL,
        first_seen_at INTEGER NOT NULL,
        trusted INTEGER NOT NULL DEFAULT 0,
        notes TEXT
      );

      CREATE TABLE attempts (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL REFERENCES agents(id),
        ts INTEGER NOT NULL,
        tool TEXT NOT NULL,
        tool_class TEXT NOT NULL,
        args_json TEXT NOT NULL,
        amount INTEGER,
        currency TEXT,
        payee_email TEXT,
        reason TEXT,
        source TEXT,
        decision TEXT NOT NULL CHECK (decision IN ('allow','deny','escalate')),
        decision_stage TEXT NOT NULL,
        rule_hits_json TEXT NOT NULL DEFAULT '[]',
        signals_json TEXT NOT NULL DEFAULT '[]',
        ai_json TEXT,
        approval_id TEXT,
        upstream_result_json TEXT,
        ledger_id TEXT,
        latency_ms INTEGER
      );
      CREATE INDEX attempts_agent_ts ON attempts(agent_id, ts);

      CREATE TABLE approvals (
        id TEXT PRIMARY KEY,
        attempt_id TEXT NOT NULL REFERENCES attempts(id),
        status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','denied','expired')),
        channel TEXT,
        decided_by TEXT,
        decided_at INTEGER,
        expires_at INTEGER NOT NULL
      );
      CREATE INDEX approvals_status ON approvals(status);

      CREATE TABLE ledger (
        id TEXT PRIMARY KEY,
        attempt_id TEXT NOT NULL REFERENCES attempts(id),
        paypal_ref_json TEXT NOT NULL DEFAULT '{}',
        amount INTEGER,
        currency TEXT,
        status TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE reconciliation (
        id TEXT PRIMARY KEY,
        ledger_id TEXT REFERENCES ledger(id),
        paypal_event_id TEXT,
        event_type TEXT,
        matched INTEGER NOT NULL DEFAULT 0,
        finding_type TEXT,
        detail_json TEXT NOT NULL DEFAULT '{}',
        ts INTEGER NOT NULL
      );

      CREATE TABLE kv (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `,
  },
  {
    id: 2,
    name: "ai_verdict_cache",
    sql: `
      CREATE TABLE ai_verdicts (
        key TEXT PRIMARY KEY,
        verdict_json TEXT NOT NULL,
        model TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        last_hit_at INTEGER,
        hits INTEGER NOT NULL DEFAULT 0
      );
    `,
  },
];

export function migrate(db: Database.Database): number[] {
  db.exec("CREATE TABLE IF NOT EXISTS _migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL)");
  const applied = new Set(
    (db.prepare("SELECT id FROM _migrations").all() as { id: number }[]).map((r) => r.id),
  );
  const ran: number[] = [];
  for (const m of MIGRATIONS) {
    if (applied.has(m.id)) continue;
    db.transaction(() => {
      db.exec(m.sql);
      db.prepare("INSERT INTO _migrations (id, name, applied_at) VALUES (?, ?, ?)").run(m.id, m.name, Date.now());
    })();
    ran.push(m.id);
  }
  return ran;
}
