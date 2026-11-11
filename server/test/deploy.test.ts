import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { ensureSeeded, loadVerdictSeed, VERDICT_SEED_FILE } from "../src/bootstrap.js";
import { allowedOrigins, loadConfig } from "../src/config.js";
import { createRepos, openDb } from "../src/db/index.js";
import { resetDemo } from "../src/control/demo.js";
import { createEventBus } from "../src/events.js";
import { hashApiKey } from "../src/db/repos.js";
import { installedPaypalMcpEntry } from "../src/paypal/index.js";

const env = { acme: "acme@example.test", northwind: "northwind@example.test", agentKey: "pk_test_key_value" };
const VERDICT = { verdict: "escalate", risk: 80, rationale: "test verdict", flags: ["x"] };
const key = (n: number) => n.toString(16).padStart(64, "0");

describe("first boot on an empty (ephemeral) disk", () => {
  it("seeds the agent from AGENT_API_KEY (hashed), two vendors and the default policy", () => {
    const repos = createRepos(openDb(":memory:"));
    expect(ensureSeeded(repos, env)).toEqual({ seeded: true });
    const agent = repos.agents.get("agent_ops_01");
    expect(agent?.api_key_hash).toBe(hashApiKey(env.agentKey));
    expect(agent?.api_key_hash).not.toContain(env.agentKey);
    expect(repos.payees.list()).toHaveLength(2);
    expect(repos.policies.getActive("agent_ops_01")?.payees.allowlist).toEqual([env.acme, env.northwind]);
  });
  it("is idempotent: a second boot does nothing", () => {
    const repos = createRepos(openDb(":memory:"));
    ensureSeeded(repos, env);
    expect(ensureSeeded(repos, env)).toEqual({ seeded: false });
    expect(repos.policies.history("agent_ops_01")).toHaveLength(1);
  });
  it("does not invent a key: without AGENT_API_KEY it reports why and seeds nothing", () => {
    const repos = createRepos(openDb(":memory:"));
    const r = ensureSeeded(repos, { ...env, agentKey: undefined });
    expect(r.seeded).toBe(false);
    expect(r.reason).toMatch(/AGENT_API_KEY/);
    expect(repos.agents.get("agent_ops_01")).toBeUndefined();
  });
});

describe("shipped AI verdict cache", () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(path.join(tmpdir(), "purser-seed-"));
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("loads valid verdicts, skips invalid ones and never overwrites an existing row", () => {
    const f = path.join(dir, "v.json");
    writeFileSync(f, JSON.stringify({ verdicts: [{ key: key(1), model: "m", verdict: VERDICT }, { key: key(2), model: "m", verdict: { verdict: "bogus" } }, { key: key(3), model: "m", verdict: VERDICT }] }));
    const repos = createRepos(openDb(":memory:"));
    repos.verdicts.put(key(3), { ...VERDICT, rationale: "newer live verdict" }, "live", 5);
    expect(loadVerdictSeed(repos, f, 1000)).toEqual({ added: 1, skipped: 1 });
    expect((repos.verdicts.get(key(1)) as { created_at: number }).created_at).toBe(1000); // stamped fresh
    expect((repos.verdicts.get(key(3))?.verdict as { rationale: string }).rationale).toBe("newer live verdict");
  });
  it("a missing or corrupt file is a no-op, not a crash", () => {
    const repos = createRepos(openDb(":memory:"));
    expect(loadVerdictSeed(repos, path.join(dir, "nope.json"))).toEqual({ added: 0, skipped: 0 });
    const bad = path.join(dir, "bad.json");
    writeFileSync(bad, "{not json");
    expect(loadVerdictSeed(repos, bad)).toEqual({ added: 0, skipped: 0 });
  });
  it("the committed seed file is valid and loads", () => {
    const repos = createRepos(openDb(":memory:"));
    const r = loadVerdictSeed(repos, VERDICT_SEED_FILE);
    expect(r.skipped).toBe(0);
    expect(r.added).toBeGreaterThan(0);
  });
  it("demo reset keeps the verdict cache", () => {
    const repos = createRepos(openDb(":memory:"));
    ensureSeeded(repos, env);
    repos.verdicts.put(key(9), VERDICT, "m");
    resetDemo({ repos, bus: createEventBus() });
    expect(repos.verdicts.get(key(9))).toBeDefined();
  });
});

describe("configuration for Render", () => {
  it("PUBLIC_URL falls back to RENDER_EXTERNAL_URL, and an explicit PUBLIC_URL wins", () => {
    expect(loadConfig({ RENDER_EXTERNAL_URL: "https://purser-x.onrender.com" }).PUBLIC_URL).toBe("https://purser-x.onrender.com");
    expect(loadConfig({ PUBLIC_URL: "https://demo.example.com", RENDER_EXTERNAL_URL: "https://purser-x.onrender.com" }).PUBLIC_URL).toBe("https://demo.example.com");
    expect(loadConfig({ PUBLIC_URL: "", RENDER_EXTERNAL_URL: "https://purser-x.onrender.com" }).PUBLIC_URL).toBe("https://purser-x.onrender.com");
  });
  it("UPSTREAM_MODE defaults to stdio and rejects unknown values", () => {
    expect(loadConfig({}).UPSTREAM_MODE).toBe("stdio");
    expect(loadConfig({ UPSTREAM_MODE: "off" }).UPSTREAM_MODE).toBe("off");
    expect(() => loadConfig({ UPSTREAM_MODE: "carrier-pigeon" })).toThrow(/UPSTREAM_MODE/);
  });
  it("allowed origins: production is only the public URL; development adds the Vite dev server", () => {
    expect(allowedOrigins({ PUBLIC_URL: "https://a.onrender.com/", RENDER_EXTERNAL_URL: "https://a.onrender.com", NODE_ENV: "production" })).toEqual(["https://a.onrender.com"]);
    expect(allowedOrigins({ PUBLIC_URL: "http://127.0.0.1:8799", RENDER_EXTERNAL_URL: undefined, NODE_ENV: undefined })).toContain("http://127.0.0.1:5173");
  });
  it("the pinned @paypal/mcp is installed, so the upstream needs no npx at runtime", () => {
    expect(installedPaypalMcpEntry()).toMatch(/dist[\\/]index\.js$/);
  });
});

describe("CORS is locked to PUBLIC_URL", () => {
  let app: FastifyInstance;
  beforeAll(async () => {
    app = buildApp(loadConfig({ LOG_LEVEL: "silent", NODE_ENV: "production", PUBLIC_URL: "https://purser.example.com" }));
    await app.ready();
  });
  afterAll(() => app.close());

  it("refuses a browser request from another origin", async () => {
    const r = await app.inject({ method: "GET", url: "/health", headers: { origin: "https://evil.example.net" } });
    expect(r.statusCode).toBe(403);
    expect(r.headers["access-control-allow-origin"]).toBeUndefined();
  });
  it("answers a preflight from the public origin only", async () => {
    const ok = await app.inject({ method: "OPTIONS", url: "/api/stats", headers: { origin: "https://purser.example.com", "access-control-request-method": "POST" } });
    expect(ok.statusCode).toBe(204);
    expect(ok.headers["access-control-allow-origin"]).toBe("https://purser.example.com");
    const bad = await app.inject({ method: "OPTIONS", url: "/api/stats", headers: { origin: "https://evil.example.net" } });
    expect(bad.statusCode).toBe(403);
  });
  it("same-origin and non-browser clients (no Origin header) are unaffected", async () => {
    expect((await app.inject({ method: "GET", url: "/health" })).statusCode).toBe(200);
    const same = await app.inject({ method: "GET", url: "/health", headers: { origin: "http://localhost:8799", host: "localhost:8799" } });
    expect(same.statusCode).toBe(200);
  });
});
