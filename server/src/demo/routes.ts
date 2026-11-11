import http from "node:http";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { bearerToken } from "../admin/auth.js";
import type { DemoWorlds, DemoWorld } from "./worlds.js";

/**
 * Judge demo mode, server side.
 *
 *   POST /api/demo-session   no credentials; rate limited; returns a short-lived token (dm_...) for a private demo world.
 *   any /api/* request carrying a demo token is handled HERE, never by the real admin API: the request is checked against the
 *   allowlist below (default deny: 403) and then forwarded to that session's own isolated world. The real repositories, the real
 *   PayPal client and the real admin routes are not reachable with a demo token, whatever it asks for.
 */
export interface DemoRoutesOptions {
  worlds: DemoWorlds;
  /** Sessions one client may open per 10 minutes. */
  perIpLimit: number;
  /** Sessions opened by everyone together per 10 minutes (backstop: the client address can be spoofed behind a proxy). */
  globalLimit?: number;
  now?: () => number;
}

interface Rule {
  method: "GET" | "POST";
  re: RegExp;
}

/** Read-only views. */
const VIEW: Rule[] = [
  { method: "GET", re: /^\/api\/attempts$/ },
  { method: "GET", re: /^\/api\/attempts\/[A-Za-z0-9_-]{1,64}$/ },
  { method: "GET", re: /^\/api\/agents$/ },
  { method: "GET", re: /^\/api\/approvals$/ },
  { method: "GET", re: /^\/api\/stats$/ },
  { method: "GET", re: /^\/api\/policies\/[A-Za-z0-9_-]{1,64}$/ },
  { method: "GET", re: /^\/api\/reconciliation$/ },
  { method: "GET", re: /^\/api\/events$/ },
  { method: "GET", re: /^\/api\/demo\/status$/ },
];

/**
 * Actions that change state, allowed because they only ever change the judge's OWN simulated world: replay scenarios, resetting
 * that world, and the approval queue and kill switch inside it. None of them can reach the real system. To make the demo stricter
 * (view and run only), delete rows here: everything not listed is refused with 403.
 */
const WORLD_LOCAL: Rule[] = [
  { method: "POST", re: /^\/api\/demo\/reset$/ },
  { method: "POST", re: /^\/api\/demo\/run\/[ABCD]$/ },
  { method: "POST", re: /^\/api\/approvals\/[A-Za-z0-9_-]{1,64}\/(approve|deny)$/ },
  { method: "POST", re: /^\/api\/agents\/[A-Za-z0-9_-]{1,64}\/(freeze|unfreeze)$/ },
  { method: "POST", re: /^\/api\/(freeze-all|unfreeze-all)$/ },
];

/**
 * Deliberately NOT allowed, for the record (they fall under default deny): POST /api/policies/compile and /apply (policy changes
 * and model calls), POST /api/agents (create agents and keys), POST /api/reconciliation/run (talks to PayPal),
 * POST /api/dev/simulate-webhook, live-mode scenario runs, and anything unknown.
 */
export const DEMO_ALLOWED: readonly Rule[] = [...VIEW, ...WORLD_LOCAL];

export const isDemoToken = (t: string | null | undefined): t is string => typeof t === "string" && t.startsWith("dm_");

export function demoAllows(method: string, pathname: string): boolean {
  return DEMO_ALLOWED.some((r) => r.method === method && r.re.test(pathname));
}

const forbidden = (reply: FastifyReply, message: string) => reply.code(403).send({ error: "demo_forbidden", message });

async function readBody(req: FastifyRequest, max = 8_192): Promise<Buffer | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req.raw) {
    const b = Buffer.isBuffer(c) ? c : Buffer.from(c as string);
    size += b.length;
    if (size > max) return null;
    chunks.push(b);
  }
  return Buffer.concat(chunks);
}

function forward(req: FastifyRequest, reply: FastifyReply, world: DemoWorld, body: Buffer | null): void {
  reply.hijack();
  const url = new URL(req.raw.url ?? "/", "http://demo.invalid");
  url.searchParams.delete("token");
  const headers: http.OutgoingHttpHeaders = { accept: req.headers.accept ?? "*/*", authorization: `Bearer ${world.adminToken}` };
  if (req.headers["content-type"]) headers["content-type"] = req.headers["content-type"];
  if (body) headers["content-length"] = body.length;

  const upstream = http.request({ host: "127.0.0.1", port: world.port, method: req.method, path: url.pathname + url.search, headers }, (res) => {
    reply.raw.writeHead(res.statusCode ?? 502, res.headers);
    res.pipe(reply.raw);
    res.on("error", () => reply.raw.end());
  });
  upstream.on("error", () => {
    if (!reply.raw.headersSent) reply.raw.writeHead(502, { "content-type": "application/json" });
    reply.raw.end(JSON.stringify({ error: "demo_world_unavailable" }));
  });
  // a closed browser tab (an SSE stream) must close the connection to the world as well
  req.raw.on("close", () => upstream.destroy());
  if (body) upstream.end(body);
  else if (req.method === "GET") upstream.end();
  else req.raw.pipe(upstream);
}

export function registerDemoRoutes(app: FastifyInstance, o: DemoRoutesOptions): void {
  const now = o.now ?? Date.now;
  const WINDOW = 10 * 60_000;
  const byIp = new Map<string, number[]>();
  let all: number[] = [];

  /** The left-most X-Forwarded-For entry when behind a proxy (Render), else the socket address. Spoofable, hence the global cap. */
  const clientKey = (req: FastifyRequest): string => {
    const xff = req.headers["x-forwarded-for"];
    const first = (Array.isArray(xff) ? xff[0] : xff)?.split(",")[0]?.trim();
    return first || req.socket.remoteAddress || "unknown";
  };

  app.post("/api/demo-session", async (req, reply) => {
    if (!o.worlds.available) return reply.code(503).send({ error: "demo_unavailable", message: "Demo mode needs the vendor emails to be configured on the server." });
    const t = now();
    const key = clientKey(req);
    const mine = (byIp.get(key) ?? []).filter((x) => t - x < WINDOW);
    all = all.filter((x) => t - x < WINDOW);
    if (mine.length >= o.perIpLimit || all.length >= (o.globalLimit ?? o.perIpLimit * 8)) {
      const oldest = mine.length >= o.perIpLimit ? mine[0]! : all[0]!;
      return reply.code(429).header("Retry-After", String(Math.max(1, Math.ceil((oldest + WINDOW - t) / 1000)))).send({ error: "rate_limited", message: "Too many demo sessions from your network. Try again in a few minutes." });
    }
    mine.push(t);
    byIp.set(key, mine);
    all.push(t);
    if (byIp.size > 5_000) for (const [k, v] of byIp) if (!v.some((x) => t - x < WINDOW)) byIp.delete(k);

    const w = await o.worlds.create();
    return reply.code(201).send({ token: w.token, role: "demo", mode: "replay", expires_at: new Date(w.expiresAt).toISOString(), ttl_sec: Math.round((w.expiresAt - w.createdAt) / 1000) });
  });

  // Every /api request that carries a demo token is decided here, before any real route or auth guard can see it.
  app.addHook("onRequest", async (req, reply) => {
    const url = req.raw.url ?? "";
    if (!url.startsWith("/api/") || url.startsWith("/api/demo-session")) return;
    const pathname = url.split("?")[0]!;
    const query = new URL(url, "http://demo.invalid").searchParams.get("token");
    const token = bearerToken(req) ?? query;
    if (!isDemoToken(token)) return; // not a demo token: the normal admin guard decides

    const world = o.worlds.get(token);
    if (!world) return reply.code(401).header("WWW-Authenticate", "Bearer").send({ error: "unauthorized", message: "The demo session expired. Start a new one." });
    // a token in the query string is only for the event stream (EventSource cannot set headers)
    if (query && !(req.method === "GET" && pathname === "/api/events")) return forbidden(reply, "Demo tokens in the query string are only accepted for the event stream.");
    if (!demoAllows(req.method, pathname)) return forbidden(reply, "This action is not available in demo mode. Sign in with the admin token for full access.");

    let body: Buffer | null = null;
    if (req.method === "POST") {
      body = await readBody(req);
      if (body === null) return reply.code(413).send({ error: "payload_too_large" });
      if (/^\/api\/demo\/run\//.test(pathname) && body.length) {
        let mode: unknown;
        try {
          mode = (JSON.parse(body.toString("utf8")) as { mode?: unknown }).mode;
        } catch {
          return reply.code(400).send({ error: "bad_request", message: "Invalid JSON." });
        }
        if (mode !== undefined && mode !== "replay") return forbidden(reply, "Demo mode runs replay scenarios only. Live scenarios need the admin token.");
      }
    }
    forward(req, reply, world, body);
    return reply;
  });
}
