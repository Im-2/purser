import { existsSync } from "node:fs";
import path from "node:path";
import fastifyStatic from "@fastify/static";
import type { FastifyInstance } from "fastify";

/** Paths that belong to the backend. They must never fall through to the dashboard's index.html. */
const BACKEND_PREFIX = /^\/(api|mcp|webhooks|health)(\/|\?|$)/;

/**
 * Serve the built dashboard (web/dist) from the same origin as the API. Hash routing means every page is index.html, so the only
 * fallback needed is for direct hits on unknown non-backend paths. Returns false when there is no build to serve.
 */
export function registerWeb(app: FastifyInstance, distDir: string): boolean {
  if (!existsSync(path.join(distDir, "index.html"))) return false;

  void app.register(fastifyStatic, {
    root: distDir,
    wildcard: false,
    index: ["index.html"],
    // web/dist ships .br and .gz copies of every text asset (see web/scripts/precompress.mjs); serve them when the browser accepts them
    preCompressed: true,
    cacheControl: false,
    setHeaders: (reply, filePath) => {
      // hashed assets never change; the HTML shell must always be revalidated
      void reply.header("Cache-Control", /[\\/]assets[\\/]/.test(filePath) ? "public, max-age=31536000, immutable" : "no-cache");
    },
  });

  app.setNotFoundHandler((req, reply) => {
    if (req.method === "GET" && !BACKEND_PREFIX.test(req.url) && (req.headers.accept ?? "").includes("text/html")) {
      return reply.header("Cache-Control", "no-cache").type("text/html").sendFile("index.html");
    }
    return reply.code(404).send({ error: "not_found" });
  });
  return true;
}
