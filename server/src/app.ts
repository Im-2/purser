import Fastify, { type FastifyInstance } from "fastify";
import { allowedOrigins, type Config } from "./config.js";
import type { GatewayDeps } from "./gateway/pipeline.js";
import { registerMcpRoutes } from "./gateway/mcp.js";
import { registerPolicyRoutes, type AdminDeps } from "./admin/policies.js";
import { registerAdminApi } from "./admin/api.js";
import { registerReconciliationRoutes } from "./reconciliation/routes.js";
import { registerWeb } from "./web.js";
import type { DemoRunner } from "./admin/demo-run.js";
import { registerDemoRoutes, type DemoRoutesOptions } from "./demo/routes.js";

export interface AppOptions {
  /** Judge demo mode (POST /api/demo-session and the demo-token proxy). Omit to disable it. */
  demoSessions?: DemoRoutesOptions;
  /** Directory of the built dashboard (web/dist). When it exists it is served at /. */
  webDist?: string;
  /** When provided, the MCP gateway is mounted at /mcp. */
  gateway?: GatewayDeps;
  /**
   * When provided, the admin API is mounted. With `gateway` set it is the full admin API (agents, attempts, approvals,
   * kill switch, stats, SSE, demo reset, policies). Without it, only the policy compile/apply routes.
   */
  admin?: AdminDeps & {
    gateway?: GatewayDeps;
    sseHeartbeatMs?: number;
    /** PAYPAL_WEBHOOK_ID, needed to verify /webhooks/paypal. */
    webhookId?: string;
    /** In production the dev-only /api/dev/simulate-webhook route is not registered. Defaults to config NODE_ENV. */
    isProduction?: boolean;
    /** Attack Lab runner (POST /api/demo/run/:scenario). */
    demo?: DemoRunner;
  };
}

export function buildApp(config: Config, opts: AppOptions = {}): FastifyInstance {
  const app = Fastify({
    logger: {
      level: config.LOG_LEVEL,
      // never log credentials: the bearer token, any cookie, and the SSE ?token= query (the serializer below also drops the query)
      redact: ["req.headers.authorization", "req.headers.cookie", "req.headers[\"x-api-key\"]"],
      serializers: {
        // The SSE endpoint accepts ?token= for EventSource, so never log the query string.
        req: (req) => ({ method: req.method, url: req.url?.split("?")[0], host: req.headers?.host, remoteAddress: req.socket?.remoteAddress }),
      },
    },
  });

  // CORS locked to PUBLIC_URL: a browser request from any other origin is refused outright. Same-origin requests (the dashboard
  // served by this server) and non-browser clients (agents, PayPal webhooks: no Origin header) are unaffected.
  const origins = new Set(allowedOrigins(config));
  app.addHook("onRequest", async (req, reply) => {
    const origin = req.headers.origin;
    if (!origin) return;
    let sameHost = false;
    try {
      sameHost = new URL(origin).host === req.headers.host;
    } catch {
      // malformed Origin: treated as foreign
    }
    if (!origins.has(origin) && !sameHost) return reply.code(403).send({ error: "origin_not_allowed" });
    void reply.header("access-control-allow-origin", origin).header("vary", "Origin");
    if (req.method === "OPTIONS") {
      return reply
        .header("access-control-allow-methods", "GET,POST,OPTIONS")
        .header("access-control-allow-headers", "authorization,content-type,mcp-session-id,mcp-protocol-version")
        .header("access-control-max-age", "600")
        .code(204)
        .send();
    }
  });

  // Demo-token requests are decided before any real route sees them (see demo/routes.ts).
  if (opts.demoSessions) registerDemoRoutes(app, opts.demoSessions);

  app.get("/health", async () => ({
    status: "ok",
    service: "purser",
    env: config.PAYPAL_ENV,
  }));

  if (opts.gateway) {
    const mcp = registerMcpRoutes(app, opts.gateway);
    app.addHook("onClose", async () => {
      await mcp.closeAll();
    });
  }
  if (opts.admin) {
    const { gateway, webhookId, isProduction, ...rest } = opts.admin; // rest keeps demo and sseHeartbeatMs
    if (gateway) {
      registerReconciliationRoutes(app, { gateway, adminToken: rest.adminToken, webhookId: webhookId ?? config.PAYPAL_WEBHOOK_ID, isProduction: isProduction ?? config.NODE_ENV === "production" });
      const api = registerAdminApi(app, { ...rest, gateway });
      // preClose, not onClose: Fastify waits for open connections before onClose, and an SSE stream never ends on its own.
      app.addHook("preClose", async () => api.closeStreams());
    } else registerPolicyRoutes(app, rest);
  }
  if (opts.webDist) registerWeb(app, opts.webDist);

  return app;
}
