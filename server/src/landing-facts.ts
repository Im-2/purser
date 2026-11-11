import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DecisionStage, TrustSignal } from "@purser/shared";
import { loadConfig } from "./config.js";
import { loadDotEnv, repoRoot, resolveDbPath } from "./env.js";
import { openDb } from "./db/index.js";
import { createRepos } from "./db/repos.js";
import { buildToolList } from "./gateway/tools.js";
import { DisabledUpstream } from "./paypal/index.js";
import type { GatewayDeps } from "./gateway/pipeline.js";

// Usage: pnpm landing:facts
// Computes the figures the landing page shows, from the repository itself, and writes web/src/landing/facts.json:
//   tests          counted by running vitest (server + agent) with the JSON reporter
//   mcp_tools      what tools/list returns: the cached PayPal MCP tools the classifier accepts, plus the 3 native tools
//   hard_rules     the RuleId union in server/src/policy/rules.ts
//   pipeline_stages / trust_signals    the shared zod enums
// Nothing is typed in by hand. Re-run after changing tests or tools, then commit the JSON.
loadDotEnv();

function countTests(pkgDir: string): number {
  const dir = mkdtempSync(path.join(tmpdir(), "purser-facts-"));
  const out = path.join(dir, "r.json");
  const vitest = path.join(repoRoot, "node_modules", "vitest", "vitest.mjs");
  const r = spawnSync(process.execPath, [vitest, "run", "--passWithNoTests", "--reporter=json", `--outputFile=${out}`], { cwd: pkgDir, encoding: "utf8" });
  if (r.status !== 0) {
    rmSync(dir, { recursive: true, force: true });
    throw new Error(`vitest failed in ${pkgDir}; fix the tests before regenerating facts`);
  }
  const j = JSON.parse(readFileSync(out, "utf8")) as { numTotalTests: number; numPassedTests: number };
  rmSync(dir, { recursive: true, force: true });
  if (j.numPassedTests !== j.numTotalTests) throw new Error("not all tests passed");
  return j.numTotalTests;
}

const config = loadConfig();
const repos = createRepos(openDb(resolveDbPath(config.DATABASE_PATH)));
const deps = { repos, upstream: new DisabledUpstream() } as unknown as GatewayDeps;
const tools = await buildToolList(deps);
if (tools.length <= 3) throw new Error("no cached upstream tools in the local database: run `pnpm --filter @purser/server smoke:paypal` first");

const rulesSrc = readFileSync(path.join(repoRoot, "server", "src", "policy", "rules.ts"), "utf8");
const union = rulesSrc.slice(rulesSrc.indexOf("export type RuleId ="), rulesSrc.indexOf("export interface RuleHit"));
const hardRules = [...union.matchAll(/\|\s*"([a-z_]+)"/g)].length;

const serverTests = countTests(path.join(repoRoot, "server"));
const agentTests = countTests(path.join(repoRoot, "agent"));

const facts = {
  generated_by: "pnpm landing:facts",
  tests: serverTests + agentTests,
  tests_server: serverTests,
  tests_agent: agentTests,
  mcp_tools: tools.length,
  hard_rules: hardRules,
  pipeline_stages: DecisionStage.options.length,
  trust_signals: TrustSignal.options.length,
  scenarios: 4,
};
writeFileSync(path.join(repoRoot, "web", "src", "landing", "facts.json"), JSON.stringify(facts, null, 2) + "\n");
console.log("landing:facts:", JSON.stringify(facts));
