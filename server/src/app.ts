import Fastify, { type FastifyInstance } from "fastify";
import type { Config } from "./config.js";
import type { GatewayDeps } from "./gateway/pipeline.js";
import { registerMcpRoutes } from "./gateway/mcp.js";
import { registerPolicyRoutes, type AdminDeps } from "./admin/policies.js";

export interface AppOptions {
  /** When provided, the MCP gateway is mounted at /mcp. */
  gateway?: GatewayDeps;
  /** When provided, the policy compile/apply admin routes are mounted. */
  admin?: AdminDeps;
}

export function buildApp(config: Config, opts: AppOptions = {}): FastifyInstance {
  const app = Fastify({
    logger: {
      level: config.LOG_LEVEL,
      redact: ["req.headers.authorization"],
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
  if (opts.admin) registerPolicyRoutes(app, opts.admin);

  return app;
}
