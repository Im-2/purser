import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { PolicySchema } from "@purser/shared";
import { CompileError, compilePolicy, policyWarnings } from "../ai/compiler.js";
import type { LlmClient } from "../ai/llm.js";
import type { Repos } from "../db/repos.js";
import { makeAdminGuard } from "./auth.js";

export interface AdminDeps {
  repos: Repos;
  llm: LlmClient | null;
  /** PURSER_ADMIN_TOKEN. When unset the admin API is disabled (fail closed). */
  adminToken: string | undefined;
}

const CompileBody = z.object({ agent_id: z.string().min(1).max(100), text: z.string().min(1).max(2000) });
const ApplyBody = z.object({ agent_id: z.string().min(1).max(100), policy: z.unknown(), source_text: z.string().max(2000).optional() });

/** POST /api/policies/compile and /api/policies/apply (admin token required). */
export function registerPolicyRoutes(app: FastifyInstance, deps: AdminDeps): void {
  const guard = makeAdminGuard(() => deps.adminToken);

  app.post("/api/policies/compile", { preHandler: guard }, async (req, reply) => {
    const body = CompileBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "bad_request", issues: body.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`) });
    if (!deps.repos.agents.get(body.data.agent_id)) return reply.code(404).send({ error: "agent_not_found" });
    const current = deps.repos.policies.getActive(body.data.agent_id);
    if (!current) return reply.code(409).send({ error: "no_active_policy", message: "This agent has no active policy to start from." });
    try {
      // Compile only proposes. Applying is a separate, explicit call.
      const r = await compilePolicy({ llm: deps.llm }, { current, text: body.data.text });
      return { policy: r.policy, warnings: r.warnings, diff: r.diff, unsupported: r.unsupported, model: r.model, latency_ms: r.latency_ms };
    } catch (e) {
      if (e instanceof CompileError) return reply.code(e.kind === "ai_unavailable" ? 503 : 422).send({ error: e.kind, message: e.message });
      throw e;
    }
  });

  app.post("/api/policies/apply", { preHandler: guard }, async (req, reply) => {
    const body = ApplyBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "bad_request", issues: body.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`) });
    if (!deps.repos.agents.get(body.data.agent_id)) return reply.code(404).send({ error: "agent_not_found" });
    const policy = PolicySchema.safeParse(body.data.policy);
    if (!policy.success) return reply.code(400).send({ error: "invalid_policy", issues: policy.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`) });
    if (policy.data.agent_id !== body.data.agent_id) return reply.code(400).send({ error: "agent_mismatch", message: "policy.agent_id must match agent_id." });
    const row = deps.repos.policies.apply(body.data.agent_id, policy.data, body.data.source_text);
    return { id: row.id, version: row.version, active: true, warnings: policyWarnings(policy.data) };
  });
}
