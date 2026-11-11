import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";

let dir: string;
let app: FastifyInstance;
const html = { accept: "text/html,application/xhtml+xml" };

beforeAll(async () => {
  dir = mkdtempSync(path.join(tmpdir(), "purser-web-"));
  mkdirSync(path.join(dir, "assets"));
  writeFileSync(path.join(dir, "index.html"), "<!doctype html><title>Purser</title><div id=root></div>");
  writeFileSync(path.join(dir, "assets", "index-abc123.js"), "console.log('app')");
  writeFileSync(path.join(dir, "favicon.svg"), "<svg xmlns='http://www.w3.org/2000/svg'/>");
  app = buildApp(loadConfig({ LOG_LEVEL: "silent" }), { webDist: dir });
  await app.ready();
});
afterAll(async () => {
  await app.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("serving the built dashboard", () => {
  it("serves index.html at / and revalidates it", async () => {
    const r = await app.inject({ method: "GET", url: "/" });
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain("<title>Purser</title>");
    expect(r.headers["cache-control"]).toBe("no-cache");
  });
  it("serves hashed assets as immutable and other files normally", async () => {
    const a = await app.inject({ method: "GET", url: "/assets/index-abc123.js" });
    expect(a.statusCode).toBe(200);
    expect(a.headers["cache-control"]).toMatch(/immutable/);
    expect((await app.inject({ method: "GET", url: "/favicon.svg" })).statusCode).toBe(200);
  });
  it("falls back to index.html for unknown browser paths (SPA)", async () => {
    const r = await app.inject({ method: "GET", url: "/some/deep/link", headers: html });
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain('<div id=root>');
  });
  it("never shadows the backend: /health stays JSON, unknown /api and /mcp paths stay 404 JSON", async () => {
    expect((await app.inject({ method: "GET", url: "/health" })).json().status).toBe("ok");
    for (const url of ["/api/nope", "/api", "/mcp/x", "/webhooks/other", "/health/x"]) {
      const r = await app.inject({ method: "GET", url, headers: html });
      expect(r.statusCode, url).toBe(404);
      expect(r.headers["content-type"], url).toMatch(/json/);
    }
  });
  it("a non-browser request for a missing file is a plain 404, not the HTML shell", async () => {
    const r = await app.inject({ method: "GET", url: "/assets/missing.js", headers: { accept: "*/*" } });
    expect(r.statusCode).toBe(404);
  });
  it("does nothing when there is no build", async () => {
    const bare = buildApp(loadConfig({ LOG_LEVEL: "silent" }), { webDist: path.join(dir, "does-not-exist") });
    expect((await bare.inject({ method: "GET", url: "/", headers: html })).statusCode).toBe(404);
    await bare.close();
  });
});
