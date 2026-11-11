import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { ensureSeeded } from "../src/bootstrap.js";
import { loadConfig } from "../src/config.js";
import { createRepos, openDb, type Repos } from "../src/db/index.js";
import { createEventBus } from "../src/events.js";
import { DemoWorlds } from "../src/demo/worlds.js";
import { DEMO_ALLOWED, demoAllows } from "../src/demo/routes.js";
import { DisabledUpstream } from "../src/paypal/index.js";
import type { Reviewer } from "../src/ai/reviewer.js";

const ADMIN = "admin-token-for-tests-0123456789";
const ACME = "acme@example.test";
const NORTHWIND = "northwind@example.test";

/** Stands in for the shipped verdict cache (its keys depend on the real vendor emails): look-alike calls escalate, the rest pass. */
const stubReviewer = (): Reviewer => ({
  mode: "cached_only",
  keyFor: () => "k",
  review: async (i) => ({ verdict: i.signals.some((s) => s.id === "lookalike_payee") ? "escalate" : "allow", risk: 10, rationale: "stub", flags: [], model: "stub", cached: true }),
});

let main: FastifyInstance;
let base: string;
let mainRepos: Repos;
let worlds: DemoWorlds;
const outbound: string[] = [];
const realFetch = globalThis.fetch;

beforeAll(async () => {
  // record every outbound request: a demo session may only ever talk to loopback (the world's own listener and the main server)
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    outbound.push(String(input instanceof Request ? input.url : input));
    return realFetch(input, init);
  });
  const config = loadConfig({ LOG_LEVEL: "silent", NODE_ENV: "production", PUBLIC_URL: "https://purser.test", VENDOR_ACME_EMAIL: ACME, VENDOR_NORTHWIND_EMAIL: NORTHWIND, PURSER_ADMIN_TOKEN: ADMIN, AGENT_API_KEY: "pk_main_agent_key_value" });
  mainRepos = createRepos(openDb(":memory:"));
  ensureSeeded(mainRepos, { acme: ACME, northwind: NORTHWIND, agentKey: "pk_main_agent_key_value" });
  const gateway = { repos: mainRepos, upstream: new DisabledUpstream(), paypal: null, bus: createEventBus() };
  worlds = new DemoWorlds({ config, upstreamTools: () => [], ttlMs: 3_600_000, maxSessions: 10, makeReviewer: stubReviewer });
  main = buildApp(config, { gateway, admin: { repos: mainRepos, llm: null, adminToken: ADMIN, gateway }, demoSessions: { worlds, perIpLimit: 100, globalLimit: 1000 } });
  await main.listen({ port: 0, host: "127.0.0.1" });
  base = `http://127.0.0.1:${(main.server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await worlds.closeAll();
  await main.close();
  vi.restoreAllMocks();
});
afterEach(() => undefined);

const call = (token: string, method: string, path: string, body?: unknown) =>
  realFetch(base + path, { method, headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
const startSession = async (ip = "203.0.113.1") => {
  const r = await realFetch(base + "/api/demo-session", { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": ip }, body: "{}" });
  return { status: r.status, body: (await r.json()) as { token: string; role: string; mode: string; expires_at: string; ttl_sec: number }, headers: r.headers };
};
async function runScenario(token: string, id: string) {
  const r = await call(token, "POST", `/api/demo/run/${id}`, { mode: "replay", reset: true });
  expect(r.status).toBe(202);
  for (let i = 0; i < 300; i++) {
    const s = (await (await call(token, "GET", "/api/demo/status")).json()) as { running: unknown; last: { scenario: string; decisions: string[]; agent_frozen: boolean; error?: string } | null };
    if (!s.running && s.last?.scenario === id) return s.last;
    await new Promise((res) => setTimeout(res, 100));
  }
  throw new Error(`scenario ${id} did not finish`);
}

describe("the demo session", () => {
  it("needs no credentials and returns an unguessable, expiring token", async () => {
    const a = await startSession("198.51.100.1");
    const b = await startSession("198.51.100.2");
    expect(a.status).toBe(201);
    expect(a.body).toMatchObject({ role: "demo", mode: "replay", ttl_sec: 3600 });
    expect(a.body.token).toMatch(/^dm_[A-Za-z0-9_-]{40,}$/);
    expect(a.body.token).not.toBe(b.body.token);
    expect(Date.parse(a.body.expires_at) - Date.now()).toBeGreaterThan(3_500_000);
    expect(Date.parse(a.body.expires_at) - Date.now()).toBeLessThanOrEqual(3_600_000);
  });

  it("is rate limited per client address, and the limit does not block other clients", async () => {
    const config = loadConfig({ LOG_LEVEL: "silent", VENDOR_ACME_EMAIL: ACME, VENDOR_NORTHWIND_EMAIL: NORTHWIND });
    const w = new DemoWorlds({ config, upstreamTools: () => [], ttlMs: 60_000, maxSessions: 10, makeReviewer: stubReviewer });
    const app = buildApp(config, { demoSessions: { worlds: w, perIpLimit: 2, globalLimit: 100 } });
    const post = (ip: string) => app.inject({ method: "POST", url: "/api/demo-session", headers: { "x-forwarded-for": ip } });
    expect((await post("192.0.2.10")).statusCode).toBe(201);
    expect((await post("192.0.2.10")).statusCode).toBe(201);
    const limited = await post("192.0.2.10");
    expect(limited.statusCode).toBe(429);
    expect(Number(limited.headers["retry-after"])).toBeGreaterThan(0);
    expect((await post("192.0.2.11")).statusCode).toBe(201);
    await w.closeAll();
    await app.close();
  });

  it("caps the number of live sessions: the oldest makes room", async () => {
    const config = loadConfig({ LOG_LEVEL: "silent", VENDOR_ACME_EMAIL: ACME, VENDOR_NORTHWIND_EMAIL: NORTHWIND });
    const w = new DemoWorlds({ config, upstreamTools: () => [], ttlMs: 60_000, maxSessions: 2, makeReviewer: stubReviewer });
    const first = await w.create();
    await w.create();
    await w.create();
    expect(w.size).toBe(2);
    expect(w.get(first.token)).toBeUndefined();
    await w.closeAll();
  });

  it("expires: an expired token is gone, and the proxy answers 401", async () => {
    let t = 1_000_000;
    const config = loadConfig({ LOG_LEVEL: "silent", VENDOR_ACME_EMAIL: ACME, VENDOR_NORTHWIND_EMAIL: NORTHWIND });
    const w = new DemoWorlds({ config, upstreamTools: () => [], ttlMs: 60_000, maxSessions: 5, now: () => t, makeReviewer: stubReviewer });
    const world = await w.create();
    expect(w.get(world.token)).toBeDefined();
    t += 60_001;
    expect(w.get(world.token)).toBeUndefined();
    await w.closeAll();
    const r = await call("dm_" + "x".repeat(43), "GET", "/api/stats");
    expect(r.status).toBe(401);
  });
});

describe("what a demo token may and may not do (enforced on the server)", () => {
  it("can view the whole dashboard", async () => {
    const { body } = await startSession("203.0.113.20");
    for (const p of ["/api/stats", "/api/agents", "/api/attempts", "/api/approvals", "/api/policies/agent_ops_01", "/api/reconciliation", "/api/demo/status"]) {
      const r = await call(body.token, "GET", p);
      expect(r.status, p).toBe(200);
    }
  });

  it("can open the event stream with the token in the query string", async () => {
    const { body } = await startSession("203.0.113.21");
    const ctrl = new AbortController();
    const r = await realFetch(`${base}/api/events?token=${body.token}`, { signal: ctrl.signal });
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toMatch(/text\/event-stream/);
    const chunk = await r.body!.getReader().read();
    expect(new TextDecoder().decode(chunk.value)).toContain("connected");
    ctrl.abort();
  });

  // every admin or PayPal-touching endpoint, plus unknown paths and wrong methods: all must be 403 for a demo token
  const FORBIDDEN: [string, string, unknown?][] = [
    ["POST", "/api/policies/compile", { agent_id: "agent_ops_01", text: "Allow up to $1 a day" }],
    ["POST", "/api/policies/apply", { agent_id: "agent_ops_01", policy: {} }],
    ["POST", "/api/agents", { name: "x" }],
    ["POST", "/api/reconciliation/run", {}],
    ["POST", "/api/dev/simulate-webhook", {}],
    ["POST", "/api/demo/run/A", { mode: "live", reset: true }],
    ["POST", "/api/demo/run/E", { mode: "replay" }],
    ["POST", "/api/webhooks/paypal", {}],
    ["GET", "/api/nope"],
    ["GET", "/api/agents/agent_ops_01"],
    ["GET", "/api/stats?token=dm_whatever"],
    ["DELETE", "/api/agents/agent_ops_01"],
    ["PUT", "/api/policies/agent_ops_01", {}],
    ["GET", "/api/policies/agent_ops_01/versions"],
  ];
  it.each(FORBIDDEN)("%s %s is 403", async (method, path, body) => {
    const { body: s } = await startSession("203.0.113.22");
    const r = await call(s.token, method, path, body);
    expect(r.status).toBe(403);
    expect(((await r.json()) as { error: string }).error).toBe("demo_forbidden");
  });

  it("the allowlist is exactly what is documented (a new route is refused until someone adds it)", () => {
    expect(DEMO_ALLOWED.length).toBe(14);
    expect(demoAllows("POST", "/api/policies/apply")).toBe(false);
    expect(demoAllows("POST", "/api/reconciliation/run")).toBe(false);
    expect(demoAllows("GET", "/api/stats")).toBe(true);
  });

  it("a demo token cannot reach /mcp (agent keys only), and a made-up token is 401", async () => {
    const { body } = await startSession("203.0.113.23");
    const r = await call(body.token, "POST", "/mcp", { jsonrpc: "2.0", id: 1, method: "tools/list" });
    expect(r.status).toBe(401);
    expect((await call("dm_" + "y".repeat(43), "GET", "/api/stats")).status).toBe(401);
  });

  it("the admin token is unchanged: full access to the real admin API", async () => {
    expect((await call(ADMIN, "GET", "/api/stats")).status).toBe(200);
    const apply = await call(ADMIN, "POST", "/api/policies/apply", { agent_id: "agent_ops_01", policy: { nope: true } });
    expect(apply.status).toBe(400); // reached the real route (validation), not a 403
    expect((await call(ADMIN, "POST", "/api/reconciliation/run", {})).status).toBe(200);
    expect((await call("wrong-token", "GET", "/api/stats")).status).toBe(401);
  });
});

describe("replay in a demo session", () => {
  it("runs A, B, C and D with simulated PayPal and the cached-only reviewer, and touches nothing real", async () => {
    const { body } = await startSession("203.0.113.30");
    const before = { attempts: mainRepos.attempts.list({ limit: 100 }).length, active: mainRepos.policies.getActive("agent_ops_01")?.version };
    const world = worlds.get(body.token)!;

    const d = await runScenario(body.token, "D");
    expect(d.error).toBeUndefined();
    expect(d.decisions).toEqual(["allow"]);
    expect(world.sim.calls.some((c) => c.method === "POST" && c.path === "/v1/payments/payouts")).toBe(true);

    const a = await runScenario(body.token, "A");
    expect(a.decisions).toEqual(["escalate"]);

    const b = await runScenario(body.token, "B");
    expect(b.error).toBeUndefined();
    expect(b.decisions).toContain("deny");

    const c = await runScenario(body.token, "C");
    expect(c.error).toBeUndefined();
    expect(c.decisions).toContain("deny");
    expect(c.agent_frozen).toBe(true);

    // the simulator answered everything it was asked, and nothing was refused as "not modelled"
    expect(world.sim.unexpected).toEqual([]);
    // no request left the machine: every outbound request in the whole test run is to loopback (no PayPal, no model provider)
    const hosts = new Set(outbound.map((u) => new URL(u).hostname));
    expect([...hosts].every((h) => h === "127.0.0.1" || h === "localhost")).toBe(true);
    expect(outbound.some((u) => /paypal|groq|openai|anthropic/i.test(u))).toBe(false);
    // the real system did not change
    expect(mainRepos.attempts.list({ limit: 100 }).length).toBe(before.attempts);
    expect(mainRepos.policies.getActive("agent_ops_01")?.version).toBe(before.active);
    expect(mainRepos.ledger.list(100)).toHaveLength(0);
  }, 90_000);

  it("a demo token cannot approve a real pending approval: ids from the real system do not exist in its world", async () => {
    const { body } = await startSession("203.0.113.31");
    const r = await call(body.token, "POST", "/api/approvals/apr_real_one/approve", {});
    expect(r.status).toBe(404);
  });

  it("two sessions are isolated, and a reset in one leaves the other alone", async () => {
    const one = (await startSession("203.0.113.40")).body.token;
    const two = (await startSession("203.0.113.41")).body.token;
    await runScenario(one, "D");
    const attempts = async (t: string) => ((await (await call(t, "GET", "/api/attempts?limit=50")).json()) as { attempts: { tool_class: string }[] }).attempts.filter((a) => a.tool_class !== "read");
    expect((await attempts(one)).length).toBe(1);
    expect((await attempts(two)).length).toBe(0);
    await call(two, "POST", "/api/demo/reset", {});
    expect((await attempts(one)).length).toBe(1);
    const stats = async (t: string) => ((await (await call(t, "GET", "/api/stats")).json()) as { spend_today_minor: number }).spend_today_minor;
    expect(await stats(one)).toBeGreaterThan(0);
    expect(await stats(two)).toBe(0);
  }, 60_000);
});
