import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { AdminApi, waitForHealth, type AttemptView } from "./api.js";
import { loadDotEnv, readEnv, repoRoot } from "./env.js";
import { runScenario, type ScenarioResult } from "./runner.js";
import { ALL_ORDER, type ScenarioId } from "./scenarios/index.js";
import { SEEDED_AGENT_ID, c, runnerOptions } from "./setup.js";

// pnpm demo:verify
//
// Starts its own Purser server in REPLAY conditions (AI_MODE=cached_only, and an LLM address that goes nowhere, so a real model
// call is impossible), resets the demo state, runs all four scenarios with the scripted agent, and checks the decisions:
//   D allowed | A escalated with lookalike_payee, then denied by a human via the API | B ends in a deny (structuring / daily cap)
//   C ends in a velocity deny with the agent frozen by the circuit breaker.
// It needs verdicts in the AI cache (run `pnpm --filter agent run warm` once against a live server first), and uses the
// real PayPal sandbox for D, B and C (real sandbox payouts, a sandbox capture and refunds).
// Prints a green/red summary and exits non-zero on any failure. Stop the dev server first: both use the same database.
//   --external   use the server already running at PORT instead of starting one (its AI_MODE then applies)

interface Check {
  scenario: string;
  name: string;
  pass: boolean;
  detail?: string;
}
const checks: Check[] = [];
const check = (scenario: string, name: string, pass: boolean, detail?: string) => void checks.push({ scenario, name, pass, detail });

const nonRead = (r: ScenarioResult) => r.attempts.filter((a) => a.tool_class !== "read");
const hitIds = (a: AttemptView) => a.rule_hits_detail.map((h) => h.id);
const sigIds = (a: AttemptView) => a.signals_detail.map((s) => (typeof s === "string" ? s : s.id));

function killTree(child: ChildProcess): void {
  if (!child.pid) return;
  if (process.platform === "win32") spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
  else child.kill("SIGTERM");
}

async function startOfflineServer(port: number): Promise<{ child: ChildProcess; tail: () => string }> {
  const tsxCli = createRequire(import.meta.url).resolve("tsx/cli");
  const entry = path.join(repoRoot, "server", "src", "index.ts");
  let out = "";
  const child = spawn(process.execPath, [tsxCli, entry], {
    cwd: repoRoot,
    windowsHide: true,
    env: {
      ...process.env,
      PORT: String(port),
      PUBLIC_URL: `http://127.0.0.1:${port}`,
      AI_MODE: "cached_only", // replay: verdicts come from the cache only
      LLM_PROVIDER: "openai_compat",
      LLM_BASE_URL: "http://127.0.0.1:9/v1", // nothing listens here: any attempt to reach a model fails
      LLM_API_KEY: "offline-replay-no-network",
      LOG_LEVEL: "info",
    },
  });
  child.stdout?.on("data", (d: Buffer) => (out = (out + d.toString()).slice(-6000)));
  child.stderr?.on("data", (d: Buffer) => (out = (out + d.toString()).slice(-6000)));
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`the verification server exited early:\n${out.slice(-800)}`);
    if (/upstream PayPal MCP (ready|failed)/.test(out)) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  if (!/upstream PayPal MCP ready/.test(out)) throw new Error(`the upstream PayPal MCP did not start:\n${out.slice(-800)}`);
  return { child, tail: () => out };
}

async function main(): Promise<number> {
  loadDotEnv();
  const env = readEnv();
  const external = process.argv.includes("--external");
  const port = external ? env.port : Number(process.env.DEMO_VERIFY_PORT ?? 8811);
  const baseUrl = `http://127.0.0.1:${port}`;

  let child: ChildProcess | null = null;
  try {
    if (!external) {
      if (await waitForHealth(baseUrl, 800)) throw new Error(`port ${port} is already in use by something that answers /health; set DEMO_VERIFY_PORT or stop it`);
      console.log(c.dim(`Starting an offline-replay server on ${baseUrl} (AI_MODE=cached_only, LLM unreachable) ...`));
      child = (await startOfflineServer(port)).child;
      if (!(await waitForHealth(baseUrl, 20_000))) throw new Error("the verification server did not answer /health");
    } else if (!(await waitForHealth(baseUrl, 3000))) throw new Error(`no server at ${baseUrl}`);

    const opts = runnerOptions(env, { baseUrl });
    const api = new AdminApi(baseUrl, opts.adminToken);
    await api.reset();
    const seeded = (await api.policy(SEEDED_AGENT_ID)).active;
    const strip = (p: Record<string, unknown> | null) => JSON.stringify({ ...p, version: 0 });

    const results: Record<string, ScenarioResult> = {};
    for (const id of ALL_ORDER) {
      console.log(c.dim(`Running scenario ${id} (replay) ...`));
      const result = await runScenario(id, "replay", { ...opts, reset: true });
      results[id] = result;
      if (id === "A") {
        // The human step: deny the escalated look-alike payout through the admin API.
        const pending = result.pending_approvals;
        check("A", "one approval is waiting for a human", pending.length === 1, `pending=${pending.length}`);
        for (const approvalId of pending) await api.deny(approvalId);
        const after = (await api.attempts(50)).find((x) => x.id === result.attempts.find((a) => a.tool_class !== "read")?.id);
        check("A", "after the human denies it, the attempt is closed as a denial", after?.decision === "deny" && after.decision_stage === "approval", `${after?.decision}/${after?.decision_stage}`);
        check("A", "denying created no ledger row (no money moved)", !after?.ledger, `ledger=${after?.ledger?.id ?? "none"}`);
        check("A", "the approval shows as denied", after?.approval?.status === "denied", `approval=${after?.approval?.status}`);
      }
    }

    // ---- D: happy path ----
    {
      const r = results.D!;
      const a = nonRead(r);
      check("D", "scenario ran without error", !r.error, r.error);
      check("D", "one payout attempt, allowed", a.length === 1 && a[0]!.decision === "allow", a.map((x) => x.decision).join(","));
      check("D", "it executed in the sandbox and is in the ledger", Boolean(a[0]?.ledger) && r.calls[0]?.outcome === "executed", `ledger=${a[0]?.ledger?.status ?? "none"} outcome=${r.calls[0]?.outcome}`);
      check("D", "$120.00 paid to the allowlisted vendor", a[0]?.amount_display === "120.00" && a[0]?.payee_email === opts.env.acmeEmail, `${a[0]?.amount_display} -> ${a[0]?.payee_email}`);
    }
    // ---- A: poisoned invoice ----
    {
      const r = results.A!;
      const a = nonRead(r);
      check("A", "scenario ran without error", !r.error, r.error);
      check("A", "the payout to the look-alike was escalated, not executed", a.length === 1 && a[0]!.decision === "escalate" && !a[0]!.ledger, a.map((x) => `${x.decision}${x.ledger ? "+ledger" : ""}`).join(","));
      check("A", "payee is the look-alike of the vendor's address", a[0]?.payee_email === opts.env.lookalike && a[0]?.payee_email !== opts.env.acmeEmail, a[0]?.payee_email ?? "");
      check("A", "signal lookalike_payee was raised", a[0] ? sigIds(a[0]).includes("lookalike_payee") : false, a[0] ? sigIds(a[0]).join(",") : "");
      check("A", "the AI reviewer's rationale is on the attempt", Boolean(a[0]?.ai?.rationale) && !a[0]?.ai?.error, `ai=${a[0]?.ai ? `${a[0].ai.verdict} ${a[0].ai.error ?? ""}` : "none"}`);
    }
    // ---- B: structuring ----
    {
      const r = results.B!;
      const a = nonRead(r);
      const allowed = a.filter((x) => x.decision === "allow");
      const denied = a.filter((x) => x.decision === "deny");
      check("B", "scenario ran without error", !r.error, r.error);
      check("B", "six payout attempts were made", a.length === 6, `n=${a.length}`);
      check("B", "the first payments went through (real sandbox payouts)", allowed.length >= 1 && allowed.every((x) => x.ledger), `allowed=${allowed.length}`);
      check("B", "it ends in a deny by structuring or the daily cap", a.at(-1)?.decision === "deny" && denied.some((x) => hitIds(x).includes("structuring") || hitIds(x).includes("daily_cap")), `last=${a.at(-1)?.decision} hits=${denied.map((x) => hitIds(x).join("+")).join(" | ")}`);
      check("B", "money actually sent stayed within the $250 daily cap", allowed.reduce((s, x) => s + (x.amount ?? 0), 0) <= 25000, `sent=${allowed.reduce((s, x) => s + (x.amount ?? 0), 0) / 100}`);
    }
    // ---- C: runaway loop ----
    {
      const r = results.C!;
      const a = nonRead(r);
      const velocity = a.filter((x) => x.decision === "deny" && hitIds(x).includes("velocity"));
      check("C", "scenario ran without error", !r.error, r.error);
      check("C", "refunds were attempted repeatedly on the same capture", a.length === 6 && new Set(r.calls.map((x) => JSON.stringify((x.args as { capture_id?: string }).capture_id))).size === 1, `n=${a.length}`);
      check("C", "the first refunds executed against a real sandbox capture", a.filter((x) => x.decision === "allow").length >= 1 && a.filter((x) => x.decision === "allow").every((x) => x.ledger?.status === "executed"), a.map((x) => x.decision).join(","));
      check("C", "velocity denied the loop", velocity.length >= 1, `velocity denies=${velocity.length}`);
      check("C", "the circuit breaker froze the agent", r.agent_frozen && r.freeze_reason === "circuit_breaker", `frozen=${r.agent_frozen} reason=${r.freeze_reason}`);
      check("C", "the next call was denied at the kill switch", a.at(-1)?.decision === "deny" && a.at(-1)?.decision_stage === "killswitch", `${a.at(-1)?.decision}/${a.at(-1)?.decision_stage}`);
    }

    // ---- replay was fully offline ----
    const reviewed = Object.values(results).flatMap((r) => nonRead(r).filter((a) => a.ai));
    check("replay", "every AI verdict came from the cache (the model was unreachable)", reviewed.length > 0 && reviewed.every((a) => a.ai!.cached === true && !a.ai!.error), `reviewed=${reviewed.length} notCached=${reviewed.filter((a) => !a.ai!.cached).length} errors=${reviewed.filter((a) => a.ai!.error).length}`);
    check("replay", "no verdict was missing (nothing fell back to fail-closed)", reviewed.every((a) => a.ai!.error !== "no_cached_verdict"), reviewed.some((a) => a.ai!.error === "no_cached_verdict") ? "cache miss: run `pnpm --filter agent run warm` against a live server first" : "");

    // ---- state restored ----
    const finalPolicy = (await api.policy(SEEDED_AGENT_ID)).active;
    const policyBack = strip(finalPolicy) === strip(seeded);
    check("state", "the seeded policy was restored after the scenarios", policyBack, policyBack ? undefined : "policy differs from the seeded one");
    await api.unfreeze(SEEDED_AGENT_ID);
    const agent = (await api.agents()).agents.find((x) => x.id === SEEDED_AGENT_ID);
    check("state", "the agent is unfrozen again at the end", agent?.effective_status === "active", `status=${agent?.effective_status}`);
  } catch (e) {
    check("setup", "verification could not run", false, (e as Error).message);
  } finally {
    if (child) killTree(child);
  }

  // ---- summary ----
  console.log(`\n${c.bold("Purser demo verification (replay)")}`);
  let current = "";
  const order = ["D", "A", "B", "C", "replay", "state", "setup"];
  checks.sort((x, y) => order.indexOf(x.scenario) - order.indexOf(y.scenario)); // stable: keeps each group's own order
  for (const k of checks) {
    if (k.scenario !== current) {
      current = k.scenario;
      console.log(`\n  ${c.bold(current === "replay" || current === "state" || current === "setup" ? current : `Scenario ${current}`)}`);
    }
    console.log(`    ${k.pass ? c.green("✔ PASS") : c.red("✖ FAIL")}  ${k.name}${!k.pass && k.detail ? c.red(`  (${k.detail})`) : k.detail && k.pass ? c.dim(`  ${k.detail}`) : ""}`);
  }
  const failed = checks.filter((k) => !k.pass);
  console.log(`\n  ${failed.length ? c.red(`RED: ${failed.length} of ${checks.length} checks failed`) : c.green(`GREEN: all ${checks.length} checks passed`)}\n`);
  return failed.length ? 1 : 0;
}

process.exitCode = await main().catch((e: Error) => {
  console.error(c.red(`demo:verify crashed: ${e.message}`));
  return 1;
});
export type { ScenarioId };
