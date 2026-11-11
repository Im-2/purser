// Drives the real dashboard in Microsoft Edge (via playwright-core, no browser download) against a REAL running Purser backend,
// walks the whole demo, saves screenshots to docs/screens, and reports console errors.
//
//   1. start the server (it serves web/dist):   pnpm --filter @purser/web build ; pnpm --filter @purser/server start
//   2. pnpm --filter @purser/web verify:ui
//
// It reads PURSER_ADMIN_TOKEN from the repo .env to sign in and never prints it. It moves real SANDBOX money: scenario D pays
// $120 and approving the $160 escalation pays $160. It never approves the look-alike payout (it denies it).
import { spawnSync } from "node:child_process";
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

const results = [];
const ok = (name, pass, detail = "") => {
  results.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
};

const browser = await chromium.launch({ channel: "msedge", headless: true });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, colorScheme: "dark" });
const page = await ctx.newPage();

// errors are only counted after a successful sign-in, so the deliberate wrong-token attempt does not count
let armed = false;
const consoleErrors = [];
const pageErrors = [];
const badResponses = [];
page.on("console", (m) => armed && m.type() === "error" && consoleErrors.push(m.text().slice(0, 300)));
page.on("pageerror", (e) => armed && pageErrors.push(String(e).slice(0, 300)));
page.on("response", (r) => {
  const u = r.url();
  if (armed && r.status() >= 400 && !u.includes("/api/approvals/")) badResponses.push(`${r.status()} ${new URL(u).pathname}`);
});

const shot = async (name, o = {}) => page.screenshot({ path: path.join(shots, `${name}.png`), ...o });
const nav = async (label) => page.getByRole("button", { name: label, exact: false }).first().click();
const toast = (re) => page.getByText(re).first();

try {
  // ---------- login ----------
  await page.goto(`${BASE}/app`, { waitUntil: "networkidle" });
  await page.getByLabel("Admin token").waitFor();
  await shot("01-login");
  ok("login screen shows", true);
  await page.getByLabel("Admin token").fill("definitely-not-the-token");
  await page.getByRole("button", { name: "Connect" }).click();
  await page.getByText("That token was not accepted.").waitFor({ timeout: 8000 });
  ok("a wrong token is rejected with a clear message", true);
  await page.getByLabel("Admin token").fill(token);
  await page.getByRole("button", { name: "Connect" }).click();
  await page.getByText("Live decisions").waitFor({ timeout: 15000 });
  ok("the real token signs in", true);
  armed = true;
  const stored = await page.evaluate(() => ({ s: sessionStorage.getItem("purser_admin_token") !== null, l: localStorage.length }));
  ok("token is kept in sessionStorage only", stored.s && stored.l === 0);

  // ---------- Attack Lab: reset, run D, run A ----------
  await nav("Attack Lab");
  await page.getByRole("heading", { name: "Attack Lab" }).waitFor();
  await page.getByRole("button", { name: /Reset demo/ }).click();
  await toast(/Demo reset/).waitFor({ timeout: 15000 });
  ok("Reset demo works", true);

  await page.getByRole("radio", { name: /Happy path/ }).click();
  await page.getByRole("button", { name: /Run scenario D/ }).click();
  await page.getByText(/Scenario D finished/).waitFor({ timeout: 60000 });
  await page.waitForTimeout(600);
  ok("scenario D ran (replay) and the agent log streamed", true);
  const dCard = await page.getByText("ALLOW").first().isVisible();
  ok("Purser's decision for D appeared on the right (ALLOW)", dCard);
  await shot("04-attack-lab-D");

  await page.getByRole("checkbox", { name: /Reset state first/ }).uncheck();
  await page.getByRole("radio", { name: /Poisoned invoice/ }).click();
  await page.getByRole("button", { name: /Run scenario A/ }).click();
  await page.getByText(/Scenario A finished/).waitFor({ timeout: 60000 });
  await page.getByText("Review approval").waitFor({ timeout: 8000 });
  await page.waitForTimeout(600);
  ok("scenario A ran and was escalated for a human", await page.getByText("ESCALATE").first().isVisible());
  ok("look-alike signal chip is shown", await page.getByText("look-alike payee").first().isVisible());
  await shot("05-attack-lab-A");

  // ---------- a second escalation we can approve: a $160 payout to the allowlisted vendor ----------
  const tsx = createRequire(import.meta.url).resolve("tsx/cli");
  const esc = spawnSync(process.execPath, [tsx, path.join(root, "server", "src", "mcp-try.ts"), "--escalate-only"], { cwd: path.join(root, "server"), encoding: "utf8", timeout: 120000 });
  ok("created a $160 escalation to the allowlisted vendor via mcp:try", esc.status === 0 && /pending_approval/.test(esc.stdout), `exit ${esc.status}`);

  // ---------- Approvals ----------
  await nav("Approvals");
  await page.getByRole("heading", { name: "Approvals" }).waitFor();
  const cards = page.locator("article");
  await cards.first().waitFor({ timeout: 15000 });
  await page.waitForFunction(() => document.querySelectorAll("article").length >= 2, null, { timeout: 15000 });
  ok("two pending approvals are listed", (await cards.count()) === 2, `count=${await cards.count()}`);
  await shot("06-approvals");

  const good = cards.filter({ hasText: "$160.00" }).first();
  const bad = cards.filter({ hasText: "acme-supp1ies" }).first();
  ok("the look-alike card warns that approving sends real money", await bad.getByText(/closely resembles a known vendor/).isVisible());
  await good.getByRole("button", { name: "Approve" }).click();
  await toast(/Approved and executed/).waitFor({ timeout: 40000 });
  ok("approving the $160 escalation executed it (sandbox payout)", true);
  await bad.getByRole("button", { name: "Deny" }).click();
  await toast(/The call was closed/).waitFor({ timeout: 15000 });
  ok("denying the look-alike closed it (no money moved)", true);
  await page.getByText("Nothing is waiting on you").waitFor({ timeout: 10000 });
  ok("pending list is empty afterwards and the resolved list shows both", (await page.getByText("approved", { exact: true }).count()) > 0 && (await page.getByText("denied", { exact: true }).count()) > 0);
  await shot("07-approvals-resolved");

  // ---------- Live: grid, drawer ----------
  await nav("Live");
  await page.getByText("Live decisions").waitFor();
  await page.locator(".ag-row").first().waitFor({ timeout: 15000 });
  const rowCount = await page.locator(".ag-row").count();
  ok("the Live grid shows the attempts", rowCount >= 3, `rows=${rowCount}`);
  await shot("02-live");
  await page.getByRole("radio", { name: /Denied/ }).click();
  await page.waitForTimeout(400);
  const deniedRows = await page.locator(".ag-row").count();
  ok("the Denied filter narrows the grid", deniedRows >= 1 && deniedRows < rowCount, `denied=${deniedRows}`);
  await page.getByRole("radio", { name: /^All\b/ }).click();
  await page.waitForTimeout(300);

  await page.locator(".ag-row", { hasText: "acme-supp1ies" }).first().click();
  await page.getByText("Why Purser decided this").waitFor();
  await page.getByText("Rules hit").waitFor();
  await page.getByText("AI reviewer").first().waitFor();
  await page.waitForTimeout(500);
  ok("the drawer explains the decision (stage, rules, signals, AI)", (await page.getByText("Decided at").isVisible()) && (await page.getByText(/Trust signals/).isVisible()));
  await shot("03-live-drawer");
  await page.keyboard.press("Escape");
  await page.waitForTimeout(400);

  // ---------- kill switch ----------
  await page.getByRole("button", { name: /KILL SWITCH/ }).click();
  await page.getByText("Freeze every agent now?").waitFor();
  await shot("08-kill-switch-confirm");
  await page.getByRole("button", { name: "Freeze all agents" }).click();
  await page.getByText("All agents are frozen").waitFor({ timeout: 10000 });
  ok("the red frozen banner appears after the kill switch", true);
  await page.waitForTimeout(700);
  await shot("09-frozen-banner");
  await page.getByRole("button", { name: "Unfreeze" }).click();
  await page.getByText("All agents are frozen").waitFor({ state: "detached", timeout: 10000 });
  ok("Unfreeze removes the banner", true);

  await page.getByRole("switch", { name: /Freeze Ops agent/ }).click();
  await page.getByText(/Ops agent is frozen|All agents are frozen/).first().waitFor({ timeout: 10000 });
  ok("the per-agent switch freezes one agent and shows the banner", true);
  await page.getByRole("switch", { name: /Unfreeze Ops agent/ }).click();
  await page.getByText(/Ops agent is frozen|All agents are frozen/).first().waitFor({ state: "detached", timeout: 10000 });
  ok("the per-agent switch unfreezes it", true);

  // ---------- how it works, Part B pages ----------
  await page.getByRole("button", { name: /How this works/ }).click();
  await page.getByText("the pipeline in five steps").waitFor();
  await shot("10-how-it-works");
  await page.keyboard.press("Escape");
  await nav("Policies");
  await page.getByRole("heading", { name: "Policies" }).first().waitFor();
  await nav("Reconciliation");
  await page.getByRole("heading", { name: "Reconciliation" }).first().waitFor();
  ok("Policies and Reconciliation pages render (Part B is verified by verify:ui:b)", true);

  // ---------- empty states and 1920x1080 ----------
  await page.setViewportSize({ width: 1920, height: 1080 });
  await nav("Live");
  await page.locator(".ag-row").first().waitFor();
  await page.waitForTimeout(500);
  await shot("12-live-1920");
  await nav("Attack Lab");
  await page.waitForTimeout(500);
  await shot("13-attack-lab-1920");
  await page.setViewportSize({ width: 390, height: 844 });
  await nav("Approvals");
  await page.waitForTimeout(500);
  await shot("14-approvals-mobile");

  // sign out returns to login
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByRole("button", { name: "Sign out" }).click();
  await page.getByLabel("Admin token").waitFor();
  ok("sign out returns to the login screen", (await page.evaluate(() => sessionStorage.getItem("purser_admin_token"))) === null);
} catch (e) {
  ok("UI walkthrough completed", false, String(e).split("\n")[0]);
  await shot("zz-failure").catch(() => undefined);
} finally {
  ok("no console errors", consoleErrors.length === 0, consoleErrors.slice(0, 3).join(" | "));
  ok("no uncaught page errors", pageErrors.length === 0, pageErrors.slice(0, 3).join(" | "));
  ok("no unexpected 4xx/5xx responses", badResponses.length === 0, badResponses.slice(0, 5).join(", "));
  await browser.close();
}

const failed = results.filter((r) => !r.pass);
console.log(`\n${failed.length ? `RED: ${failed.length} of ${results.length} checks failed` : `GREEN: all ${results.length} UI checks passed`}`);
console.log(`screenshots: ${existsSync(shots) ? shots : "none"}`);
process.exitCode = failed.length ? 1 : 0;
