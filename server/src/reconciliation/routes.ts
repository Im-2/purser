import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import { makeAdminGuard } from "../admin/auth.js";
import type { GatewayDeps } from "../gateway/pipeline.js";
import { verifyWebhookSignature } from "../paypal/index.js";
import { EnvelopeSchema } from "./events.js";
import { processWebhookEvent } from "./matcher.js";
import { runReconciliation } from "./run.js";

export interface ReconRoutesDeps {
  gateway: GatewayDeps;
  adminToken: string | undefined;
  /** PAYPAL_WEBHOOK_ID. Without it webhooks cannot be verified, so they are refused (fail closed). */
  webhookId: string | undefined;
  /** When true the dev-only simulate route is not registered at all. */
  isProduction: boolean;
}

const FindingTypes = ["unrecorded_movement", "amount_mismatch", "duplicate", "payout_denied_or_unclaimed"] as const;
const ListQuery = z.object({
  finding_type: z.enum(FindingTypes).optional(),
  matched: z.enum(["true", "false"]).optional(),
  limit: z.coerce.number().int().min(1).max(1000).default(200),
});
const RunBody = z
  .object({
    /** ISO timestamp: only reconcile payouts recorded since then. */
    since: z.string().datetime({ offset: true }).optional(),
    lookback_hours: z.number().min(0.1).max(24 * 30).optional(),
  })
  .strict()
  .optional();
const SimulateBody = EnvelopeSchema.extend({ id: z.string().min(1).max(200).optional() });

const parseJson = <T>(s: string, fb: T): T => {
  try {
    return JSON.parse(s) as T;
  } catch {
    return fb;
  }
};

/** Mount the PayPal webhook receiver, the reconciliation admin routes and the dev-only simulator. */
export function registerReconciliationRoutes(app: FastifyInstance, deps: ReconRoutesDeps): void {
  const { gateway } = deps;
  const { repos, bus } = gateway;
  const guard = makeAdminGuard(() => deps.adminToken);
  const reconDeps = { repos, bus };
  const bad = (reply: FastifyReply, e: z.ZodError) => reply.code(400).send({ error: "bad_request", issues: e.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`) });

  // ---------- public webhook receiver: authenticated by PayPal's signature, not by the admin token ----------
  // Encapsulated so the raw-body parser applies to this route only. Verification needs the exact bytes PayPal signed.
  void app.register(async (scope) => {
    scope.addContentTypeParser("application/json", { parseAs: "string", bodyLimit: 1_048_576 }, (_req, body, done) => done(null, body));

    scope.post("/webhooks/paypal", async (req, reply) => {
      const raw = typeof req.body === "string" ? req.body : "";
      if (!deps.webhookId || !gateway.paypal) return reply.code(503).send({ error: "webhook_not_configured", message: "PAYPAL_WEBHOOK_ID (and PayPal credentials) are required to verify webhooks." });

      // 1. Verify first, before anything is parsed, stored or acted on.
      let verified: boolean;
      try {
        verified = await verifyWebhookSignature(gateway.paypal, { headers: req.headers, rawBody: raw, webhookId: deps.webhookId });
      } catch {
        // PayPal's verify endpoint was unreachable: refuse (503) so PayPal retries the delivery later. Never accept unverified.
        return reply.code(503).send({ error: "verification_unavailable" });
      }
      if (!verified) return reply.code(401).send({ error: "invalid_signature" });

      // 2. Parse, dedupe on the event id, reconcile (database only, so this answers quickly).
      const env = EnvelopeSchema.safeParse(parseJson(raw, null));
      if (!env.success) return bad(reply, env.error);
      const r = processWebhookEvent(reconDeps, env.data, "webhook");
      return { status: r.outcome, findings: r.findings.length };
    });
  });

  // ---------- findings ----------
  app.get("/api/reconciliation", { preHandler: guard }, async (req, reply) => {
    const q = ListQuery.safeParse(req.query);
    if (!q.success) return bad(reply, q.error);
    const rows = repos.reconciliation.list({ limit: q.data.limit, finding_type: q.data.finding_type, matched: q.data.matched === undefined ? undefined : q.data.matched === "true" });
    const all = repos.reconciliation.list({ limit: 1000 });
    const counts: Record<string, number> = { matched: 0 };
    for (const r of all) {
      if (r.matched) counts.matched = (counts.matched ?? 0) + 1;
      if (r.finding_type) counts[r.finding_type] = (counts[r.finding_type] ?? 0) + 1;
    }
    return {
      counts,
      findings: rows.map((r) => ({
        id: r.id,
        ts: new Date(r.ts).toISOString(),
        matched: Boolean(r.matched),
        finding_type: r.finding_type,
        ledger_id: r.ledger_id,
        paypal_event_id: r.paypal_event_id,
        event_type: r.event_type,
        detail: parseJson<Record<string, unknown>>(r.detail_json, {}),
      })),
    };
  });

  // ---------- manual run ----------
  app.post("/api/reconciliation/run", { preHandler: guard }, async (req, reply) => {
    const b = RunBody.safeParse(req.body ?? undefined);
    if (!b.success) return bad(reply, b.error);
    const now = (gateway.now ?? Date.now)();
    const sinceMs = b.data?.since ? Date.parse(b.data.since) : b.data?.lookback_hours ? now - b.data.lookback_hours * 3_600_000 : undefined;
    return runReconciliation({ ...reconDeps, paypal: gateway.paypal, now: gateway.now }, { sinceMs });
  });

  // ---------- dev-only simulator (never registered in production) ----------
  if (!deps.isProduction) {
    app.post("/api/dev/simulate-webhook", { preHandler: guard }, async (req, reply) => {
      const b = SimulateBody.safeParse(req.body);
      if (!b.success) return bad(reply, b.error);
      // Signature verification is skipped here, and only here, so the demo works without a public URL.
      const env = { ...b.data, id: b.data.id ?? `SIM-${randomUUID()}` };
      const r = processWebhookEvent(reconDeps, env, "simulated");
      return { simulated: true, signature_verified: false, ...r };
    });
  }
}
