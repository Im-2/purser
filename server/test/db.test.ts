import { beforeEach, describe, expect, it } from "vitest";
import { openDb, createRepos, hashApiKey, migrate, type Db, type Repos } from "../src/db/index.js";
import { MIGRATIONS } from "../src/db/migrations.js";
import { defaultPolicy } from "../src/policy/defaults.js";
import { evaluateRules } from "../src/policy/rules.js";

let db: Db;
let repos: Repos;
beforeEach(() => {
  db = openDb(":memory:");
  repos = createRepos(db);
});

const agent = () => repos.agents.create({ id: "agent_t", name: "T", apiKey: "pk_secret_value", mandate: "m" });

describe("migrations", () => {
  it("creates every SPEC section 7 table", () => {
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map((t) => t.name);
    for (const t of ["agents", "policies", "payees", "attempts", "approvals", "ledger", "reconciliation", "kv"]) expect(tables).toContain(t);
  });
  it("is idempotent", () => {
    expect(migrate(db)).toEqual([]);
    expect((db.prepare("SELECT COUNT(*) c FROM _migrations").get() as { c: number }).c).toBe(MIGRATIONS.length);
  });
});

describe("agents", () => {
  it("stores only a hash of the API key and looks up by key", () => {
    const a = agent();
    expect(a.api_key_hash).toBe(hashApiKey("pk_secret_value"));
    expect(JSON.stringify(db.prepare("SELECT * FROM agents").all())).not.toContain("pk_secret_value");
    expect(repos.agents.byApiKey("pk_secret_value")?.id).toBe("agent_t");
    expect(repos.agents.byApiKey("wrong")).toBeUndefined();
  });
  it("freeze and unfreeze, per agent and globally", () => {
    agent();
    expect(repos.agents.setStatus("agent_t", "frozen")).toBe(true);
    expect(repos.agents.get("agent_t")?.status).toBe("frozen");
    expect(repos.agents.setAllStatus("active")).toBe(1);
    expect(repos.agents.get("agent_t")?.status).toBe("active");
    expect(repos.agents.setStatus("nope", "frozen")).toBe(false);
  });
});

describe("policies", () => {
  it("versions, keeps history, and allows exactly one active", () => {
    agent();
    const p = defaultPolicy({ agentId: "agent_t", allowlist: ["a@x.com"] });
    expect(repos.policies.apply("agent_t", p, "first").version).toBe(1);
    const second = repos.policies.apply("agent_t", { ...p, limits: { ...p.limits, per_tx_cap: 50 } }, "second");
    expect(second.version).toBe(2);
    expect(repos.policies.getActive("agent_t")?.limits.per_tx_cap).toBe(50);
    const hist = repos.policies.history("agent_t");
    expect(hist.map((h) => [h.version, h.active])).toEqual([[2, 1], [1, 0]]);
  });
  it("rejects an invalid policy and the database enforces one active row", () => {
    agent();
    const p = defaultPolicy({ agentId: "agent_t", allowlist: [] });
    expect(() => repos.policies.apply("agent_t", { ...p, limits: { ...p.limits, per_tx_cap: -1 } })).toThrow();
    repos.policies.apply("agent_t", p);
    expect(() => db.prepare("INSERT INTO policies (id,agent_id,version,json,active,created_at) VALUES ('x','agent_t',99,'{}',1,1)").run()).toThrow();
  });
});

describe("payees", () => {
  it("normalizes email, derives domain, upserts", () => {
    const p = repos.payees.upsert({ email: " Acme@Personal.Example.com ", display_name: "Acme" });
    expect(p.email).toBe("acme@personal.example.com");
    expect(p.domain).toBe("personal.example.com");
    const again = repos.payees.upsert({ email: "ACME@personal.example.com", trusted: true });
    expect(again.id).toBe(p.id);
    expect(again.trusted).toBe(1);
    expect(again.display_name).toBe("Acme");
    expect(repos.payees.list()).toHaveLength(1);
  });
});

describe("attempts, approvals, ledger, reconciliation, kv", () => {
  const base = { agent_id: "agent_t", tool: "purser_payout", tool_class: "money_out" as const, args: { a: 1 }, amount: 12000, currency: "USD", payee_email: "A@X.com", decision: "allow" as const, decision_stage: "rules" };

  it("round-trips an attempt and stores money as integer minor units", () => {
    agent();
    const a = repos.attempts.create({ ...base, rule_hits: [{ id: "x" }], signals: ["first_time_payee"], ai: { verdict: "allow" } });
    const got = repos.attempts.get(a.id)!;
    expect(got.amount).toBe(12000);
    expect(got.payee_email).toBe("a@x.com");
    expect(JSON.parse(got.rule_hits_json)).toEqual([{ id: "x" }]);
    expect(JSON.parse(got.ai_json as string)).toEqual({ verdict: "allow" });
  });
  it("rejects invalid decision values", () => {
    agent();
    expect(() => repos.attempts.create({ ...base, decision: "maybe" as never })).toThrow();
  });
  it("lists newest first with filters and a bounded limit", () => {
    agent();
    repos.attempts.create({ ...base, ts: 1000 });
    repos.attempts.create({ ...base, ts: 2000, decision: "deny" });
    repos.attempts.create({ ...base, ts: 3000 });
    expect(repos.attempts.list().map((x) => x.ts)).toEqual([3000, 2000, 1000]);
    expect(repos.attempts.list({ decision: "deny" })).toHaveLength(1);
    expect(repos.attempts.list({ limit: 1 })).toHaveLength(1);
  });
  it("feeds the rule engine through history()", () => {
    agent();
    const now = 10_000_000;
    repos.attempts.create({ ...base, ts: now - 1000, amount: 45000 });
    repos.attempts.create({ ...base, ts: now - 2000, amount: 4000, decision: "deny" });
    repos.attempts.create({ ...base, ts: now - 999999999, amount: 99999 });
    const history = repos.attempts.history("agent_t", now - 86_400_000);
    expect(history).toHaveLength(2);
    const p = defaultPolicy({ agentId: "agent_t", allowlist: ["a@x.com"] });
    const r = evaluateRules({
      call: { toolClass: "money_out", tool: "purser_payout", amountMinor: 10000, currency: "USD", payeeEmail: "a@x.com" },
      policy: p,
      history,
      nowMs: now,
    });
    expect(r.hits.map((h) => h.id)).toContain("daily_cap"); // 450 + 100 > 500
  });
  it("approvals resolve once, link to the attempt, and are idempotent", () => {
    agent();
    const a = repos.attempts.create({ ...base, decision: "escalate" });
    const ap = repos.approvals.create({ attempt_id: a.id, ttlSec: 900, channel: "web" });
    expect(repos.attempts.get(a.id)?.approval_id).toBe(ap.id);
    expect(repos.approvals.list("pending")).toHaveLength(1);
    expect(repos.approvals.resolve(ap.id, "approved", "admin")).toBe(true);
    expect(repos.approvals.resolve(ap.id, "denied", "admin")).toBe(false);
    expect(repos.approvals.get(ap.id)?.status).toBe("approved");
  });
  it("ledger links back to the attempt", () => {
    agent();
    const a = repos.attempts.create(base);
    const l = repos.ledger.create({ attempt_id: a.id, paypal_ref: { batch: "B1" }, amount: 12000, currency: "USD", status: "executed" });
    expect(repos.attempts.get(a.id)?.ledger_id).toBe(l.id);
    expect(repos.ledger.setStatus(l.id, "SUCCESS")).toBe(true);
    expect(repos.ledger.get(l.id)?.status).toBe("SUCCESS");
  });
  it("reconciliation rows and dedupe lookups", () => {
    const r = repos.reconciliation.create({ paypal_event_id: "WH-1", event_type: "PAYMENT.PAYOUTS-ITEM.SUCCEEDED", matched: false, finding_type: "unrecorded_movement", detail: { x: 1 } });
    expect(r.matched).toBe(0);
    expect(repos.reconciliation.hasEvent("WH-1")).toBe(true);
    expect(repos.reconciliation.hasEvent("WH-2")).toBe(false);
  });
  it("kv get/set/overwrite/delete", () => {
    expect(repos.kv.get("freeze")).toBeUndefined();
    repos.kv.set("freeze", "1");
    repos.kv.set("freeze", "0");
    expect(repos.kv.get("freeze")).toBe("0");
    repos.kv.delete("freeze");
    expect(repos.kv.get("freeze")).toBeUndefined();
  });
  it("clearAll wipes runtime data but keeps agents and policies", () => {
    agent();
    repos.policies.apply("agent_t", defaultPolicy({ agentId: "agent_t", allowlist: [] }));
    const a = repos.attempts.create(base);
    repos.approvals.create({ attempt_id: a.id, ttlSec: 1 });
    repos.ledger.create({ attempt_id: a.id, amount: 1, currency: "USD", status: "x" });
    repos.attempts.clearAll();
    expect(repos.attempts.list()).toHaveLength(0);
    expect(repos.approvals.list()).toHaveLength(0);
    expect(repos.agents.list()).toHaveLength(1);
    expect(repos.policies.getActive("agent_t")).toBeDefined();
  });
});
