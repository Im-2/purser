import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { PurserEvent } from "@purser/shared";
import type { RunnerOptions, ScenarioResult } from "@purser/agent";
import { createDemoRunner, type DemoRunner } from "../src/admin/demo-run.js";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { createRepos, openDb } from "../src/db/index.js";
import { createEventBus } from "../src/events.js";
import type { GatewayDeps } from "../src/gateway/pipeline.js";
import type { LlmClient } from "../src/ai/llm.js";

const TOKEN = "admin-token-for-tests";
const auth = { authorization: `Bearer ${TOKEN}` };
const env: RunnerOptions["env"] = { agentId: "agent_ops_01", acmeEmail: "acme-supplies@personal.example.com", northwindEmail: "northwind-parts@personal.example.com", lookalike: "acme-supp1ies@personal.example.com" };

const fakeResult = (id: string, mode: string, runId: string): ScenarioResult =>
  ({ run_id: runId, scenario: id, title: "t", mode, started_at: new Date().toISOString(), duration_ms: 5, calls: [], attempts: [{ tool_class: "money_out", decision: "allow" }, { tool_class: "read", decision: "allow" }], pending_approvals: [], agent_frozen: false, freeze_reason: null }) as unknown as ScenarioResult;

let app: FastifyInstance;
let events: PurserEvent[];
let release: (() => void) | null;
let calls: { id: string; mode: string; opts: RunnerOptions }[];

async function boot(o: { llm?: LlmClient | null; configured?: boolean } = {}) {
  const repos = createRepos(openDb(":memory:"));
  events = [];
  calls = [];
  release = null;
  const bus = createEventBus();
  bus.subscribe((e) => events.push(e));
  const demo: DemoRunner = createDemoRunner({
    bus,
    baseUrl: "http://127.0.0.1:8799",
    agentKey: o.configured === false ? undefined : "pk_x",
    adminToken: TOKEN,
    env,
    llm: o.llm ?? null,
    run: async (id, mode, opts) => {
      calls.push({ id, mode, opts });
      opts.log?.({ kind: "start", message: `Scenario ${id}`, run_id: opts.runId!, scenario: id, mode, step: 1 });
      await new Promise<void>((r) => (release = r)); // hold the run open so we can observe "busy"
      opts.log?.({ kind: "done", message: "finished", run_id: opts.runId!, scenario: id, mode, step: 2 });
      return fakeResult(id, mode, opts.runId!);
    },
  });
  const gateway: GatewayDeps = { repos, upstream: { start: async () => [], listTools: async () => [], callTool: async () => ({ content: [] }), close: async () => undefined }, paypal: null, bus };
  app = buildApp(loadConfig({ LOG_LEVEL: "silent" }), { gateway, admin: { repos, llm: null, adminToken: TOKEN, gateway, demo } });
}
beforeEach(() => boot());
afterEach(async () => {
  release?.();
  await app.close();
});

const post = (url: string, payload?: unknown, headers: Record<string, string> = auth) => app.inject({ method: "POST", url, headers, ...(payload !== undefined ? { payload: payload as object } : {}) });
const tick = () => new Promise((r) => setTimeout(r, 20));

describe("POST /api/demo/run/:scenario", () => {
  it("needs the admin token", async () => {
    expect((await post("/api/demo/run/A", {}, {})).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: "/api/demo/status" })).statusCode).toBe(401);
  });

  it("starts a background job, answers 202 with a run id, and streams scenario_log events", async () => {
    const res = await post("/api/demo/run/a", { mode: "replay" }); // case-insensitive
    expect(res.statusCode).toBe(202);
    const body = res.json();
    expect(body).toMatchObject({ scenario: "A", mode: "replay" });
    expect(body.run_id).toMatch(/^run_/);
    await tick();
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ id: "A", mode: "replay" });
    expect(calls[0]!.opts).toMatchObject({ reset: true, runId: body.run_id, baseUrl: "http://127.0.0.1:8799" });

    const logs = events.filter((e): e is Extract<PurserEvent, { type: "scenario_log" }> => e.type === "scenario_log");
    expect(logs.map((l) => l.data.kind)).toEqual(["start"]);
    expect(logs[0]!.data).toMatchObject({ run_id: body.run_id, scenario: "A", mode: "replay", step: 1 });

    release!();
    await tick();
    expect(events.filter((e) => e.type === "scenario_log").map((e) => (e as { data: { kind: string } }).data.kind)).toEqual(["start", "done"]);
    const status = (await app.inject({ method: "GET", url: "/api/demo/status", headers: auth })).json();
    expect(status.running).toBeNull();
    expect(status.last).toMatchObject({ run_id: body.run_id, scenario: "A", decisions: ["allow"], agent_frozen: false });
  });

  it("runs one scenario at a time (409 while busy), then accepts the next", async () => {
    expect((await post("/api/demo/run/A", {})).statusCode).toBe(202);
    await tick();
    const busy = await post("/api/demo/run/B", {});
    expect(busy.statusCode).toBe(409);
    expect(busy.json().error).toBe("busy");
    expect((await app.inject({ method: "GET", url: "/api/demo/status", headers: auth })).json().running).toMatchObject({ scenario: "A" });
    release!();
    await tick();
    expect((await post("/api/demo/run/B", { reset: false })).statusCode).toBe(202);
    await tick();
    expect(calls.at(-1)!.opts.reset).toBe(false);
  });

  it("validates the scenario and the body", async () => {
    expect((await post("/api/demo/run/Z", {})).statusCode).toBe(404);
    expect((await post("/api/demo/run/A", { mode: "sideways" })).statusCode).toBe(400);
    expect((await post("/api/demo/run/A", { nope: 1 })).statusCode).toBe(400);
    expect(calls).toHaveLength(0);
  });

  it("live mode needs a tool-calling model: 422 without one, accepted with one", async () => {
    const res = await post("/api/demo/run/A", { mode: "live" });
    expect(res.statusCode).toBe(422);
    expect(res.json().error).toBe("live_unavailable");
    await app.close();
    const llm = { provider: "openai_compat", model: "m", complete: async () => ({ text: "{}", model: "m", latencyMs: 1, mode: "json_schema" }), chat: async () => ({ message: { role: "assistant", content: "ok" }, finish_reason: "stop", model: "m", latencyMs: 1 }) } as unknown as LlmClient;
    await boot({ llm });
    expect((await post("/api/demo/run/A", { mode: "live" })).statusCode).toBe(202);
    await tick();
    expect(calls[0]!.opts.llm).not.toBeNull();
  });

  it("is refused with 503 when the agent key is not configured", async () => {
    await app.close();
    await boot({ configured: false });
    const res = await post("/api/demo/run/A", {});
    expect(res.statusCode).toBe(503);
    expect(res.json().error).toBe("not_configured");
  });

  it("a scenario that throws is reported as an error log and a done event, and frees the runner", async () => {
    await app.close();
    const repos = createRepos(openDb(":memory:"));
    events = [];
    const bus = createEventBus();
    bus.subscribe((e) => events.push(e));
    const demo = createDemoRunner({ bus, baseUrl: "http://127.0.0.1:1", agentKey: "k", adminToken: TOKEN, env, llm: null, run: async () => Promise.reject(new Error("gateway unreachable")) });
    const gateway: GatewayDeps = { repos, upstream: { start: async () => [], listTools: async () => [], callTool: async () => ({ content: [] }), close: async () => undefined }, paypal: null, bus };
    app = buildApp(loadConfig({ LOG_LEVEL: "silent" }), { gateway, admin: { repos, llm: null, adminToken: TOKEN, gateway, demo } });
    expect((await post("/api/demo/run/D", {})).statusCode).toBe(202);
    await tick();
    const kinds = events.filter((e) => e.type === "scenario_log").map((e) => (e as { data: { kind: string; message: string } }).data);
    expect(kinds.map((k) => k.kind)).toEqual(["error", "done"]);
    expect(kinds[0]!.message).toMatch(/gateway unreachable/);
    const status = (await app.inject({ method: "GET", url: "/api/demo/status", headers: auth })).json();
    expect(status.running).toBeNull();
    expect(status.last.error).toMatch(/gateway unreachable/);
  });
});
