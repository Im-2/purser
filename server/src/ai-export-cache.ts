import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { VERDICT_SEED_FILE } from "./bootstrap.js";
import { loadConfig } from "./config.js";
import { loadDotEnv, resolveDbPath } from "./env.js";
import { openDb } from "./db/index.js";
import { REVIEW_PROMPT_VERSION, VerdictSchema } from "./ai/reviewer.js";

// Usage: pnpm --filter @purser/server ai:export-cache
// Writes the validated reviewer verdicts in the local database to server/seed/ai-verdicts.json. The file holds only
// cache keys (SHA-256 hashes), the model id, and the verdict (verdict, risk, rationale, flags): no credentials.
// Run `pnpm --filter agent run warm` against a server with AI_MODE=live first, so every scenario has a verdict.
loadDotEnv();
const config = loadConfig();
const db = openDb(resolveDbPath(config.DATABASE_PATH));
const rows = db.prepare("SELECT key, verdict_json, model FROM ai_verdicts ORDER BY key").all() as { key: string; verdict_json: string; model: string }[];
const verdicts: { key: string; model: string; verdict: unknown }[] = [];
for (const r of rows) {
  const parsed = VerdictSchema.safeParse(JSON.parse(r.verdict_json));
  if (parsed.success) verdicts.push({ key: r.key, model: r.model, verdict: parsed.data });
}
mkdirSync(path.dirname(VERDICT_SEED_FILE), { recursive: true });
writeFileSync(VERDICT_SEED_FILE, JSON.stringify({ prompt_version: REVIEW_PROMPT_VERSION, verdicts }, null, 2) + "\n");
console.log(`ai:export-cache: wrote ${verdicts.length} verdicts to ${path.relative(process.cwd(), VERDICT_SEED_FILE)}`);
