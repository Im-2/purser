import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { PurserEvent } from "@purser/shared";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { createRepos, openDb, type Repos } from "../src/db/index.js";
import { createEventBus } from "../src/events.js";
import { GLOBAL_FREEZE_KEY, sanitizeArgs, splitMeta, tighten, type GatewayDeps } from "../src/gateway/pipeline.js";
import { withReasonAndSource } from "../src/gateway/tools.js";
import { PayPalClient, type FetchLike, type UpstreamClient, type UpstreamResult, type UpstreamTool } from "../src/paypal/index.js";
import { defaultPolicy } from "../src/policy/defaults.js";

const ACME = "acme@personal.example.com";
const STRANGER = "stranger@personal.example.com";
const KEY_A = "pk_test_agent_a";
const KEY_B = "pk_test_agent_b";

const UPSTREAM_TOOLS: UpstreamTool[] = [
  { name: "list_invoices", description: "List invoices", inputSchema: { type: "object", properties: { page: { type: "number" } } } },
  { name: "create_order", description: "Create an order", inputSchema: { type: "object", properties: { items: { type: "array" } }, required: ["items"] } },
  { name: "create_refund", description: "Refund a capture", inputSchema: { type: "object", properties: { capture_id: { type: "string" }, amount: { type: "object" } } } },
  { name: "pay_order", description: "Capture an order", inputSchema: { type: "object", properties: { order_id: { type: "string" } } } },
  { name: "send_invoice", description: "Send an invoice", inputSchema: { type: "object", properties: { invoice_id: { type: "string" } } } },
  { name: "update_product", description: "Update a product (unclassified)", inputSchema: { type: "object", properties: {} } },
  { name: "cancel_subscription", description: "Cancel a subscription (unclassified)", inputSchema: { type: "object", properties: {} } },
];

class FakeUpstream implements UpstreamClient {
  calls: { name: string; args: Record<string, unknown> }[] = [];
  failWith: Error | null = null;
  async start() {
    return UPSTREAM_TOOLS;
  }
  async listTools() {
    return UPSTREAM_TOOLS;
  }
  async callTool(name: string, args: Record<string, unknown>): Promise<UpstreamResult> {
    this.calls.push({ name, args });
    if (this.failWith) throw this.failWith;
    return { content: [{ type: "text", text: JSON.stringify({ ok: true, tool: name }) }] };
  }
  async close() {}
}

interface PayPalMock {
  fn: FetchLike;
  payoutPosts: { url: string; headers: Record<string, string>; body: Record<string, unknown> }[];
  capture: { status: number; body: unknown };
}
function mockPayPal(): PayPalMock {
  const m: PayPalMock = {
    payoutPosts: [],
    capture: { status: 200, body: { id: "CAPTURE12345", status: "COMPLETED", amount: { value: "30.00", currency_code: "USD" } } },
    fn: async (url, init) => {
      const json = (status: number, b: unknown) => new Response(JSON.stringify(b), { status });
      if (url.endsWith("/v1/oauth2/token")) return json(200, { access_token: "tok", expires_in: 32400 });
      if (url.endsWith("/v1/payments/payouts") && init?.method === "POST") {
        m.payoutPosts.push({ url, headers: init.headers as Record<string, string>, body: JSON.parse(init.body as string) });
        return json(201, { batch_header: { payout_batch_id: "BATCH1", batch_status: "PENDING" } });
      }
      if (url.includes("/v2/payments/captures/")) return json(m.capture.status, m.capture.body);
      return json(404, { name: "NOT_FOUND", message: "unexpected url in test: " + url });
    },
  };
  return m;
}

let app: FastifyInstance;
let baseUrl: string;
let repos: Repos;
let upstream: FakeUpstream;
let pp: PayPalMock;
let events: PurserEvent[];
let deps: GatewayDeps;
const clients: Client[] = [];

function seed() {
  const db = openDb(":memory:");
  repos = createRepos(db);
  repos.agents.create({ id: "agent_a", name: "Agent A", apiKey: KEY_A, mandate: "m" });
  repos.agents.create({ id: "agent_b", name: "Agent B", apiKey: KEY_B, mandate: "m" });
  repos.policies.apply("agent_a", defaultPolicy({ agentId: "agent_a", allowlist: [ACME] }));
  repos.policies.apply("agent_b", defaultPolicy({ agentId: "agent_b", allowlist: [ACME] }));
}

async function boot(hooks?: GatewayDeps["hooks"]) {
  seed();
  upstream = new FakeUpstream();
  pp = mockPayPal();
  events = [];
  const bus = createEventBus();
  bus.subscribe((e) => events.push(e));
  deps = {
    repos,
    upstream,
    paypal: new PayPalClient({ clientId: "cid", clientSecret: "csecret", fetch: pp.fn, retryDelayMs: 0 }),
    bus,
    hooks,
  };
  app = buildApp(loadConfig({ LOG_LEVEL: "silent" }), { gateway: deps });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const addr = app.server.address();
  baseUrl = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}/mcp`;
}

async function connect(key = KEY_A): Promise<{ client: Client; transport: StreamableHTTPClientTransport }> {
  const transport = new StreamableHTTPClientTransport(new URL(baseUrl), { requestInit: { headers: { Authorization: `Bearer ${key}` } } });
  const client = new Client({ name: "test-agent", version: "1.0.0" });
  await client.connect(transport);
  clients.push(client);
  return { client, transport };
}

async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  const res = (await client.callTool({ name, arguments: args })) as { content: { type: string; text: string }[]; isError?: boolean };
  const raw = res.content[0]?.text ?? "";
  let json: Record<string, unknown> = {};
  try {
    json = JSON.parse(raw);
  } catch {
    // non-JSON passthrough
  }
  return { res, raw, json };
}

const payout = (amount: number | string, to = ACME, extra: Record<string, unknown> = {}) => ({ recipient_email: to, amount, currency: "USD", ...extra });

beforeAll(async () => {
  await boot();
});
afterAll(async () => {
  for (const c of clients) await c.close().catch(() => undefined);
  await app.close();
});
beforeEach(() => {
  // fresh runtime state between tests, keep agents and policies
  repos.attempts.clearAll();
  repos.agents.setAllStatus("active");
  repos.kv.delete(GLOBAL_FREEZE_KEY);
  upstream.calls = [];
  upstream.failWith = null;
  pp.payoutPosts.length = 0;
  pp.capture = { status: 200, body: { id: "CAPTURE12345", status: "COMPLETED", amount: { value: "30.00", currency_code: "USD" } } };
  events.length = 0;
});

describe("auth (stage 0)", () => {
  const init = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "x", version: "1" } } };
  const post = (headers: Record<string, string>) =>
    fetch(baseUrl, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers }, body: JSON.stringify(init) });

  it("rejects missing, malformed and unknown keys with 401", async () => {
    const bad: Record<string, string>[] = [{}, { Authorization: "Bearer nope" }, { Authorization: "Basic abc" }, { Authorization: "Bearer" }];
    for (const h of bad) {
      const r = await post(h);
      expect(r.status).toBe(401);
    }
    expect(repos.attempts.list()).toHaveLength(0);
  });
  it("accepts a valid key", async () => {
    expect((await post({ Authorization: `Bearer ${KEY_A}` })).status).toBe(200);
  });
  it("requires initialize before anything else", async () => {
    const r = await fetch(baseUrl, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", Authorization: `Bearer ${KEY_A}` }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
    expect(r.status).toBe(400);
  });
  it("binds a session to its agent: another agent cannot reuse the session id", async () => {
    const { transport } = await connect(KEY_A);
    const sid = transport.sessionId;
    expect(sid).toBeTruthy();
    const r = await fetch(baseUrl, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", Authorization: `Bearer ${KEY_B}`, "mcp-session-id": sid! },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
    });
    expect(r.status).toBe(404);
    const noAuth = await fetch(baseUrl, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-session-id": sid! }, body: JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/list" }) });
    expect(noAuth.status).toBe(401);
  });
});

describe("tools/list", () => {
  it("returns upstream tools plus native tools, hides unknown ones, annotates money tools", async () => {
    const { client } = await connect();
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(["list_invoices", "create_order", "create_refund", "pay_order", "send_invoice", "purser_payout", "purser_check_approval", "purser_status"]));
    expect(names).not.toContain("update_product");
    expect(names).not.toContain("cancel_subscription");

    const props = (n: string) => (tools.find((t) => t.name === n)!.inputSchema as { properties: Record<string, unknown> }).properties;
    for (const n of ["create_order", "create_refund", "pay_order", "send_invoice", "purser_payout"]) {
      expect(props(n), n).toHaveProperty("reason");
      expect(props(n), n).toHaveProperty("source");
    }
    for (const n of ["list_invoices", "purser_status", "purser_check_approval"]) {
      expect(props(n), n).not.toHaveProperty("reason");
    }
    // original upstream schema content is preserved and required fields stay required
    expect(props("create_order")).toHaveProperty("items");
    expect((tools.find((t) => t.name === "create_order")!.inputSchema as { required?: string[] }).required).toEqual(["items"]);
  });

  it("does not mutate the cached upstream schema", () => {
    const original = { type: "object", properties: { a: { type: "string" } } };
    const out = withReasonAndSource(original);
    expect(Object.keys(original.properties)).toEqual(["a"]);
    expect(Object.keys(out.properties as object)).toEqual(["a", "reason", "source"]);
  });
});

describe("happy path payout", () => {
  it("executes a $120 payout to an allowlisted vendor, records attempt and ledger, derives the idempotency key", async () => {
    const { client } = await connect();
    const t = performance.now();
    const { json, res } = await call(client, "purser_payout", payout(120, ACME, { reason: "March invoice", source: "user chat", note: "INV-1" }));
    expect(res.isError).toBeFalsy();
    expect(json).toMatchObject({ purser: "executed", payout_batch_id: "BATCH1", status: "PENDING", amount: "120.00 USD", recipient: ACME });
    expect(performance.now() - t).toBeLessThan(2000);

    const attempt = repos.attempts.get(json.attempt_id as string)!;
    expect(attempt).toMatchObject({ decision: "allow", tool: "purser_payout", tool_class: "money_out", amount: 12000, currency: "USD", payee_email: ACME, reason: "March invoice", source: "user chat", decision_stage: "rules" });
    expect(attempt.latency_ms).not.toBeNull();
    const ledger = repos.ledger.get(attempt.ledger_id!)!;
    expect(ledger).toMatchObject({ attempt_id: attempt.id, amount: 12000, currency: "USD", status: "PENDING" });
    expect(JSON.parse(ledger.paypal_ref_json)).toMatchObject({ payout_batch_id: "BATCH1", sender_item_id: attempt.id });

    expect(pp.payoutPosts).toHaveLength(1);
    const post = pp.payoutPosts[0]!;
    expect(post.headers["PayPal-Request-Id"]).toBe(`purser-payout-${attempt.id}`);
    expect(post.body).toMatchObject({ items: [{ receiver: ACME, amount: { value: "120.00", currency: "USD" }, sender_item_id: attempt.id, note: "INV-1" }] });
    expect(JSON.stringify(post.body)).not.toContain("March invoice"); // reason is not sent to PayPal
  });

  it("accepts string amounts and keeps cents exact", async () => {
    const { client } = await connect();
    const { json } = await call(client, "purser_payout", payout("19.99"));
    expect(json.purser).toBe("executed");
    expect(repos.attempts.get(json.attempt_id as string)?.amount).toBe(1999);
    expect((pp.payoutPosts[0]!.body as { items: { amount: { value: string } }[] }).items[0]!.amount.value).toBe("19.99");
  });
});

describe("denials", () => {
  it("denies a $9,999 payout (per-tx cap), moves no money, and does not leak thresholds or the allowlist", async () => {
    const { client } = await connect();
    const { json, raw } = await call(client, "purser_payout", payout(9999));
    expect(json).toMatchObject({ purser: "denied", retry_allowed: false });
    expect(json.attempt_id).toBeTruthy();
    expect(pp.payoutPosts).toHaveLength(0);
    expect(raw).not.toMatch(/200|cap|limit|threshold|allowlist|9999|personal\.example\.com/i);

    const a = repos.attempts.get(json.attempt_id as string)!;
    expect(a).toMatchObject({ decision: "deny", decision_stage: "rules", amount: 999900 });
    const hits = JSON.parse(a.rule_hits_json) as { id: string; detail?: unknown }[];
    expect(hits.map((h) => h.id)).toContain("per_tx_cap");
    expect(a.ledger_id).toBeNull();
  });

  it("denies an unknown tool, never forwards it, and records the attempt", async () => {
    const { client } = await connect();
    const { json } = await call(client, "update_product", { id: "P1" });
    expect(json).toMatchObject({ purser: "denied" });
    expect(upstream.calls).toHaveLength(0);
    const a = repos.attempts.get(json.attempt_id as string)!;
    expect(a).toMatchObject({ decision: "deny", decision_stage: "classify", tool_class: "unknown" });
    expect((await call(client, "totally_made_up", {})).json.purser).toBe("denied");
  });

  it("denies a tool outside allowed_actions", async () => {
    const { client } = await connect();
    // send_invoice is classified (outbound_comms) but not in the default allowed_actions
    const { json } = await call(client, "send_invoice", { invoice_id: "I1" });
    expect(json.purser).toBe("denied");
    expect(upstream.calls).toHaveLength(0);
    expect(JSON.parse(repos.attempts.get(json.attempt_id as string)!.rule_hits_json).map((h: { id: string }) => h.id)).toContain("action_not_allowed");
  });

  it("denies everything once the agent is frozen, reads included, and recovers when unfrozen", async () => {
    const { client } = await connect();
    repos.agents.setStatus("agent_a", "frozen");
    for (const [tool, args] of [["list_invoices", {}], ["purser_payout", payout(10)], ["purser_status", {}]] as [string, Record<string, unknown>][]) {
      const { json } = await call(client, tool, args);
      expect(json, tool).toMatchObject({ purser: "denied" });
      expect(repos.attempts.get(json.attempt_id as string)).toMatchObject({ decision: "deny", decision_stage: "killswitch" });
    }
    expect(upstream.calls).toHaveLength(0);
    expect(pp.payoutPosts).toHaveLength(0);
    repos.agents.setStatus("agent_a", "active");
    expect((await call(client, "purser_status")).json.purser).toBe("status");
  });

  it("the global freeze denies every agent", async () => {
    const a = await connect(KEY_A);
    const b = await connect(KEY_B);
    repos.kv.set(GLOBAL_FREEZE_KEY, "1");
    expect((await call(a.client, "list_invoices")).json.purser).toBe("denied");
    expect((await call(b.client, "list_invoices")).json.purser).toBe("denied");
    expect(upstream.calls).toHaveLength(0);
  });

  it("denies when the agent has no active policy (fail closed)", async () => {
    repos.agents.create({ id: "agent_nopol", name: "No policy", apiKey: "pk_nopol" });
    const { client } = await connect("pk_nopol");
    const { json } = await call(client, "purser_payout", payout(5));
    expect(json.purser).toBe("denied");
    expect(pp.payoutPosts).toHaveLength(0);
  });
});

describe("reason and source", () => {
  it("are stripped before forwarding upstream and stored on the attempt", async () => {
    const { client } = await connect();
    const { res } = await call(client, "create_order", {
      items: [{ name: "Widget", quantity: "2", unit_amount: { value: "10.00", currency_code: "USD" } }],
      currency_code: "USD",
      reason: "Customer asked for a quote",
      source: "email from customer",
    });
    expect(res.isError).toBeFalsy();
    expect(upstream.calls).toHaveLength(1);
    const forwarded = upstream.calls[0]!;
    expect(forwarded.name).toBe("create_order");
    expect(forwarded.args).not.toHaveProperty("reason");
    expect(forwarded.args).not.toHaveProperty("source");
    expect(forwarded.args).toHaveProperty("items");

    const a = repos.attempts.list()[0]!;
    expect(a).toMatchObject({ reason: "Customer asked for a quote", source: "email from customer", decision: "allow", amount: 2000, tool_class: "money_in" });
    expect(a.args_json).not.toContain("Customer asked");
    expect(repos.ledger.get(a.ledger_id!)?.status).toBe("executed");
  });

  it("are also stripped from native tool arguments before execution", async () => {
    const { client } = await connect();
    await call(client, "purser_payout", payout(20, ACME, { reason: "r", source: "s" }));
    expect(JSON.stringify(pp.payoutPosts[0]!.body)).not.toMatch(/"reason"|"source"/);
  });
});

describe("escalation (approval row for now)", () => {
  it("escalates a payout to a new payee: pending_approval shape, approval row, no money moved", async () => {
    const { client } = await connect();
    const { json, raw } = await call(client, "purser_payout", payout(50, STRANGER, { reason: "new vendor" }));
    expect(json).toMatchObject({ purser: "pending_approval", retry_allowed: false });
    expect(json.approval_id).toBeTruthy();
    expect(pp.payoutPosts).toHaveLength(0);
    expect(raw).not.toMatch(/allowlist|threshold|cap/i);

    const a = repos.attempts.get(json.attempt_id as string)!;
    expect(a).toMatchObject({ decision: "escalate", approval_id: json.approval_id });
    const ap = repos.approvals.get(json.approval_id as string)!;
    expect(ap.status).toBe("pending");
    expect(ap.expires_at).toBeGreaterThan(Date.now());
    expect(events.map((e) => e.type)).toEqual(expect.arrayContaining(["attempt", "approval_created"]));

    const status = await call(client, "purser_check_approval", { approval_id: ap.id });
    expect(status.json).toMatchObject({ purser: "approval", status: "pending" });
  });

  it("escalates an above-threshold payout to an allowlisted vendor", async () => {
    const { client } = await connect();
    expect((await call(client, "purser_payout", payout(180))).json.purser).toBe("pending_approval");
  });

  it("an agent cannot read another agent's approval", async () => {
    const a = await connect(KEY_A);
    const b = await connect(KEY_B);
    const { json } = await call(a.client, "purser_payout", payout(50, STRANGER));
    const peek = await call(b.client, "purser_check_approval", { approval_id: json.approval_id as string });
    expect(peek.json.status).toBe("not_found");
  });

  it("a refund with no amount resolves the captured amount via PayPal (allowed), and escalates if the lookup fails", async () => {
    const { client } = await connect();
    const ok = await call(client, "create_refund", { capture_id: "CAPTURE12345", currency_code: "USD" });
    expect(upstream.calls.at(-1)?.name).toBe("create_refund");
    expect(ok.json.purser).toBeUndefined(); // passthrough of the upstream result
    expect(repos.attempts.list()[0]).toMatchObject({ amount: 3000, decision: "allow" });

    pp.capture = { status: 404, body: { name: "RESOURCE_NOT_FOUND", message: "x" } };
    upstream.calls = [];
    const bad = await call(client, "create_refund", { capture_id: "CAPTURE99999", currency_code: "USD" });
    expect(bad.json.purser).toBe("pending_approval");
    expect(upstream.calls).toHaveLength(0);
  });
});

describe("read tools and recording", () => {
  it("passes read tools through and records them", async () => {
    const { client } = await connect();
    const { json } = await call(client, "list_invoices", { page: 1 });
    expect(json).toMatchObject({ ok: true, tool: "list_invoices" });
    expect(upstream.calls[0]).toEqual({ name: "list_invoices", args: { page: 1 } });
    expect(repos.attempts.list()[0]).toMatchObject({ tool: "list_invoices", tool_class: "read", decision: "allow" });
  });

  it("every call writes exactly one attempt row, whatever the outcome", async () => {
    const { client } = await connect();
    await call(client, "list_invoices");
    await call(client, "purser_payout", payout(10));
    await call(client, "purser_payout", payout(9999));
    await call(client, "purser_payout", payout(50, STRANGER));
    await call(client, "nonsense_tool");
    repos.agents.setStatus("agent_a", "frozen");
    await call(client, "purser_status");
    const rows = repos.attempts.list();
    expect(rows).toHaveLength(6);
    expect(rows.map((r) => r.decision).sort()).toEqual(["allow", "allow", "deny", "deny", "deny", "escalate"]);
    for (const r of rows) {
      expect(r.decision_stage).toBeTruthy();
      expect(r.latency_ms).not.toBeNull();
      expect(JSON.parse(r.rule_hits_json)).toBeInstanceOf(Array);
    }
  });

  it("never stores secret-looking argument values", async () => {
    const { client } = await connect();
    await call(client, "create_order", { items: [{ quantity: 1, unit_amount: "5.00" }], currency_code: "USD", access_token: "SUPERSECRET", nested: { client_secret: "ALSOSECRET", ok: 1 } });
    const a = repos.attempts.list()[0]!;
    expect(a.args_json).not.toContain("SUPERSECRET");
    expect(a.args_json).not.toContain("ALSOSECRET");
    expect(a.args_json).toContain("[redacted]");
  });

  it("emits an attempt event for each decision, and again when execution settles", async () => {
    const { client } = await connect();
    await call(client, "purser_payout", payout(10));
    await call(client, "purser_payout", payout(9999));
    const attemptEvents = events.filter((e) => e.type === "attempt") as Extract<PurserEvent, { type: "attempt" }>[];
    expect(attemptEvents.map((e) => e.data.decision)).toEqual(["allow", "allow", "deny"]); // allow (decided), allow (settled), deny
    expect(attemptEvents[1]!.data.ledger_id).toBeTruthy();
    expect(attemptEvents[2]!.data.rule_hits).toContain("per_tx_cap");
  });
});

describe("execution failures fail closed", () => {
  it("an upstream error returns an error result, no secrets, and an ambiguous ledger row", async () => {
    const { client } = await connect();
    upstream.failWith = new Error("socket hang up");
    const { res, json } = await call(client, "create_order", { items: [{ quantity: 1, unit_amount: "5.00" }], currency_code: "USD" });
    expect(res.isError).toBe(true);
    expect(json).toMatchObject({ purser: "error", retry_allowed: false });
    const a = repos.attempts.get(json.attempt_id as string)!;
    expect(a.decision_stage).toBe("execute");
    expect(repos.ledger.get(a.ledger_id!)?.status).toBe("unknown");
  });

  it("without a PayPal client, payouts error out and nothing is sent", async () => {
    const saved = deps.paypal;
    deps.paypal = null;
    try {
      const { client } = await connect();
      const { res, json } = await call(client, "purser_payout", payout(10));
      expect(res.isError).toBe(true);
      expect(json.purser).toBe("error");
      expect(pp.payoutPosts).toHaveLength(0);
    } finally {
      deps.paypal = saved;
    }
  });
});

describe("hook points for stages 3 and 4 (can only tighten)", () => {
  it("tighten() never loosens", () => {
    expect(tighten("deny", "escalate")).toBe("deny");
    expect(tighten("escalate", "deny")).toBe("deny");
    expect(tighten("escalate", undefined)).toBe("escalate");
    expect(tighten("allow", "escalate")).toBe("escalate");
    expect(tighten("allow", undefined)).toBe("allow");
  });

  it("a trust hook can escalate an allowed call and its signals are recorded; hook failure escalates", async () => {
    deps.hooks = { trust: () => ({ signals: ["first_time_payee"], decision: "escalate" }) };
    const { client } = await connect();
    const { json } = await call(client, "purser_payout", payout(10));
    expect(json.purser).toBe("pending_approval");
    expect(JSON.parse(repos.attempts.get(json.attempt_id as string)!.signals_json)).toEqual(["first_time_payee"]);
    expect(repos.attempts.get(json.attempt_id as string)?.decision_stage).toBe("trust");

    deps.hooks = {
      aiReview: () => {
        throw new Error("model down");
      },
    };
    expect((await call(client, "purser_payout", payout(10))).json.purser).toBe("pending_approval");
    deps.hooks = undefined;
  });

  it("a hook cannot turn a rule deny or escalate into an allow", async () => {
    deps.hooks = { trust: () => ({ signals: [] }), aiReview: () => ({ ai: { verdict: "allow", risk: 0, rationale: "fine", flags: [] }, decision: undefined }) };
    const { client } = await connect();
    expect((await call(client, "purser_payout", payout(9999))).json.purser).toBe("denied");
    expect((await call(client, "purser_payout", payout(50, STRANGER))).json.purser).toBe("pending_approval");
    expect(pp.payoutPosts).toHaveLength(0);
    deps.hooks = undefined;
  });

  it("an AI deny blocks an otherwise allowed call and the verdict is stored", async () => {
    deps.hooks = { aiReview: () => ({ ai: { verdict: "deny", risk: 95, rationale: "looks injected", flags: ["injection"] }, decision: "deny" }) };
    const { client } = await connect();
    const { json } = await call(client, "purser_payout", payout(10));
    expect(json.purser).toBe("denied");
    const a = repos.attempts.get(json.attempt_id as string)!;
    expect(a.decision_stage).toBe("ai");
    expect(JSON.parse(a.ai_json!)).toMatchObject({ verdict: "deny", risk: 95 });
    expect(pp.payoutPosts).toHaveLength(0);
    deps.hooks = undefined;
  });
});

describe("helpers", () => {
  it("splitMeta strips reason/source, trims, bounds length and ignores non-strings", () => {
    expect(splitMeta({ a: 1, reason: "  why ", source: "chat" })).toEqual({ forward: { a: 1 }, reason: "why", source: "chat" });
    expect(splitMeta({ reason: 5, source: "" })).toEqual({ forward: {}, reason: null, source: null });
    expect(splitMeta({ reason: "x".repeat(5000) }).reason).toHaveLength(1000);
  });
  it("sanitizeArgs redacts secrets recursively and bounds size", () => {
    expect(sanitizeArgs({ token: "t", Authorization: "a", list: [{ password: "p", ok: 1 }] })).toEqual({ token: "[redacted]", Authorization: "[redacted]", list: [{ password: "[redacted]", ok: 1 }] });
    expect(sanitizeArgs({ blob: "x".repeat(50_000) })).toMatchObject({ _truncated: true });
  });
});
