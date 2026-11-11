import { waitForHealth } from "./api.js";
import { loadDotEnv, readEnv } from "./env.js";
import { runAll, runScenario } from "./runner.js";
import { ALL_ORDER, parseScenarioId, type Mode } from "./scenarios/index.js";
import { c, consoleLog, printResult, runnerOptions } from "./setup.js";

// Usage (from the repo root):
//   pnpm --filter @purser/agent run scenario A --mode replay|live [--no-reset]
//   pnpm --filter @purser/agent run all [--mode replay|live]
//   pnpm --filter @purser/agent run warm      replay every scenario once to fill the AI verdict cache (server must run with AI_MODE=live)
// The Purser server must be running (pnpm dev). The agent key and admin token come from .env and are never printed.
const USAGE = "usage: scenario <A|B|C|D> [--mode replay|live] [--no-reset] | all [--mode replay|live] | warm";

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

async function main(): Promise<number> {
  loadDotEnv();
  const [cmd, ...rest] = process.argv.slice(2);
  if (!cmd) {
    console.error(USAGE);
    return 2;
  }
  const modeArg = flag(rest, "--mode") ?? "replay";
  if (modeArg !== "replay" && modeArg !== "live") {
    console.error(`--mode must be replay or live. ${USAGE}`);
    return 2;
  }
  const mode: Mode = cmd === "warm" ? "replay" : modeArg;

  const env = readEnv();
  let opts;
  try {
    opts = runnerOptions(env, { live: mode === "live", log: consoleLog });
  } catch (e) {
    console.error((e as Error).message);
    return 1;
  }
  if (!(await waitForHealth(opts.baseUrl, 5000))) {
    console.error(`Purser is not reachable at ${opts.baseUrl}. Start it with: pnpm dev`);
    return 1;
  }
  if (cmd === "warm" && env.aiMode === "cached_only") console.log(c.yellow("Note: AI_MODE=cached_only in .env applies to a server started from it; warming needs a server running with AI_MODE=live."));

  if (cmd === "scenario") {
    const id = parseScenarioId(rest[0] ?? "");
    if (!id) {
      console.error(USAGE);
      return 2;
    }
    const r = await runScenario(id, mode, { ...opts, reset: !rest.includes("--no-reset") });
    printResult(r);
    return r.error ? 1 : 0;
  }
  if (cmd === "all" || cmd === "warm") {
    const results = await runAll(mode, opts, ALL_ORDER);
    results.forEach(printResult);
    const failed = results.filter((r) => r.error);
    console.log(`\n${failed.length ? c.red(`${failed.length} scenario(s) had errors`) : c.green("all scenarios ran")} (${mode} mode)`);
    return failed.length ? 1 : 0;
  }
  console.error(USAGE);
  return 2;
}

process.exitCode = await main().catch((e: Error) => {
  console.error(`agent: ${e.message}`);
  return 1;
});
