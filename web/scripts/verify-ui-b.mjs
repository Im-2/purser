// Part B walkthrough against the REAL running backend: Policies (compile, review, apply, history, reset restores the seeded
// policy) and Reconciliation (Run now, an out-of-band payout appearing live over SSE), plus a no-money smoke of every page.
//
//   pnpm --filter @purser/web build ; pnpm --filter @purser/server start     (restart the server after a rebuild)
//   pnpm --filter @purser/web verify:ui:b
//
// Reads PURSER_ADMIN_TOKEN from the repo .env and never prints it. The only money it moves is ONE $5 sandbox payout (the
// out-of-band demo). It does not run the Attack Lab scenarios. Compiling uses the configured LLM.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const shots = path.join(root, "docs", "screens");
mkdirSync(shots, { recursive: true });
const env = Object.fromEntries(
  readFileSync(path.join(root, ".env"), "utf8")
    .split(/\r?\n/)
    .map((l) => l.match(/^([A-Z_]+)=(.*)$/))
    .filter(Boolean)
    .map((m) => [m[1], m[2]]),
);
const token = env.PURSER_ADMIN_TOKEN;
const BASE = process.env.BASE_URL ?? `http://127.0.0.1:${env.PORT || 8799}`;
if (!token) throw new Error("PURSER_ADMIN_TOKEN is not set in .env");
const SAMPLE = "Allow up to $50 a day on office supplies, refunds up to $30, never pay new vendors without asking";

const results = [];
const ok = (name, pass, detail = "") => {
  results.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
};

const browser = await chromium.launch({ channel: "msedge", headless: true });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, colorScheme: "light" });
const page = await ctx.newPage();

let armed = false;
let muted = false; // true while a request is deliberately failed
const consoleErrors = [];
const pageErrors = [];
const badResponses = [];
page.on("console", (m) => armed && !muted && m.type() === "error" && consoleErrors.push(m.text().slice(0, 300)));
page.on("pageerror", (e) => armed && pageErrors.push(String(e).slice(0, 300)));
page.on("response", (r) => {
  if (armed && !muted && r.status() >= 400) badResponses.push(`${r.status()} ${new URL(r.url()).pathname}`);
});

const shot = (name) => page.screenshot({ path: path.join(shots, `${name}.png`) });
const both = async (name) => {
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(500);
  await shot(`${name}-1440`);
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(700);
  await shot(`${name}-1920`);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.waitForTimeout(300);
};
const nav = (label) => page.getByRole("button", { name: label, exact: false }).first().click();
const apiGet = (p) => page.evaluate(async (u) => (await fetch(u, { headers: { Authorization: `Bearer ${sessionStorage.getItem("purser_admin_token")}` } })).json(), p);
const toast = (re) => page.getByText(re).first();
const statValue = (label) => page.getByText(label, { exact: true }).locator("xpath=following-sibling::div").first().innerText();

try {
  // ---------- sign in ----------
  await page.goto(`${BASE}/app`, { waitUntil: "networkidle" });
  await page.getByLabel("Admin token").fill(token);
  await page.getByRole("button", { name: "Connect" }).click();
  await page.getByText("Live decisions").waitFor({ timeout: 15000 });
  armed = true;
  ok("signed in", true);

  // ---------- smoke: every page renders with a title and no errors ----------
  const pages = [
    ["Live", "Live decisions"],
    ["Approvals", "Approvals"],
    ["Attack Lab", "Attack Lab"],
    ["Policies", "Policies"],
    ["Reconciliation", "Reconciliation"],
  ];
  for (const [label, title] of pages) {
    await nav(label);
    await page.getByRole("heading", { name: title }).first().waitFor();
    await page.waitForTimeout(250);
    const t = await page.title();
    ok(`${label} page renders and sets the tab title`, t.includes("| Purser"), t);
  }
  const favicon = await page.evaluate(() => document.querySelector('link[rel="icon"]')?.getAttribute("href"));
  ok("favicon is set", Boolean(favicon), String(favicon));

  // ---------- Policies ----------
  await nav("Policies");
  await page.getByText("Active policy").first().waitFor();
  await page.getByText("Per day").waitFor({ timeout: 15000 });
  const before = (await apiGet("/api/policies/agent_ops_01")).active;
  const perDayBefore = await statValue("Per day");
  ok("the active policy is shown", Boolean(before?.version), `v${before?.version}, per day ${perDayBefore}`);

  // an API failure must surface as an error toast and an inline alert, not a blank screen
  muted = true;
  await page.route("**/api/policies/compile", (r) => r.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "ai_unavailable", message: "The AI model is not reachable." }) }));
  await page.locator("#policy-text").fill(SAMPLE);
  await page.getByRole("button", { name: "Compile" }).click();
  await toast(/Could not compile/).waitFor({ timeout: 8000 });
  ok("a failed compile shows an error toast and an inline alert", await page.getByRole("alert").filter({ hasText: "not reachable" }).isVisible());
  await page.unroute("**/api/policies/compile");
  muted = false;

  await page.getByRole("button", { name: "Compile" }).click();
  await page.getByText("Proposal, not applied").waitFor({ timeout: 90000 });
  ok("compile returns a proposal that is clearly not applied yet", true);
  const stillBefore = (await apiGet("/api/policies/agent_ops_01")).active;
  ok("compiling did not change the live policy", stillBefore.version === before.version);
  const diffRows = await page.locator("table tbody tr").count();
  const warnChips = await page.locator('section[aria-label="Preview"] ul li').count();
  ok("the preview shows a diff", diffRows >= 1, `${diffRows} changed fields, ${warnChips} warnings`);
  const diffPaths = await page.locator("table tbody tr td:first-child").allInnerTexts();
  console.log("      diff fields:", diffPaths.join(", "));
  await both("15-policies-proposal");

  await page.getByRole("button", { name: "Apply policy" }).click();
  await page.getByText(/Applied as v\d+/).waitFor({ timeout: 15000 });
  const appliedV = Number((await page.getByText(/Applied as v\d+/).first().innerText()).match(/v(\d+)/i)[1]);
  await page.waitForTimeout(700);
  const after = await apiGet("/api/policies/agent_ops_01");
  ok("apply is real: the new version is active on the server", after.active.version === appliedV && after.history.some((h) => h.version === appliedV && h.active), `v${appliedV}`);
  ok("the version history lists it with the source sentence", await page.locator('section[aria-label="Version history"]').getByText(/office supplies/).first().isVisible());
  ok("the active policy card reflects the new limits", (await statValue("Per day")) !== perDayBefore, `per day ${await statValue("Per day")}`);
  await page.getByRole("radio", { name: "Active" }).click();
  await both("16-policies-applied");

  // ---------- reset restores the seeded policy ----------
  await nav("Attack Lab");
  await page.getByRole("button", { name: /Reset demo/ }).click();
  await toast(/Demo reset/).waitFor({ timeout: 15000 });
  const restored = (await apiGet("/api/policies/agent_ops_01")).active;
  const same = JSON.stringify({ ...restored, version: 0 }) === JSON.stringify({ ...before, version: 0 });
  ok("demo reset restored the seeded policy (same content as before the test)", same, `now v${restored.version}`);
  await nav("Policies");
  await page.getByText("Per day").waitFor();
  ok("the Policies page shows the restored limits", (await statValue("Per day")) === perDayBefore);
  await shot("17-policies-restored-1440");

  // ---------- Reconciliation ----------
  await nav("Reconciliation");
  await page.getByRole("heading", { name: "Reconciliation" }).first().waitFor();
  muted = true;
  await page.route("**/api/reconciliation/run", (r) => r.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "boom", message: "Internal error" }) }));
  await page.getByRole("button", { name: /Run now/ }).click();
  await toast(/Reconciliation run failed/).waitFor({ timeout: 8000 });
  ok("a failed run shows an error toast", true);
  await page.unroute("**/api/reconciliation/run");
  muted = false;

  await page.getByRole("button", { name: /Run now/ }).click();
  await page.getByText(/Last run/).first().waitFor({ timeout: 120000 });
  const status = (await page.locator("text=Transaction search").first().locator("xpath=following-sibling::span").first().innerText()).trim().toLowerCase();
  ok("Run now completes and shows the run status", ["ok", "lagging", "unavailable", "skipped"].includes(status), `transaction search: ${status}`);
  console.log("      run summary:", (await page.locator('[role="status"]').first().innerText()).replace(/\s+/g, " ").slice(0, 200));
  await shot("18-reconciliation-run-1440");

  let oobRow = page.locator(".ag-row", { hasText: "unrecorded movement" }).first();
  if (process.env.SKIP_OOB) {
    console.log("      (SKIP_OOB set: not moving the $5 out-of-band payout)");
    await both("19-reconciliation-live");
  } else {
  // the out-of-band payout: $5 straight to PayPal, bypassing Purser; the simulated webhooks then reach the server
  const tsx = createRequire(import.meta.url).resolve("tsx/cli");
  const unrecordedRows = page.locator(".ag-row", { hasText: "unrecorded movement" });
  const rowsBefore = await unrecordedRows.count();
  await page.waitForTimeout(6500); // let any highlight from the Run now findings expire, so a highlight below is from the new finding
  const child = spawn(process.execPath, [tsx, path.join(root, "server", "src", "demo-oob-payout.ts")], { cwd: path.join(root, "server"), stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  child.stdout.on("data", (d) => (out += d));
  child.stderr.on("data", (d) => (out += d));
  const exited = new Promise((res) => child.on("close", res));
  await page.waitForFunction((n) => [...document.querySelectorAll(".ag-row")].filter((r) => /unrecorded movement/.test(r.textContent ?? "")).length > n, rowsBefore, { timeout: 150000 });
  const live = (await page.locator(".ag-row.row-new").count()) > 0;
  oobRow = page.locator(".ag-row.row-new").first();
  ok("a NEW unrecorded movement appeared live over SSE (no reload)", true, `${rowsBefore} before, ${await unrecordedRows.count()} after`);
  ok("the new finding is highlighted", live);
  await both("19-reconciliation-live");
  const code = await exited;
  ok("the out-of-band demo script exited cleanly", code === 0, `exit ${code}`);
  console.log("      " + out.split(/\r?\n/).filter((l) => /batch|status|unrecorded|simulat/i.test(l)).slice(0, 4).join("\n      "));
  }
  await oobRow.click();
  await page.getByText("Everything PayPal reported").first().waitFor();
  ok("a finding opens a detail view", true);
  await shot("20-reconciliation-detail-1440");
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: /unrecorded movement/ }).first().click();
  await page.waitForTimeout(400);
  const filtered = await page.locator(".ag-row").count();
  ok("the finding-type chip filters the grid", filtered >= 1);

  // ---------- keyboard focus is visible ----------
  await nav("Policies");
  await page.locator("#policy-text").focus();
  const outline = await page.locator("#policy-text").evaluate((el) => getComputedStyle(el).outlineStyle);
  ok("the textarea shows a focus outline", outline !== "none");
} catch (e) {
  ok("UI walkthrough completed", false, String(e).split("\n")[0]);
  await shot("zz-failure-b").catch(() => undefined);
} finally {
  ok("no console errors", consoleErrors.length === 0, consoleErrors.slice(0, 3).join(" | "));
  ok("no uncaught page errors", pageErrors.length === 0, pageErrors.slice(0, 3).join(" | "));
  ok("no unexpected 4xx/5xx responses", badResponses.length === 0, badResponses.slice(0, 5).join(", "));
  await browser.close();
}

const failed = results.filter((r) => !r.pass);
console.log(`\n${failed.length ? `RED: ${failed.length} of ${results.length} checks failed` : `GREEN: all ${results.length} Part B UI checks passed`}`);
console.log(`screenshots: ${existsSync(shots) ? shots : "none"}`);
process.exitCode = failed.length ? 1 : 0;
