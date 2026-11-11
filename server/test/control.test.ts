import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { Policy, PurserEvent } from "@purser/shared";
import { startApprovalSweeper, sweepExpiredApprovals } from "../src/approvals/service.js";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { createRepos, openDb, type Repos } from "../src/db/index.js";
import { createEventBus } from "../src/events.js";
import { runPipeline, type GatewayDeps } from "../src/gateway/pipeline.js";
import { PayPalClient, type FetchLike, type UpstreamClient } from "../src/paypal/index.js";
import { defaultPolicy } from "../src/policy/defaults.js";

const ACME = "acme-supplies@personal.example.com";
const NORTHWIND = "northwind-parts@personal.example.com";
const TOKEN = "admin-token-for-tests";
const auth = { authorization: `Bearer ${TOKEN}` };

let app: FastifyInstance;
let repos: Repos;
let deps: GatewayDeps;
let events: PurserEvent[];
let payoutPosts: { headers: Record<string, string>; body: { items: { amount: { value: string }; receiver: string; sender_item_id: string }[] } }[];
let offsetMs = 0;
let failPayouts = false;
let payoutDelayMs = 0;

function boot(policyOver: Partial<Policy> = {}) {
  repos = createRepos(openDb(":memory:"));
  repos.agents.create({ id: "agent_ops_01", name: "Ops agent", apiKey: "pk_ops", mandate: "Pay vendors." });
  repos.payees.upsert({ email: ACME, display_name: "Acme Supplies", trusted: true });
  repos.payees.upsert({ email: NORTHWIND, display_name: "Northwind Parts", trusted: true });
  repos.policies.apply("agent_ops_01", { ...defaultPolicy({ agentId: "agent_ops_01", allowlist: [ACME, NORTHWIND] }), ...policyOver });
  payoutPosts = [];
  offsetMs = 0;
  failPayouts = false;
  payoutDelayMs = 0;
  events = [];
  const fetchFn: FetchLike = async (url, init) => {
    const j = (s: number, b: unknown) => new Response(JSON.stringify(b), { status: s });
    if (url.endsWith("/v1/oauth2/token")) return j(200, { access_token: "t", expires_in: 3600 });
    if (url.endsWith("/v1/payments/payouts") && init?.method === "POST") {
      if (payoutDelayMs) await new Promise((r) => setTimeout(r, payoutDelayMs));
      if (failPayouts) return j(422, { name: "INSUFFICIENT_FUNDS", message: "no funds", debug_id: "d1" });
      payoutPosts.push({ headers: init.headers as Record<string, string>, body: JSON.parse(init.body as string) });
      return j(201, { batch_header: { payout_batch_id: `BATCH${payoutPosts.length}`, batch_status: "PENDING" } });
    }
    return j(404, { name: "NOT_FOUND", message: url });
  };
  const upstream: UpstreamClient = { start: async () => [], listTools: async () => [], callTool: async () => ({ content: [{ type: "text", text: "{}" }] }), close: async () => undefined };
  const bus = createEventBus();
  bus.subscribe((e) => events.push(e));
  deps = { repos, upstream, paypal: new PayPalClient({ clientId: "c", clientSecret: "s", fetch: fetchFn, retryDelayMs: 0 }), bus, now: () => Date.now() + offsetMs };
  app = buildApp(loadConfig({ LOG_LEVEL: "silent" }), { gateway: deps, admin: { repos, llm: null, adminToken: TOKEN, gateway: deps, sseHeartbeatMs: 40 } });
}

beforeEach(() => boot());
afterEach(async () => {
  await app.close();
});

const call = async (tool: string, args: Record<string, unknown>) => {
  const res = await runPipeline(deps, "agent_ops_01", tool, args);
  return JSON.parse((res.content[0] as { text: string }).text) as Record<string, unknown>;
};
const payout = (amount: number, to = ACME) => call("purser_payout", { recipient_email: to, amount, currency: "USD", reason: "test", source: "test" });
const api = (method: "GET" | "POST", url: string, payload?: unknown, headers: Record<string, string> = auth) => app.inject({ method, url, headers, ...(payload !== undefined ? { payload: payload as object } : {}) });
const escalate160 = async (to = ACME) => {
  const r = await payout(160, to);
  expect(r.purser).toBe("pending_approval");
  return r as { attempt_id: string; approval_id: string };
};

describe("approvals: exactly once", () => {
  it("approving a $160 escalation executes the stored call once, writes the ledger and flips the attempt", async () => {
    const { attempt_id, approval_id } = await escalate160();
    expect(payoutPosts).toHaveLength(0);

    const res = await api("POST", `/api/approvals/${approval_id}/approve`);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.approval).toMatchObject({ status: "approved", result: { executed: true, payout_batch_id: "BATCH1", ledger_status: "PENDING" } });
    expect(body.result).toMatchObject({ purser: "executed", payout_batch_id: "BATCH1", amount: "160.00 USD" });

    expect(payoutPosts).toHaveLength(1);
    expect(payoutPosts[0]!.body.items[0]).toMatchObject({ receiver: ACME, amount: { value: "160.00" }, sender_item_id: attempt_id });
    expect(payoutPosts[0]!.headers["PayPal-Request-Id"]).toBe(`purser-payout-${attempt_id}`);

    const attempt = repos.attempts.get(attempt_id)!;
    expect(attempt).toMatchObject({ decision: "allow", decision_stage: "approval" });
    expect(repos.ledger.get(attempt.ledger_id!)).toMatchObject({ amount: 16000, status: "PENDING" });
    expect(repos.approvals.get(approval_id)).toMatchObject({ status: "approved", decided_by: "admin" });
    expect(events.map((e) => e.type)).toEqual(expect.arrayContaining(["approval_created", "approval_resolved"]));
  });

  it("a second approve call does not pay again", async () => {
    const { approval_id } = await escalate160();
    expect((await api("POST", `/api/approvals/${approval_id}/approve`)).statusCode).toBe(200);
    const again = await api("POST", `/api/approvals/${approval_id}/approve`);
    expect(again.statusCode).toBe(409);
    expect(again.json()).toMatchObject({ error: "already_resolved", approval: { status: "approved", result: { executed: true, payout_batch_id: "BATCH1" } } });
    expect(payoutPosts).toHaveLength(1);
  });

  it("two concurrent approvals execute exactly once", async () => {
    payoutDelayMs = 40; // keep the first execution in flight while the second arrives
    const { approval_id } = await escalate160();
    const [a, b, c] = await Promise.all([1, 2, 3].map(() => api("POST", `/api/approvals/${approval_id}/approve`)));
    const codes = [a!, b!, c!].map((r) => r.statusCode).sort();
    expect(codes).toEqual([200, 409, 409]);
    expect(payoutPosts).toHaveLength(1);
    expect(repos.ledger.list()).toHaveLength(1);
    expect(events.filter((e) => e.type === "approval_resolved")).toHaveLength(1);
  });

  it("an approved call that fails at PayPal is recorded as failed and cannot be re-approved into a double payment", async () => {
    failPayouts = true;
    const { attempt_id, approval_id } = await escalate160();
    const res = await api("POST", `/api/approvals/${approval_id}/approve`);
    expect(res.statusCode).toBe(200);
    expect(res.json().result).toMatchObject({ purser: "error" });
    expect(res.json().approval.result).toMatchObject({ executed: false, ledger_status: "failed", error: "INSUFFICIENT_FUNDS" });
    expect(repos.attempts.get(attempt_id)?.decision_stage).toBe("execute");
    failPayouts = false;
    expect((await api("POST", `/api/approvals/${approval_id}/approve`)).statusCode).toBe(409);
    expect(payoutPosts).toHaveLength(0);
  });

  it("approve does not run when the stored call cannot be replayed (truncated args)", async () => {
    // an escalated attempt whose arguments were too large to store (sanitizeArgs replaced them with a marker)
    const trunc = repos.attempts.create({ agent_id: "agent_ops_01", tool: "purser_payout", tool_class: "money_out", args: { _truncated: true, _bytes: 99999 }, amount: 16000, currency: "USD", payee_email: ACME, decision: "escalate", decision_stage: "rules" });
    const ap = repos.approvals.create({ attempt_id: trunc.id, ttlSec: 900 });
    const res = await api("POST", `/api/approvals/${ap.id}/approve`);
    expect(res.statusCode).toBe(422);
    expect(res.json().error).toBe("not_executable");
    expect(repos.approvals.get(ap.id)?.status).toBe("pending");
    expect(payoutPosts).toHaveLength(0);
  });
});

describe("approvals: guards", () => {
  it("approve on a frozen agent fails, stays pending, and works after unfreezing", async () => {
    const { approval_id } = await escalate160();
    expect((await api("POST", "/api/agents/agent_ops_01/freeze")).statusCode).toBe(200);
    const res = await api("POST", `/api/approvals/${approval_id}/approve`);
    expect(res.statusCode).toBe(423);
    expect(res.json().error).toBe("agent_frozen");
    expect(repos.approvals.get(approval_id)?.status).toBe("pending");
    expect(payoutPosts).toHaveLength(0);

    await api("POST", "/api/agents/agent_ops_01/unfreeze");
    expect((await api("POST", `/api/approvals/${approval_id}/approve`)).statusCode).toBe(200);
    expect(payoutPosts).toHaveLength(1);
  });

  it("the global freeze also blocks approval", async () => {
    const { approval_id } = await escalate160();
    await api("POST", "/api/freeze-all");
    expect((await api("POST", `/api/approvals/${approval_id}/approve`)).statusCode).toBe(423);
    expect(payoutPosts).toHaveLength(0);
  });

  it("an expired approval cannot be approved; the attempt is closed as a denial", async () => {
    const { attempt_id, approval_id } = await escalate160();
    offsetMs = 901 * 1000; // past approval_ttl_sec (900)
    const res = await api("POST", `/api/approvals/${approval_id}/approve`);
    expect(res.statusCode).toBe(410);
    expect(res.json()).toMatchObject({ error: "expired", approval: { status: "expired" } });
    expect(payoutPosts).toHaveLength(0);
    expect(repos.approvals.get(approval_id)?.status).toBe("expired");
    expect(repos.attempts.get(attempt_id)).toMatchObject({ decision: "deny", decision_stage: "approval" });
    expect(events.some((e) => e.type === "approval_resolved" && e.data.status === "expired")).toBe(true);
  });

  it("the sweeper marks expired approvals in the background and listing never shows them as pending", async () => {
    const { approval_id } = await escalate160();
    offsetMs = 1000 * 1000;
    const list = await api("GET", "/api/approvals?status=pending");
    expect(list.json().approvals).toHaveLength(0);
    expect(repos.approvals.get(approval_id)?.status).toBe("expired");

    // timer-based sweeper
    const second = await escalate160();
    offsetMs = 3_000_000;
    const stop = startApprovalSweeper(deps, 10);
    await new Promise((r) => setTimeout(r, 60));
    stop();
    expect(repos.approvals.get(second.approval_id)?.status).toBe("expired");
    expect(sweepExpiredApprovals(deps)).toBe(0); // idempotent
  });

  it("deny closes the attempt; denied approvals cannot then be approved or denied again", async () => {
    const { attempt_id, approval_id } = await escalate160();
    const d = await api("POST", `/api/approvals/${approval_id}/deny`);
    expect(d.statusCode).toBe(200);
    expect(d.json().approval.status).toBe("denied");
    expect(repos.attempts.get(attempt_id)).toMatchObject({ decision: "deny", decision_stage: "approval" });
    expect((await api("POST", `/api/approvals/${approval_id}/approve`)).statusCode).toBe(409);
    expect((await api("POST", `/api/approvals/${approval_id}/deny`)).statusCode).toBe(409);
    expect(payoutPosts).toHaveLength(0);
  });

  it("deny-level rules still apply at approval time (a human cannot approve past a spending cap)", async () => {
    const { approval_id } = await escalate160();
    // burn the daily cap with other allowed payouts after the escalation
    for (let i = 0; i < 4; i++) repos.attempts.create({ agent_id: "agent_ops_01", tool: "purser_payout", tool_class: "money_out", args: {}, amount: 10000, currency: "USD", payee_email: NORTHWIND, decision: "allow", decision_stage: "rules", ts: Date.now() - (i + 1) * 3_600_000 });
    const res = await api("POST", `/api/approvals/${approval_id}/approve`);
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: "policy_denies" });
    expect(res.json().rule_hits).toContain("daily_cap");
    expect(payoutPosts).toHaveLength(0);
    expect(repos.approvals.get(approval_id)?.status).toBe("pending");
  });

  it("unknown ids are 404 and bad input is 400", async () => {
    expect((await api("POST", "/api/approvals/apr_nope/approve")).statusCode).toBe(404);
    expect((await api("POST", "/api/approvals/apr_nope/deny")).statusCode).toBe(404);
    expect((await api("GET", "/api/approvals?status=sideways")).statusCode).toBe(400);
  });

  it("purser_check_approval reports pending, approved with a result summary, denied and expired", async () => {
    const a = await escalate160();
    const check = async (id: string) => call("purser_check_approval", { approval_id: id });
    expect(await check(a.approval_id)).toMatchObject({ purser: "approval", status: "pending" });
    await api("POST", `/api/approvals/${a.approval_id}/approve`);
    expect(await check(a.approval_id)).toMatchObject({ status: "approved", result: { executed: true, payout_batch_id: "BATCH1" } });

    const b = await escalate160();
    await api("POST", `/api/approvals/${b.approval_id}/deny`);
    expect(await check(b.approval_id)).toMatchObject({ status: "denied" });

    const c = await payout(170, NORTHWIND); // a different payee, so three payments to one vendor do not trip structuring
    offsetMs = 901 * 1000; // lazily expired even before the sweeper runs
    expect(await check((c as { approval_id: string }).approval_id)).toMatchObject({ status: "expired" });
  });

  it("the list shows pending approvals with the stored attempt for the human to judge", async () => {
    const a = await escalate160();
    const r = (await api("GET", "/api/approvals?status=pending")).json();
    expect(r.approvals).toHaveLength(1);
    expect(r.approvals[0]).toMatchObject({ approval_id: a.approval_id, status: "pending", attempt: { tool: "purser_payout", amount_display: "160.00", payee_email: ACME, reason: "test" } });
  });
});

describe("kill switch", () => {
  it("freezing the agent instantly denies the next call at stage killswitch, with a generic message", async () => {
    expect((await payout(10)).purser).toBe("executed");
    const f = await api("POST", "/api/agents/agent_ops_01/freeze");
    expect(f.json()).toMatchObject({ status: "frozen", effective_status: "frozen", freeze: { reason: "admin" } });
    const r = await payout(10);
    expect(r).toMatchObject({ purser: "denied", message: "This agent is suspended." });
    expect(repos.attempts.get(r.attempt_id as string)).toMatchObject({ decision: "deny", decision_stage: "killswitch" });
    expect(payoutPosts).toHaveLength(1);
    await api("POST", "/api/agents/agent_ops_01/unfreeze");
    expect((await payout(10)).purser).toBe("executed");
  });

  it("freeze-all and unfreeze-all are persisted and affect every agent", async () => {
    repos.agents.create({ id: "agent_two", name: "Two", apiKey: "pk_two" });
    expect((await api("POST", "/api/freeze-all")).json()).toMatchObject({ global_freeze: true, agents_frozen: 2 });
    expect(repos.kv.get("global_freeze")).toBe("1");
    expect(repos.agents.list().every((a) => a.status === "frozen")).toBe(true);
    expect((await payout(10)).purser).toBe("denied");
    const agents = (await api("GET", "/api/agents")).json();
    expect(agents.global_freeze).toBe(true);
    expect(agents.agents.every((a: { effective_status: string }) => a.effective_status === "frozen")).toBe(true);

    expect((await api("POST", "/api/unfreeze-all")).json()).toMatchObject({ global_freeze: false, agents_unfrozen: 2 });
    expect(repos.kv.get("global_freeze")).toBeUndefined();
    expect((await payout(10)).purser).toBe("executed");
  });

  it("freeze of an unknown agent is a 404 and emits nothing", async () => {
    expect((await api("POST", "/api/agents/ghost/freeze")).statusCode).toBe(404);
    expect(events.filter((e) => e.type === "agent_status")).toHaveLength(0);
  });
});

describe("circuit breaker", () => {
  beforeEach(async () => {
    await app.close();
    boot({ breaker: { max_denies: 3, window_sec: 120 } });
  });

  it("trips after N denies, freezes the agent, records why, and the next call is denied at stage killswitch", async () => {
    expect((await payout(9999)).purser).toBe("denied");
    expect((await payout(9999)).purser).toBe("denied");
    expect(repos.agents.get("agent_ops_01")?.status).toBe("active");
    expect((await payout(9999)).purser).toBe("denied"); // the 3rd deny trips it
    expect(repos.agents.get("agent_ops_01")?.status).toBe("frozen");

    const tripped = events.find((e) => e.type === "breaker_tripped");
    expect(tripped).toMatchObject({ data: { agent_id: "agent_ops_01", denies: 3, window_sec: 120 } });
    expect(events.some((e) => e.type === "agent_status" && e.data.status === "frozen")).toBe(true);

    const next = await payout(10);
    expect(next.purser).toBe("denied");
    expect(repos.attempts.get(next.attempt_id as string)).toMatchObject({ decision: "deny", decision_stage: "killswitch" });
    expect(payoutPosts).toHaveLength(0);

    // the reason is visible in dashboard data
    const agents = (await api("GET", "/api/agents")).json();
    expect(agents.agents[0].freeze).toMatchObject({ reason: "circuit_breaker", detail: { denies: 3, max_denies: 3, window_sec: 120 } });
  });

  it("kill-switch denials never count, so a frozen agent cannot re-trip the breaker; unfreezing starts clean", async () => {
    for (let i = 0; i < 3; i++) await payout(9999);
    for (let i = 0; i < 5; i++) await payout(10); // denied at killswitch
    expect(events.filter((e) => e.type === "breaker_tripped")).toHaveLength(1);
    await api("POST", "/api/agents/agent_ops_01/unfreeze");
    // old denies are still inside the window, so one more deny re-trips it: the operator must act on the cause
    expect((await payout(9999)).purser).toBe("denied");
    expect(repos.agents.get("agent_ops_01")?.status).toBe("frozen");
  });

  it("denies outside the window do not count", async () => {
    await payout(9999);
    await payout(9999);
    offsetMs = 121 * 1000;
    await payout(9999); // the first two are now older than 120s
    expect(repos.agents.get("agent_ops_01")?.status).toBe("active");
  });

  it("human approval denials do not count toward the breaker", async () => {
    for (let i = 0; i < 4; i++) {
      const e = (await payout(160 + i)) as { approval_id: string };
      await api("POST", `/api/approvals/${e.approval_id}/deny`);
    }
    expect(repos.agents.get("agent_ops_01")?.status).toBe("active");
  });
});

describe("admin API", () => {
  it("requires the admin token on every route (401), and is disabled without one (503)", async () => {
    const routes: ["GET" | "POST", string][] = [
      ["GET", "/api/attempts"], ["GET", "/api/attempts/x"], ["GET", "/api/agents"], ["POST", "/api/agents"], ["POST", "/api/agents/a/freeze"], ["POST", "/api/agents/a/unfreeze"],
      ["POST", "/api/freeze-all"], ["POST", "/api/unfreeze-all"], ["GET", "/api/policies/a"], ["GET", "/api/approvals"], ["POST", "/api/approvals/a/approve"],
      ["POST", "/api/approvals/a/deny"], ["GET", "/api/stats"], ["POST", "/api/demo/reset"], ["POST", "/api/demo/run/a"], ["GET", "/api/events"],
    ];
    for (const [m, u] of routes) {
      expect((await api(m, u, undefined, {})).statusCode, `${m} ${u}`).toBe(401);
      expect((await api(m, u, undefined, { authorization: "Bearer wrong" })).statusCode, `${m} ${u}`).toBe(401);
    }
    await app.close();
    repos = createRepos(openDb(":memory:"));
    app = buildApp(loadConfig({ LOG_LEVEL: "silent" }), { gateway: { ...deps, repos }, admin: { repos, llm: null, adminToken: undefined, gateway: { ...deps, repos } } });
    expect((await api("GET", "/api/agents")).statusCode).toBe(503);
  });

  it("lists attempts with filters, limit and full detail; unknown id is 404", async () => {
    await payout(10);
    await payout(9999, NORTHWIND);
    await escalate160();
    const all = (await api("GET", "/api/attempts")).json().attempts;
    expect(all).toHaveLength(3);
    expect((await api("GET", "/api/attempts?decision=deny")).json().attempts).toHaveLength(1);
    expect((await api("GET", "/api/attempts?agent=agent_ops_01&limit=2")).json().attempts).toHaveLength(2);
    expect((await api("GET", "/api/attempts?agent=nobody")).json().attempts).toHaveLength(0);
    expect((await api("GET", "/api/attempts?decision=maybe")).statusCode).toBe(400);
    expect((await api("GET", "/api/attempts?limit=0")).statusCode).toBe(400);

    const denied = all.find((a: { decision: string }) => a.decision === "deny");
    const one = (await api("GET", `/api/attempts/${denied.id}`)).json();
    expect(one.rule_hits_detail.map((h: { id: string }) => h.id)).toContain("per_tx_cap");
    expect(one.amount_display).toBe("9999.00");
    const esc = all.find((a: { decision: string }) => a.decision === "escalate");
    expect((await api("GET", `/api/attempts/${esc.id}`)).json().approval).toMatchObject({ status: "pending" });
    const allowed = all.find((a: { decision: string }) => a.decision === "allow");
    expect((await api("GET", `/api/attempts/${allowed.id}`)).json().ledger).toMatchObject({ status: "PENDING" });
    expect((await api("GET", "/api/attempts/att_nope")).statusCode).toBe(404);
  });

  it("creates an agent: key shown once and hashed, default policy applied, validation enforced", async () => {
    const res = await api("POST", "/api/agents", { name: "Support bot", mandate: "Issue refunds." });
    expect(res.statusCode).toBe(201);
    const { agent, api_key } = res.json();
    expect(api_key).toMatch(/^pk_/);
    expect(repos.agents.byApiKey(api_key)?.id).toBe(agent.id);
    expect(JSON.stringify(repos.agents.list())).not.toContain(api_key);
    expect(repos.policies.getActive(agent.id)?.payees).toMatchObject({ mode: "first_time_requires_approval", allowlist: [] });
    expect((await api("GET", "/api/agents")).json().agents).toHaveLength(2);
    expect((await api("POST", "/api/agents", {})).statusCode).toBe(400);
    expect((await api("POST", "/api/agents", { name: "" })).statusCode).toBe(400);
  });

  it("GET /api/policies/:agentId returns the active policy and version history", async () => {
    const r = (await api("GET", "/api/policies/agent_ops_01")).json();
    expect(r.active.agent_id).toBe("agent_ops_01");
    expect(r.history).toHaveLength(1);
    expect((await api("GET", "/api/policies/ghost")).statusCode).toBe(404);
  });

  it("stats: spend today, blocked count and amount, pending approvals, frozen agents", async () => {
    await payout(120);
    await payout(9999, NORTHWIND);
    await escalate160();
    const s = (await api("GET", "/api/stats")).json();
    expect(s).toMatchObject({ window: "today", spend_today_minor: 12000, spend_today: "120.00", blocked_count: 1, blocked_amount_minor: 999900, blocked_amount: "9999.00", pending_approvals: 1, agents_frozen: 0, global_freeze: false });
    await api("POST", "/api/agents/agent_ops_01/freeze");
    expect((await api("GET", "/api/stats")).json().agents_frozen).toBe(1);
  });

  it("stats do not count failed executions as spend", async () => {
    failPayouts = true;
    await payout(120);
    expect((await api("GET", "/api/stats")).json().spend_today_minor).toBe(0);
  });

  it("demo reset wipes runtime data, unfreezes everything, restores the seeded policy, keeps the verdict cache", async () => {
    await payout(120);
    await escalate160();
    repos.verdicts.put("k1", { verdict: "allow", risk: 1, rationale: "x", flags: [] }, "m");
    repos.policies.apply("agent_ops_01", { ...repos.policies.getActive("agent_ops_01")!, limits: { per_tx_cap: 1, daily_cap: 1, weekly_cap: 1, monthly_cap: 1 } });
    await api("POST", "/api/freeze-all");

    const r = (await api("POST", "/api/demo/reset")).json();
    expect(r).toMatchObject({ attempts_cleared: 2, policy_restored: true });
    expect(repos.attempts.list()).toHaveLength(0);
    expect(repos.approvals.list()).toHaveLength(0);
    expect(repos.ledger.list()).toHaveLength(0);
    expect(repos.agents.list().every((a) => a.status === "active")).toBe(true);
    expect(repos.kv.get("global_freeze")).toBeUndefined();
    expect(repos.policies.getActive("agent_ops_01")?.limits.per_tx_cap).toBe(200);
    expect(repos.verdicts.count()).toBe(1);
    expect((await payout(120)).purser).toBe("executed");

    // a second reset with an already-seeded policy does not create a new version
    const v = repos.policies.history("agent_ops_01").length;
    expect((await api("POST", "/api/demo/reset")).json().policy_restored).toBe(false);
    expect(repos.policies.history("agent_ops_01")).toHaveLength(v);
  });

  it("Attack Lab runs are not implemented yet and say so", async () => {
    expect((await api("POST", "/api/demo/run/A")).statusCode).toBe(501);
  });
});

describe("SSE /api/events", () => {
  let base: string;
  beforeEach(async () => {
    await app.listen({ port: 0, host: "127.0.0.1" });
    const addr = app.server.address();
    base = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
  });

  /** Read the stream until `until(text)` is true or the timeout passes. */
  async function collect(url: string, headers: Record<string, string>, trigger: () => Promise<unknown>, until: (t: string) => boolean, timeoutMs = 3000) {
    const ac = new AbortController();
    const res = await fetch(url, { headers, signal: ac.signal });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/event-stream/);
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    let text = "";
    const reading = (async () => {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        text += dec.decode(value);
        if (until(text)) return;
      }
    })();
    await new Promise((r) => setTimeout(r, 50));
    await trigger();
    await Promise.race([reading, new Promise((r) => setTimeout(r, timeoutMs))]);
    ac.abort();
    return text;
  }
  const parse = (text: string) => [...text.matchAll(/event: (\w+)\ndata: (.*)\n\n/g)].map((m) => ({ type: m[1]!, data: JSON.parse(m[2]!) }));

  it("emits attempt, approval_created, approval_resolved and agent_status for real calls", async () => {
    let approvalId = "";
    const text = await collect(
      `${base}/api/events`,
      auth,
      async () => {
        await payout(10);
        approvalId = ((await escalate160()) as { approval_id: string }).approval_id;
        await api("POST", `/api/approvals/${approvalId}/approve`);
        await api("POST", "/api/agents/agent_ops_01/freeze");
      },
      (t) => t.includes("event: agent_status"),
    );
    const evs = parse(text);
    const types = evs.map((e) => e.type);
    expect(types).toEqual(expect.arrayContaining(["attempt", "approval_created", "approval_resolved", "agent_status"]));
    const first = evs.find((e) => e.type === "attempt")!;
    expect(first.data).toMatchObject({ tool: "purser_payout", decision: "allow", agent_id: "agent_ops_01" });
    expect(evs.find((e) => e.type === "approval_resolved")!.data).toMatchObject({ approval_id: approvalId, status: "approved", decided_by: "admin" });
    expect(evs.find((e) => e.type === "agent_status")!.data).toEqual({ agent_id: "agent_ops_01", status: "frozen" });
  });

  it("emits breaker_tripped", async () => {
    await app.close();
    boot({ breaker: { max_denies: 2, window_sec: 60 } });
    await app.listen({ port: 0, host: "127.0.0.1" });
    const addr = app.server.address();
    const b = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
    const text = await collect(`${b}/api/events`, auth, async () => void (await payout(9999), await payout(9999)), (t) => t.includes("event: breaker_tripped"));
    expect(parse(text).find((e) => e.type === "breaker_tripped")!.data).toMatchObject({ agent_id: "agent_ops_01", denies: 2, window_sec: 60 });
  });

  it("accepts the token as a ?token= query parameter (EventSource) and rejects bad ones", async () => {
    const text = await collect(`${base}/api/events?token=${TOKEN}`, {}, async () => void (await payout(10)), (t) => t.includes("event: attempt"));
    expect(text).toContain("event: attempt");
    expect((await fetch(`${base}/api/events?token=wrong`)).status).toBe(401);
    expect((await fetch(`${base}/api/events`)).status).toBe(401);
    // the query token is only for the SSE endpoint
    expect((await fetch(`${base}/api/agents?token=${TOKEN}`)).status).toBe(401);
  });

  it("sends heartbeats", async () => {
    const text = await collect(`${base}/api/events`, auth, async () => undefined, (t) => (t.match(/: heartbeat/g) ?? []).length >= 2);
    expect((text.match(/: heartbeat/g) ?? []).length).toBeGreaterThanOrEqual(2);
  });

  it("closing the server ends open streams instead of hanging", async () => {
    const res = await fetch(`${base}/api/events`, { headers: auth });
    const reader = res.body!.getReader();
    await reader.read();
    const closed = app.close();
    await expect(Promise.race([closed.then(() => "closed"), new Promise((r) => setTimeout(() => r("hung"), 3000))])).resolves.toBe("closed");
    await reader.cancel().catch(() => undefined);
    boot(); // afterEach closes the app again
  });
});
