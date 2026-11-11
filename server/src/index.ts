import { loadConfig } from "./config.js";
import { loadDotEnv, resolveDbPath } from "./env.js";
import { buildApp } from "./app.js";
import { openDb } from "./db/index.js";
import { createRepos } from "./db/repos.js";
import { createEventBus } from "./events.js";
import { DisabledUpstream, createPayPalClient, createUpstream, type UpstreamClient } from "./paypal/index.js";

loadDotEnv();

const config = loadConfig();
const repos = createRepos(openDb(resolveDbPath(config.DATABASE_PATH)));
const bus = createEventBus();

// PayPal is optional at boot so /health works without credentials; money tools then fail closed.
const paypal = config.PAYPAL_CLIENT_ID && config.PAYPAL_CLIENT_SECRET ? createPayPalClient(config) : null;
const upstream: UpstreamClient = paypal ? createUpstream(paypal, repos) : new DisabledUpstream();

const app = buildApp(config, { gateway: { repos, upstream, paypal, bus } });

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
