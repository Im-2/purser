import { loadConfig } from "./config.js";
import { buildApp } from "./app.js";

try {
  process.loadEnvFile?.(); // Node 20.12+/21.7+: load .env from the working directory
} catch {
  // no .env file; rely on the real environment
}

const config = loadConfig();
const app = buildApp(config);

try {
  await app.listen({ port: config.PORT, host: "0.0.0.0" });
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
