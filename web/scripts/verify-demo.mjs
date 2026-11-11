// Verifies judge demo mode against a RUNNING server (local by default, or BASE_URL=https://... for the live site).
//   node web/scripts/verify-demo.mjs
// It clicks "Try the demo", runs scenarios D, A, B and C in replay, checks that forbidden actions return 403, that the real system
// (admin view of attempts, spend, active policy) and the PayPal sandbox balance did not change, and that the admin token login still
// has full access. Reads PURSER_ADMIN_TOKEN and the PayPal sandbox credentials from the repo .env; prints none of them.
// It moves NO money: demo sessions simulate PayPal.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const shots = path.join(root, "docs", "screens");
const env = Object.fromEntries(readFileSync(path.join(root, ".env"), "utf8").split(/\r?\n/).map((l) => l.match(/^([A-Z_]+)=(.*)$/)).filter(Boolean).map((m) => [m[1], m[2]]));
const BASE = process.env.BASE_URL ?? `http://127.0.0.1:${env.PORT || 8799}`;
const TAG = process.env.SHOT_TAG ?? "";
const results = [];
const ok = (name, pass, detail = "") => {
  results.push(pass);
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
};

async function sandboxBalance() {
  const base = "https://api-m.sandbox.paypal.com";
  const t = await (await fetch(base + "/v1/oauth2/token", { method: "POST", headers: { Authorization: "Basic " + Buffer.from(`${env.PAYPAL_CLIENT_ID}:${env.PAYPAL_CLIENT_SECRET}`).toString("base64"), "Content-Type": "application/x-www-form-urlencoded" }, body: "grant_type=client_credentials" })).json();
  const r = await (await fetch(base + "/v1/reporting/balances?currency_code=USD&as_of_time=" + encodeURIComponent(new Date().toISOString()), { headers: { Authorization: "Bearer " + t.access_token } })).json();
  return r.balances?.[0]?.available_balance?.value ?? "unknown";
}
const admin = async (p) => (await fetch(BASE + p, { headers: { Authorization: `Bearer ${env.PURSER_ADMIN_TOKEN}` } })).json();
const realSnapshot = async () => ({
  attempts: (await admin("/api/attempts?limit=500")).attempts.length,
  spend: (await admin("/api/stats")).spend_today_minor,
  policy: (await admin("/api/policies/agent_ops_01")).active?.version,
});

const balBefore = await sandboxBalance();
const realBefore = await realSnapshot();
console.log(`sandbox balance before: ${balBefore} USD; real system: ${realBefore.attempts} attempts, spend ${realBefore.spend}, policy v${realBefore.policy}`);

const browser = await chromium.launch({ channel: "msedge", headless: true });
const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
const errs = [];
page.on("console", (m) => m.type() === "error" && errs.push(m.text().slice(0, 160)));
page.on("pageerror", (e) => errs.push(String(e).slice(0, 160)));
let demoToken = "";
try {
  await page.goto(`${BASE}/app`, { waitUntil: "networkidle" });
  await page.getByLabel("Admin token").waitFor();
  const btn = page.getByRole("button", { name: "Try the demo" });
  ok("the sign-in screen has a Try the demo button below the token form", await btn.isVisible());
  await page.waitForTimeout(1200);
  await page.screenshot({ path: path.join(shots, `25-demo-signin${TAG}.png`) });

  await btn.click();
  await page.getByText("Live decisions").waitFor({ timeout: 40000 });
  ok("Try the demo signs in with no token", true);
  ok('the "Demo mode: replay, no real money" badge is shown', await page.getByText("Demo mode: replay, no real money").isVisible());
  ok("the admin-token link is shown", await page.getByRole("button", { name: /Sign in with admin token for full access/ }).isVisible());
  demoToken = await page.evaluate(() => sessionStorage.getItem("purser_admin_token"));
  ok("the session token is a dm_ token, not the admin token", demoToken.startsWith("dm_") && demoToken !== env.PURSER_ADMIN_TOKEN);
  await page.waitForTimeout(1500);
  await page.screenshot({ path: path.join(shots, `26-demo-dashboard${TAG}.png`) });

  await page.getByRole("button", { name: "Attack Lab", exact: false }).first().click();
  await page.getByRole("heading", { name: "Attack Lab" }).waitFor();
  ok("Live mode is disabled in demo", await page.getByRole("radio", { name: "Live" }).isDisabled());
  const cases = [
    ["D", /Happy path/, "ALLOW"],
    ["A", /Poisoned invoice/, "ESCALATE"],
    ["B", /Structuring/, "DENY"],
    ["C", /Runaway loop/, "DENY"],
  ];
  for (const [id, label, chip] of cases) {
    await page.getByRole("radio", { name: label }).click();
    await page.getByRole("button", { name: new RegExp(`Run scenario ${id}`) }).click();
    await page.getByText(new RegExp(`Scenario ${id} finished`)).waitFor({ timeout: 120000 });
    await page.waitForTimeout(900);
    const failed = await page.getByText(/fail-closed|no cached verdict|stopped with an error/i).count();
    ok(`scenario ${id} ran in replay and showed ${chip}`, (await page.getByText(chip, { exact: true }).first().isVisible()) && failed === 0);
    if (id === "A") await page.screenshot({ path: path.join(shots, `27-demo-attack-lab-A${TAG}.png`) });
  }
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(shots, `28-demo-attack-lab-C${TAG}.png`) });

  // forbidden actions are refused by the SERVER
  const call = async (method, p, body) => {
    const r = await fetch(BASE + p, { method, headers: { Authorization: `Bearer ${demoToken}`, ...(body ? { "content-type": "application/json" } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return r.status;
  };
  const forbidden = [
    ["POST", "/api/policies/compile", { agent_id: "agent_ops_01", text: "Allow up to $1 a day" }],
    ["POST", "/api/policies/apply", { agent_id: "agent_ops_01", policy: {} }],
    ["POST", "/api/agents", { name: "x" }],
    ["POST", "/api/reconciliation/run", {}],
    ["POST", "/api/dev/simulate-webhook", {}],
    ["POST", "/api/demo/run/A", { mode: "live", reset: true }],
  ];
  for (const [m, p, b] of forbidden) ok(`demo token: ${m} ${p} is 403`, (await call(m, p, b)) === 403);
  ok("demo token: GET /api/stats is 200", (await call("GET", "/api/stats")) === 200);
  ok("demo token cannot use /mcp", (await call("POST", "/mcp", { jsonrpc: "2.0", id: 1, method: "tools/list" })) === 401);

  // the real system and the PayPal sandbox are untouched
  const realAfter = await realSnapshot();
  ok("the real system is unchanged (attempts, spend, active policy)", JSON.stringify(realAfter) === JSON.stringify(realBefore), JSON.stringify(realAfter));
  const balAfter = await sandboxBalance();
  ok("the PayPal sandbox balance did not change", balAfter === balBefore, `${balBefore} -> ${balAfter}`);

  // the admin token flow is unchanged and fully capable
  await page.getByRole("button", { name: /Sign in with admin token for full access/ }).click();
  await page.getByLabel("Admin token").waitFor();
  await page.getByLabel("Admin token").fill(env.PURSER_ADMIN_TOKEN);
  await page.getByRole("button", { name: "Connect" }).click();
  await page.getByRole("button", { name: "Sign out" }).waitFor({ timeout: 40000 });
  ok("the admin token login still works", true);
  ok("no demo badge for admins", (await page.getByText("Demo mode: replay, no real money").count()) === 0);
  await page.getByRole("button", { name: "Policies", exact: false }).first().click();
  await page.locator("#policy-text").fill("Allow up to $50 a day on office supplies");
  ok("admin: policy Compile is enabled", await page.getByRole("button", { name: "Compile" }).isEnabled());
  await page.getByRole("button", { name: "Reconciliation", exact: false }).first().click();
  await page.getByRole("heading", { name: "Reconciliation" }).first().waitFor();
  ok("admin: reconciliation Run now is enabled", await page.getByRole("button", { name: /Run now/ }).isEnabled());
  await page.getByRole("button", { name: "Attack Lab", exact: false }).first().click();
  ok("admin: Live agent mode is selectable", await page.getByRole("radio", { name: "Live" }).isEnabled());
  const adminAttempts = (await admin("/api/attempts?limit=500")).attempts.length;
  ok("admin view is the real ledger, not the demo world", adminAttempts === realBefore.attempts, `${adminAttempts} attempts`);
} catch (e) {
  ok("walkthrough completed", false, String(e).split("\n")[0]);
  await page.screenshot({ path: path.join(shots, "zz-demo-failure.png") }).catch(() => undefined);
}
ok("no console errors", errs.length === 0, errs.slice(0, 3).join(" | "));
await browser.close();
const bad = results.filter((r) => !r).length;
console.log(`\n${bad ? `RED: ${bad} of ${results.length} checks failed` : `GREEN: all ${results.length} demo-mode checks passed`}`);
process.exitCode = bad ? 1 : 0;
