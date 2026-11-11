import Fastify, { type FastifyInstance } from "fastify";
import type { Config } from "./config.js";
import type { GatewayDeps } from "./gateway/pipeline.js";
import { registerMcpRoutes } from "./gateway/mcp.js";
import { registerPolicyRoutes, type AdminDeps } from "./admin/policies.js";
import { registerAdminApi } from "./admin/api.js";
import { registerReconciliationRoutes } from "./reconciliation/routes.js";
import type { DemoRunner } from "./admin/demo-run.js";

export interface AppOptions {
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
      redact: ["req.headers.authorization"],
      serializers: {
        // The SSE endpoint accepts ?token= for EventSource, so never log the query string.
        req: (req) => ({ method: req.method, url: req.url?.split("?")[0], host: req.headers?.host, remoteAddress: req.socket?.remoteAddress }),
      },
    },
  });

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

  return app;
}
