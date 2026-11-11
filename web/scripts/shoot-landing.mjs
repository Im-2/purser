// Screenshots the landing page at 390, 768 and 1440 px (plus /app) into docs/screens, and checks for horizontal scroll and
// console errors. Run against a running server (default http://127.0.0.1:<PORT>); override with BASE_URL.
//   node web/scripts/shoot-landing.mjs
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const env = Object.fromEntries(readFileSync(path.join(root, ".env"), "utf8").split(/\r?\n/).map((l) => l.match(/^([A-Z_]+)=(.*)$/)).filter(Boolean).map((m) => [m[1], m[2]]));
const BASE = process.env.BASE_URL ?? `http://127.0.0.1:${env.PORT || 8799}`;
const out = (n) => path.join(root, "docs", "screens", n);
const browser = await chromium.launch({ channel: "msedge", headless: true });
let bad = 0;
const check = (name, pass, detail = "") => {
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
  if (!pass) bad++;
};

for (const [w, h] of [[390, 844], [768, 1024], [1440, 900]]) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 1, isMobile: w < 500, hasTouch: w < 500 });
  const page = await ctx.newPage();
  const errs = [];
  page.on("console", (m) => m.type() === "error" && errs.push(m.text().slice(0, 160)));
  page.on("pageerror", (e) => errs.push(String(e).slice(0, 160)));
  await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });
  if (w === 1440) {
    await page.waitForTimeout(700);
    await page.screenshot({ path: out("landing-1440-0-loader.png") });
  }
  await page.waitForFunction(() => !document.querySelector(".loader"), null, { timeout: 8000 });
  await page.waitForTimeout(1600); // hero entrance
  await page.screenshot({ path: out(`landing-${w}-1-hero.png`) });

  const sections = [["problem", "#problem-title"], ["gallery", "#scn-title"], ["proof", "#proof-title"]];
  // walk the page so reveals fire, then capture each section
  const total = await page.evaluate(() => document.documentElement.scrollHeight);
  for (let y = 0; y < total; y += Math.round(h * 0.6)) {
    await page.evaluate((yy) => window.scrollTo({ top: yy, behavior: "instant" }), y);
    await page.waitForTimeout(120);
  }
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: "instant" }));
  await page.waitForTimeout(300);
  for (const [name, sel] of sections) {
    await page.locator(sel).evaluate((el) => el.scrollIntoView({ block: "start", behavior: "instant" }));
    await page.waitForTimeout(1100);
    await page.screenshot({ path: out(`landing-${w}-${name}.png`) });
  }
  // pipeline stepper at 3 scroll positions
  const pipe = await page.locator("#how").evaluate((el) => ({ top: el.offsetTop, h: el.offsetHeight }));
  for (const [i, frac] of [[1, 0.06], [2, 0.42], [3, 0.9]]) {
    await page.evaluate(([t, hh, f, vh]) => window.scrollTo({ top: t + (hh - vh) * f, behavior: "instant" }), [pipe.top, pipe.h, frac, h]);
    await page.waitForTimeout(900);
    await page.screenshot({ path: out(`landing-${w}-pipeline-${i}.png`) });
  }
  await page.evaluate(() => window.scrollTo({ top: document.documentElement.scrollHeight, behavior: "instant" }));
  await page.waitForTimeout(800);
  await page.screenshot({ path: out(`landing-${w}-footer.png`) });

  const sw = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: window.innerWidth }));
  check(`${w}px: no horizontal scroll`, sw.sw <= sw.iw, `scrollWidth ${sw.sw} vs ${sw.iw}`);
  check(`${w}px: no console errors`, errs.length === 0, errs.slice(0, 2).join(" | "));
  const h1 = await page.locator("h1").count();
  check(`${w}px: one h1`, h1 === 1, String(h1));

  // lightbox opens and closes with the keyboard
  await page.locator("#scenarios button").first().evaluate((el) => el.scrollIntoView({ block: "center", behavior: "instant" }));
  await page.locator("#scenarios button").first().click();
  await page.getByRole("dialog").waitFor();
  if (w === 1440) {
    await page.waitForTimeout(900);
    await page.screenshot({ path: out("landing-1440-lightbox.png") });
  }
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => !document.querySelector(".lightbox"));
  check(`${w}px: scenario lightbox opens and Escape closes it`, true);

  // intro is skipped on a repeat visit in the same session
  await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(300);
  check(`${w}px: intro does not replay in the same session`, (await page.locator(".loader").count()) === 0);
  await ctx.close();
}

// the dashboard still lives at /app (sign-in screen) and the old hash routes work under it
{
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  const errs = [];
  page.on("console", (m) => m.type() === "error" && errs.push(m.text().slice(0, 160)));
  await page.goto(`${BASE}/app`, { waitUntil: "networkidle" });
  await page.getByLabel("Admin token").waitFor();
  await page.waitForTimeout(1500);
  await page.screenshot({ path: out("landing-app-login-1440.png") });
  check("/app shows the dashboard sign-in", true);
  await page.getByLabel("Admin token").fill(env.PURSER_ADMIN_TOKEN);
  await page.getByRole("button", { name: "Connect" }).click();
  await page.getByText("Live decisions").waitFor({ timeout: 20000 });
  check("/app signs in and shows the dashboard", true);
  check("/app: no console errors", errs.length === 0, errs.slice(0, 2).join(" | "));
}
await browser.close();
process.exitCode = bad ? 1 : 0;

