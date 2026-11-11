import { loadConfig } from "./config.js";
import path from "node:path";
import { loadDotEnv, repoRoot, resolveDbPath } from "./env.js";
import { buildApp } from "./app.js";
import { openDb } from "./db/index.js";
import { createRepos } from "./db/repos.js";
import { createEventBus } from "./events.js";
import { createLlmClient, describeLlm } from "./ai/llm.js";
import { createReviewer } from "./ai/reviewer.js";
import { createPipelineHooks } from "./ai/hook.js";
import { startApprovalSweeper } from "./approvals/service.js";
import { createDemoRunner } from "./admin/demo-run.js";
import { makeLookalike } from "@purser/shared/lookalike";
import { SEEDED_AGENT_ID } from "./policy/defaults.js";
import { DisabledUpstream, createPayPalClient, createUpstream, type UpstreamClient } from "./paypal/index.js";

loadDotEnv();

const config = loadConfig();
const repos = createRepos(openDb(resolveDbPath(config.DATABASE_PATH)));
const bus = createEventBus();

// PayPal is optional at boot so /health works without credentials; money tools then fail closed.
const paypal = config.PAYPAL_CLIENT_ID && config.PAYPAL_CLIENT_SECRET ? createPayPalClient(config) : null;
const upstream: UpstreamClient = paypal ? createUpstream(paypal, repos) : new DisabledUpstream();

// AI layer: one provider-agnostic client shared by the reviewer and the policy compiler.
const llm = createLlmClient(config);
const reviewer = createReviewer({
  llm,
  repos,
  ttlMs: config.AI_CACHE_TTL_SEC * 1000,
  mode: config.AI_MODE,
  modelHint: config.LLM_MODEL,
  onError: (info) => app.log.warn(info, "AI review fell back (fail-closed or stale verdict)"),
});
const hooks = createPipelineHooks({ repos, reviewer });

const gateway = { repos, upstream, paypal, bus, hooks };

// Attack Lab: scenarios run as background jobs that talk to this server over loopback, like any other client.
const demo = createDemoRunner({
  bus,
  baseUrl: `http://127.0.0.1:${config.PORT}`,
  agentKey: config.AGENT_API_KEY,
  adminToken: config.PURSER_ADMIN_TOKEN,
  llm,
  env:
    config.VENDOR_ACME_EMAIL && config.VENDOR_NORTHWIND_EMAIL
      ? {
          agentId: SEEDED_AGENT_ID,
          acmeEmail: config.VENDOR_ACME_EMAIL,
          northwindEmail: config.VENDOR_NORTHWIND_EMAIL,
          lookalike: makeLookalike(config.VENDOR_ACME_EMAIL),
          ...(config.PAYPAL_CLIENT_ID && config.PAYPAL_CLIENT_SECRET ? { paypal: { clientId: config.PAYPAL_CLIENT_ID, clientSecret: config.PAYPAL_CLIENT_SECRET } } : {}),
        }
      : null,
});

const app = buildApp(config, {
  gateway,
  admin: { repos, llm, adminToken: config.PURSER_ADMIN_TOKEN, gateway, demo },
  webDist: path.join(repoRoot, "web", "dist"), // the built dashboard, if `pnpm --filter @purser/web build` has been run
});

// Background sweeper: marks approvals past their expiry as expired and closes their attempts.
const stopSweeper = startApprovalSweeper(gateway, 30_000);

app.log.info(`AI layer: ${describeLlm(config)}, mode=${config.AI_MODE}, verdict cache ttl=${config.AI_CACHE_TTL_SEC}s`);
if (!llm) app.log.warn("No LLM configured: the AI reviewer will fail closed (escalate) and policy compile is unavailable");
if (!config.PURSER_ADMIN_TOKEN) app.log.warn("PURSER_ADMIN_TOKEN is not set: the admin API is disabled");

if (paypal) {
  // Start the upstream PayPal MCP in the background; the gateway serves native tools meanwhile.
  upstream
    .start()
    .then((tools) => app.log.info({ count: tools.length }, "upstream PayPal MCP ready"))
    .catch((err: Error) => app.log.error({ err: err.message }, "upstream PayPal MCP failed to start; proxied tools will fail closed"));
} else {
  app.log.warn("PAYPAL_CLIENT_ID/SECRET not set: upstream tools and payouts are disabled");
}

const shutdown = async () => {
  stopSweeper();
  await app.close();
  await upstream.close().catch(() => undefined);
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

try {
  await app.listen({ port: config.PORT, host: "0.0.0.0" });
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
