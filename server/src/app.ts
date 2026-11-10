import Fastify, { type FastifyInstance } from "fastify";
import type { Config } from "./config.js";

export function buildApp(config: Config): FastifyInstance {
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

  return app;
}
