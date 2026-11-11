import { randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import type { FastifyInstance } from "fastify";
import { makeLookalike } from "@purser/shared/lookalike";
import { createDemoRunner } from "../admin/demo-run.js";
import { createReviewer, type Reviewer } from "../ai/reviewer.js";
import { createPipelineHooks } from "../ai/hook.js";
import { startApprovalSweeper } from "../approvals/service.js";
import { buildApp } from "../app.js";
import { loadVerdictSeed, seedDemoWorld } from "../bootstrap.js";
import type { Config } from "../config.js";
import { createRepos, openDb, type Repos } from "../db/index.js";
import { createEventBus } from "../events.js";
import { SEEDED_AGENT_ID } from "../policy/defaults.js";
import type { UpstreamTool } from "../paypal/index.js";
import { createSimPayPal, createSimUpstream, type SimPayPal } from "./sim.js";

/**
 * A demo world is a complete, private copy of Purser for one judge: its own in-memory database, event bus, gateway, policy,
 * approvals, Attack Lab runner and HTTP listener on a loopback port. The AI reviewer answers from the shipped verdict cache only
 * (no model, no API key), and PayPal is simulated (see sim.ts), so nothing a judge does can touch the real ledger, the real
 * PayPal sandbox account or the model provider, and two judges cannot see or disturb each other.
 */
export interface DemoWorld {
  /** The session token the judge holds (dm_...). Unrelated to the internal credentials below. */
  token: string;
  createdAt: number;
  expiresAt: number;
  port: number;
  /** Internal admin token for this world only. Never leaves the server. */
  adminToken: string;
  sim: SimPayPal;
  app: FastifyInstance;
  close(): Promise<void>;
}

export interface WorldsOptions {
  config: Config;
  /** Tools of the real PayPal MCP server (cached), so the simulated gateway lists the same tools. */
  upstreamTools: () => UpstreamTool[];
  ttlMs: number;
  maxSessions: number;
  /** Tests only: replace the cached-verdict reviewer. Production always uses the shipped verdict cache with no model. */
  makeReviewer?: (repos: Repos) => Reviewer;
  now?: () => number;
}

export class DemoWorlds {
  private readonly worlds = new Map<string, DemoWorld>();
  private readonly now: () => number;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly o: WorldsOptions) {
    this.now = o.now ?? Date.now;
  }

  get size(): number {
    return this.worlds.size;
  }

  /** The demo needs the vendor emails: the cached AI verdicts are keyed by them. */
  get available(): boolean {
    return Boolean(this.o.config.VENDOR_ACME_EMAIL && this.o.config.VENDOR_NORTHWIND_EMAIL);
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.sweep(), 30_000);
    this.timer.unref();
  }

  async create(): Promise<DemoWorld> {
    const { config } = this.o;
    if (!this.available) throw new Error("demo_unavailable");
    await this.sweep();
    // at capacity: the oldest session makes room
    while (this.worlds.size >= this.o.maxSessions) {
      const oldest = [...this.worlds.values()].sort((a, b) => a.createdAt - b.createdAt)[0];
      if (!oldest) break;
      await this.drop(oldest);
    }

    const acme = config.VENDOR_ACME_EMAIL!;
    const northwind = config.VENDOR_NORTHWIND_EMAIL!;
    const adminToken = randomBytes(32).toString("base64url");
    const agentKey = "pk_" + randomBytes(24).toString("base64url");

    const repos = createRepos(openDb(":memory:"));
    seedDemoWorld(repos, { acmeEmail: acme, northwindEmail: northwind, apiKey: agentKey });
    loadVerdictSeed(repos); // the shipped, secret-free verdicts: replay never needs a model
    const bus = createEventBus();
    const sim = createSimPayPal();
    const reviewer = this.o.makeReviewer?.(repos) ?? createReviewer({ llm: null, repos, ttlMs: config.AI_CACHE_TTL_SEC * 1000, mode: "cached_only", modelHint: config.LLM_MODEL });
    const hooks = createPipelineHooks({ repos, reviewer });
    const gateway = { repos, upstream: createSimUpstream(this.o.upstreamTools), paypal: sim.client, bus, hooks };

    const worldConfig: Config = { ...config, LOG_LEVEL: "silent", NODE_ENV: "production", PURSER_ADMIN_TOKEN: adminToken, AGENT_API_KEY: agentKey, PAYPAL_WEBHOOK_ID: undefined, LLM_API_KEY: undefined, PAYPAL_CLIENT_ID: undefined, PAYPAL_CLIENT_SECRET: undefined };
    const holder: { baseUrl: string } = { baseUrl: "" };
    const demo = createDemoRunner({
      bus,
      get baseUrl() {
        return holder.baseUrl;
      },
      agentKey,
      adminToken,
      llm: null, // live mode is impossible here by construction
      env: { agentId: SEEDED_AGENT_ID, acmeEmail: acme, northwindEmail: northwind, lookalike: makeLookalike(acme), simulated: true },
    });
    const app = buildApp(worldConfig, { gateway, admin: { repos, llm: null, adminToken, gateway, demo, isProduction: true } });
    const stopSweeper = startApprovalSweeper(gateway, 30_000);
    await app.listen({ port: 0, host: "127.0.0.1" });
    const port = (app.server.address() as AddressInfo).port;
    holder.baseUrl = `http://127.0.0.1:${port}`;

    const createdAt = this.now();
    const world: DemoWorld = {
      token: "dm_" + randomBytes(32).toString("base64url"),
      createdAt,
      expiresAt: createdAt + this.o.ttlMs,
      port,
      adminToken,
      sim,
      app,
      close: async () => {
        stopSweeper();
        await app.close().catch(() => undefined);
      },
    };
    this.worlds.set(world.token, world);
    return world;
  }

  /** The live world for a session token, or undefined if unknown or expired. */
  get(token: string): DemoWorld | undefined {
    const w = this.worlds.get(token);
    if (!w) return undefined;
    if (w.expiresAt <= this.now()) {
      void this.drop(w);
      return undefined;
    }
    return w;
  }

  async sweep(): Promise<void> {
    const t = this.now();
    for (const w of [...this.worlds.values()]) if (w.expiresAt <= t) await this.drop(w);
  }

  private async drop(w: DemoWorld): Promise<void> {
    this.worlds.delete(w.token);
    await w.close();
  }

  async closeAll(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const w of [...this.worlds.values()]) await this.drop(w);
  }
}
