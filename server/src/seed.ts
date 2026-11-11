import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { loadConfig } from "./config.js";
import { loadDotEnv, repoRoot, resolveDbPath } from "./env.js";
import { openDb } from "./db/index.js";
import { createRepos } from "./db/repos.js";
import { seedDemoWorld } from "./bootstrap.js";

// Usage: pnpm --filter @purser/server seed [--reset] [--write-env]
//   --reset      wipe seeded data and recreate (a new API key is issued)
//   --write-env  save the agent API key to .env as AGENT_API_KEY instead of printing it
const AGENT_ID = "agent_ops_01";

loadDotEnv();
const args = new Set(process.argv.slice(2));
const config = loadConfig();
const acme = config.VENDOR_ACME_EMAIL;
const northwind = config.VENDOR_NORTHWIND_EMAIL;
if (!acme || !northwind) {
  console.error("seed: VENDOR_ACME_EMAIL and VENDOR_NORTHWIND_EMAIL must be set in .env");
  process.exit(1);
}

const dbPath = resolveDbPath(config.DATABASE_PATH);
const db = openDb(dbPath);
const repos = createRepos(db);
const existing = repos.agents.get(AGENT_ID);

if (existing && !args.has("--reset")) {
  console.log(`seed: ${AGENT_ID} already exists (its API key is shown only once, at creation). Use --reset to reissue.`);
  console.log(`seed: database ready at ${dbPath}`);
  process.exit(0);
}

function saveKeyToEnv(apiKey: string): void {
  const envPath = path.join(repoRoot, ".env");
  const text = existsSync(envPath) ? readFileSync(envPath, "utf8") : "";
  const line = `AGENT_API_KEY=${apiKey}`;
  const next = /^AGENT_API_KEY=.*$/m.test(text)
    ? text.replace(/^AGENT_API_KEY=.*$/m, line)
    : text + (text && !text.endsWith("\n") ? "\n" : "") + line + "\n";
  writeFileSync(envPath, next);
}

let printedKey: string | null = null;
db.transaction(() => {
  if (existing) {
    db.exec(
      "DELETE FROM reconciliation; DELETE FROM ledger; DELETE FROM approvals; DELETE FROM attempts; DELETE FROM policies; DELETE FROM agents; DELETE FROM payees;",
    );
  }
  const apiKey = "pk_" + randomBytes(24).toString("base64url");
  seedDemoWorld(repos, { acmeEmail: acme, northwindEmail: northwind, apiKey });
  if (args.has("--write-env")) saveKeyToEnv(apiKey);
  else printedKey = apiKey;
})();

if (printedKey) console.log(`seed: agent API key (shown once, store it now): ${printedKey}`);
else console.log("seed: agent API key saved to .env as AGENT_API_KEY (not printed)");
console.log(`seed: created ${AGENT_ID}, 2 payees, 1 active policy`);
console.log(`seed: database ready at ${dbPath}`);
