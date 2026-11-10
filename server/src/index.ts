import { loadConfig } from "./config.js";
import { loadDotEnv } from "./env.js";
import { buildApp } from "./app.js";

loadDotEnv();

const config = loadConfig();
const app = buildApp(config);

try {
  await app.listen({ port: config.PORT, host: "0.0.0.0" });
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
