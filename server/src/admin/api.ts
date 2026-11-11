import { randomBytes, randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import type { PurserEvent } from "@purser/shared";
import { approveApproval, denyApproval, sweepExpiredApprovals, type ApprovalFailure } from "../approvals/service.js";
import { approvalSummary } from "../approvals/summary.js";
import { resetDemo } from "../control/demo.js";
import { freezeAgent, freezeAll, getFreezeInfo, isGloballyFrozen, unfreezeAgent, unfreezeAll } from "../control/killswitch.js";
import type { ApprovalRow, AttemptRow } from "../db/repos.js";
import { attemptRowToRecord } from "../events.js";
import type { GatewayDeps } from "../gateway/pipeline.js";
import { fromMinor } from "../money.js";
import { defaultPolicy } from "../policy/defaults.js";
import { parseScenarioId } from "@purser/agent";
import { makeAdminGuard } from "./auth.js";
import type { DemoRunner } from "./demo-run.js";
import { registerPolicyRoutes, type AdminDeps } from "./policies.js";

export interface AdminApiDeps extends AdminDeps {
  gateway: GatewayDeps;
  /** Attack Lab runner. Without it POST /api/demo/run/:scenario answers 503. */
  demo?: DemoRunner;
  /** SSE heartbeat period. Default 15 000 ms. */
  sseHeartbeatMs?: number;
}

const Id = z.object({ id: z.string().min(1).max(120) });
const AgentIdParam = z.object({ agentId: z.string().min(1).max(120) });
const AttemptsQuery = z.object({
  agent: z.string().min(1).max(120).optional(),
  decision: z.enum(["allow", "deny", "escalate"]).optional(),
  limit: z.coerce.number().int().min(1).max(1000).default(100),
});
const ApprovalsQuery = z.object({ status: z.enum(["pending", "approved", "denied", "expired"]).optional() });
const NewAgentBody = z.object({ name: z.string().min(1).max(80), mandate: z.string().max(500).optional() });
const ScenarioParam = z.object({ scenario: z.string().min(1).max(40) });
const RunScenarioBody = z.object({ mode: z.enum(["replay", "live"]).default("replay"), reset: z.boolean().default(true) }).strict();

const issues = (e: z.ZodError) => e.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`);
const parseJson = <T>(s: string | null, fallback: T): T => {
  if (s === null) return fallback;
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
};
const startOfToday = () => {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};

const STATUS_FOR: Record<ApprovalFailure["code"], number> = {
  not_found: 404,
  already_resolved: 409,
  expired: 410,
  agent_frozen: 423,
  no_policy: 409,
  not_executable: 422,
  policy_denies: 409,
};

/** Mount the admin REST API and SSE feed (SPEC section 8, except reconciliation). Every route needs the admin token. */
export function registerAdminApi(app: FastifyInstance, deps: AdminApiDeps): { closeStreams: () => void } {
  const { gateway } = deps;
  const { repos, bus } = gateway;
  const guard = makeAdminGuard(() => deps.adminToken);
  const sseGuard = makeAdminGuard(() => deps.adminToken, { allowQueryToken: true });
  const bad = (reply: FastifyReply, e: z.ZodError) => reply.code(400).send({ error: "bad_request", issues: issues(e) });

  registerPolicyRoutes(app, deps);

  // ---------- attempts ----------
  const approvalFor = (row: AttemptRow) => {
    if (!row.approval_id) return null;
    const ap = repos.approvals.get(row.approval_id);
    return ap ? { ...approvalSummary(repos, ap, (gateway.now ?? Date.now)()), decided_by: ap.decided_by, decided_at: ap.decided_at ? new Date(ap.decided_at).toISOString() : null } : null;
  };
  const attemptDetail = (row: AttemptRow) => {
    const ledger = row.ledger_id ? repos.ledger.get(row.ledger_id) : undefined;
    return {
      ...attemptRowToRecord(row),
      amount_display: row.amount === null ? null : fromMinor(row.amount),
      rule_hits_detail: parseJson<unknown[]>(row.rule_hits_json, []),
      signals_detail: parseJson<unknown[]>(row.signals_json, []),
      approval: approvalFor(row),
      ledger: ledger ? { id: ledger.id, status: ledger.status, amount: ledger.amount, currency: ledger.currency, paypal_ref: parseJson(ledger.paypal_ref_json, {}) } : null,
    };
  };

  app.get("/api/attempts", { preHandler: guard }, async (req, reply) => {
    const q = AttemptsQuery.safeParse(req.query);
    if (!q.success) return bad(reply, q.error);
    return { attempts: repos.attempts.list({ agent: q.data.agent, decision: q.data.decision, limit: q.data.limit }).map(attemptDetail) };
  });
  app.get("/api/attempts/:id", { preHandler: guard }, async (req, reply) => {
    const p = Id.safeParse(req.params);
    if (!p.success) return bad(reply, p.error);
    const row = repos.attempts.get(p.data.id);
    return row ? attemptDetail(row) : reply.code(404).send({ error: "not_found" });
  });

  // ---------- agents and the kill switch ----------
  const agentView = (a: ReturnType<typeof repos.agents.get> & object) => {
    const pending = repos.approvals.list("pending").filter((ap) => repos.attempts.get(ap.attempt_id)?.agent_id === a.id).length;
    return {
      id: a.id,
      name: a.name,
      mandate: a.mandate,
      status: a.status,
      effective_status: isGloballyFrozen(repos) ? "frozen" : a.status,
      freeze: a.status === "frozen" ? getFreezeInfo(repos, a.id) : null,
      pending_approvals: pending,
      created_at: new Date(a.created_at).toISOString(),
    };
  };
  app.get("/api/agents", { preHandler: guard }, async () => ({ global_freeze: isGloballyFrozen(repos), agents: repos.agents.list().map(agentView) }));

  app.post("/api/agents", { preHandler: guard }, async (req, reply) => {
    const b = NewAgentBody.safeParse(req.body);
    if (!b.success) return bad(reply, b.error);
    const apiKey = "pk_" + randomBytes(24).toString("base64url");
    const agent = repos.agents.create({ id: `agent_${randomUUID().replace(/-/g, "").slice(0, 10)}`, name: b.data.name, apiKey, mandate: b.data.mandate ?? "" });
    // A new agent starts with the default policy and an empty allowlist: every new payee needs approval.
    repos.policies.apply(agent.id, defaultPolicy({ agentId: agent.id, allowlist: [], mandate: b.data.mandate }), "Default policy for a new agent");
    return reply.code(201).send({ agent: agentView(agent), api_key: apiKey, note: "The API key is shown once. Only its hash is stored." });
  });

  const setFreeze = (frozen: boolean) => async (req: { params: unknown }, reply: FastifyReply) => {
    const p = Id.safeParse(req.params);
    if (!p.success) return bad(reply, p.error);
    const ok = frozen ? freezeAgent({ repos, bus }, p.data.id, { reason: "admin" }) : unfreezeAgent({ repos, bus }, p.data.id);
    if (!ok) return reply.code(404).send({ error: "agent_not_found" });
    return agentView(repos.agents.get(p.data.id)!);
  };
  app.post("/api/agents/:id/freeze", { preHandler: guard }, setFreeze(true));
  app.post("/api/agents/:id/unfreeze", { preHandler: guard }, setFreeze(false));
  app.post("/api/freeze-all", { preHandler: guard }, async () => ({ global_freeze: true, agents_frozen: freezeAll({ repos, bus }) }));
  app.post("/api/unfreeze-all", { preHandler: guard }, async () => ({ global_freeze: false, agents_unfrozen: unfreezeAll({ repos, bus }) }));

  // ---------- policies (read; compile and apply live in policies.ts) ----------
  app.get("/api/policies/:agentId", { preHandler: guard }, async (req, reply) => {
    const p = AgentIdParam.safeParse(req.params);
    if (!p.success) return bad(reply, p.error);
    if (!repos.agents.get(p.data.agentId)) return reply.code(404).send({ error: "agent_not_found" });
    return {
      active: repos.policies.getActive(p.data.agentId) ?? null,
      history: repos.policies.history(p.data.agentId).map((h) => ({ id: h.id, version: h.version, active: Boolean(h.active), source_text: h.source_text, created_at: new Date(h.created_at).toISOString() })),
    };
  });

  // ---------- approvals ----------
  const approvalView = (ap: ApprovalRow) => {
    const attempt = repos.attempts.get(ap.attempt_id);
    return { ...approvalSummary(repos, ap, (gateway.now ?? Date.now)()), attempt_id: ap.attempt_id, channel: ap.channel, decided_by: ap.decided_by, decided_at: ap.decided_at ? new Date(ap.decided_at).toISOString() : null, attempt: attempt ? attemptDetail(attempt) : null };
  };
  app.get("/api/approvals", { preHandler: guard }, async (req, reply) => {
    const q = ApprovalsQuery.safeParse(req.query);
    if (!q.success) return bad(reply, q.error);
    sweepExpiredApprovals(gateway); // keep "pending" honest: nothing past its expiry is listed as pending
    return { approvals: repos.approvals.list(q.data.status).map(approvalView) };
  });

  const failure = (reply: FastifyReply, f: ApprovalFailure) => reply.code(STATUS_FOR[f.code]).send({ error: f.code, message: f.message, ...("approval" in f ? { approval: f.approval } : {}), ...("rule_hits" in f ? { rule_hits: f.rule_hits } : {}) });
  app.post("/api/approvals/:id/approve", { preHandler: guard }, async (req, reply) => {
    const p = Id.safeParse(req.params);
    if (!p.success) return bad(reply, p.error);
    const r = await approveApproval(gateway, p.data.id, "admin");
    return r.ok ? { approval: r.approval, result: r.result } : failure(reply, r);
  });
  app.post("/api/approvals/:id/deny", { preHandler: guard }, async (req, reply) => {
    const p = Id.safeParse(req.params);
    if (!p.success) return bad(reply, p.error);
    const r = denyApproval(gateway, p.data.id, "admin");
    return r.ok ? { approval: r.approval } : failure(reply, r);
  });

  // ---------- stats ----------
  app.get("/api/stats", { preHandler: guard }, async () => {
    const since = startOfToday();
    const s = repos.attempts.stats(since);
    sweepExpiredApprovals(gateway);
    const agents = repos.agents.list();
    return {
      window: "today",
      since: new Date(since).toISOString(),
      spend_today_minor: s.spend_minor,
      spend_today: fromMinor(s.spend_minor),
      blocked_count: s.blocked_count,
      blocked_amount_minor: s.blocked_minor,
      blocked_amount: fromMinor(s.blocked_minor),
      pending_approvals: repos.approvals.list("pending").length,
      agents_frozen: agents.filter((a) => a.status === "frozen").length,
      global_freeze: isGloballyFrozen(repos),
    };
  });

  // ---------- demo ----------
  app.post("/api/demo/reset", { preHandler: guard }, async () => resetDemo({ repos, bus }));
  app.post("/api/demo/run/:scenario", { preHandler: guard }, async (req, reply) => {
    const p = ScenarioParam.safeParse(req.params);
    if (!p.success) return bad(reply, p.error);
    const id = parseScenarioId(p.data.scenario);
    if (!id) return reply.code(404).send({ error: "unknown_scenario", message: "Scenarios are A, B, C and D." });
    const b = RunScenarioBody.safeParse(req.body ?? {});
    if (!b.success) return bad(reply, b.error);
    if (!deps.demo) return reply.code(503).send({ error: "demo_not_configured", message: "The Attack Lab is not configured on this server." });
    const r = deps.demo.start(id, { mode: b.data.mode, reset: b.data.reset });
    if (!r.ok) return reply.code(r.code === "busy" ? 409 : r.code === "live_unavailable" ? 422 : 503).send({ error: r.code, message: r.message });
    // The run continues in the background; progress arrives as scenario_log events on /api/events.
    return reply.code(202).send({ run_id: r.run_id, scenario: r.scenario, mode: r.mode, events: "/api/events (scenario_log)" });
  });
  app.get("/api/demo/status", { preHandler: guard }, async () => deps.demo?.status() ?? { running: null, last: null });

  // ---------- SSE ----------
  const streams = new Set<() => void>();
  app.get("/api/events", { preHandler: sseGuard }, async (req, reply) => {
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive", "X-Accel-Buffering": "no" });
    res.write("retry: 3000\n: connected\n\n");

    const send = (e: PurserEvent) => {
      if (!res.writableEnded) res.write(`event: ${e.type}\ndata: ${JSON.stringify(e.data)}\n\n`);
    };
    const unsubscribe = bus.subscribe(send);
    const heartbeat = setInterval(() => {
      if (!res.writableEnded) res.write(`: heartbeat ${Date.now()}\n\n`);
    }, deps.sseHeartbeatMs ?? 15_000);
    const cleanup = () => {
      clearInterval(heartbeat);
      unsubscribe();
      streams.delete(cleanup);
      if (!res.writableEnded) res.end();
    };
    streams.add(cleanup);
    req.raw.on("close", cleanup);
  });

  return { closeStreams: () => [...streams].forEach((c) => c()) };
}
