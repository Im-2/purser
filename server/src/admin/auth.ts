import { timingSafeEqual } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";

/** Constant-time comparison that does not leak the token length through timing. */
export function tokensMatch(given: string, expected: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function bearerToken(req: FastifyRequest): string | null {
  const h = req.headers.authorization;
  const m = typeof h === "string" ? /^Bearer\s+(\S+)$/i.exec(h) : null;
  return m?.[1] ?? null;
}

/**
 * Admin bearer check. With `allowQueryToken` the token may also come from ?token= (needed because the browser's
 * EventSource cannot set headers). When PURSER_ADMIN_TOKEN is unset the admin API is disabled (503, fail closed).
 */
export function makeAdminGuard(getToken: () => string | undefined, opts: { allowQueryToken?: boolean } = {}) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    const expected = getToken();
    if (!expected) return reply.code(503).send({ error: "admin_disabled", message: "PURSER_ADMIN_TOKEN is not set." });
    const q = opts.allowQueryToken ? (req.query as { token?: unknown } | undefined)?.token : undefined;
    const given = bearerToken(req) ?? (typeof q === "string" ? q : null);
    if (!given || !tokensMatch(given, expected)) return reply.code(401).header("WWW-Authenticate", "Bearer").send({ error: "unauthorized" });
  };
}
