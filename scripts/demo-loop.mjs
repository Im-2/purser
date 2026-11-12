#!/usr/bin/env node
// Reliability loop for the zero-money demo world: N times in a row it opens a fresh "Try the demo" session on a RUNNING server and
// runs scenarios D, A, B and C in replay, checking each outcome. No PayPal request is made and no model is called.
//   node scripts/demo-loop.mjs [runs=5]            (BASE_URL overrides the target; default http://127.0.0.1:<PORT from .env>)
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let port = "8799";
try {
  const m = readFileSync(path.join(root, ".env"), "utf8").match(/^PORT=(\d+)/m);
  if (m) port = m[1];
} catch {
  // no .env: default port
}
const BASE = process.env.BASE_URL ?? `http://127.0.0.1:${port}`;
const runs = Number(process.argv[2] ?? 5);

const EXPECT = {
  D: (r) => r.decisions.join() === "allow",
  A: (r) => r.decisions.join() === "escalate",
  B: (r) => r.decisions.length === 6 && r.decisions.at(-1) === "deny" && r.decisions.filter((d) => d === "allow").length === 2,
  C: (r) => r.decisions.includes("deny") && r.agent_frozen === true,
};

async function once(n) {
  const s = await fetch(`${BASE}/api/demo-session`, { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": `198.51.100.${n}` }, body: "{}" });
  if (s.status !== 201) throw new Error(`demo-session ${s.status}`);
  const { token } = await s.json();
  const call = (m, p, b) => fetch(BASE + p, { method: m, headers: { authorization: `Bearer ${token}`, ...(b ? { "content-type": "application/json" } : {}) }, ...(b ? { body: JSON.stringify(b) } : {}) });
  const out = [];
  for (const id of ["D", "A", "B", "C"]) {
    const t0 = Date.now();
    const r = await call("POST", `/api/demo/run/${id}`, { mode: "replay", reset: true });
    if (r.status !== 202) throw new Error(`run ${id} -> ${r.status}`);
    let last = null;
    for (let i = 0; i < 600; i++) {
      const st = await (await call("GET", "/api/demo/status")).json();
      if (!st.running && st.last?.scenario === id) {
        last = st.last;
        break;
      }
      await new Promise((res) => setTimeout(res, 100));
    }
    if (!last) throw new Error(`scenario ${id} did not finish in 60s`);
    if (last.error) throw new Error(`scenario ${id} error: ${last.error}`);
    if (!EXPECT[id](last)) throw new Error(`scenario ${id} unexpected: ${last.decisions.join()} frozen=${last.agent_frozen}`);
    out.push(`${id} ${last.decisions.join("/")} ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  }
  // the AI reviewer must have answered from the cache every time, never failing closed
  const attempts = (await (await call("GET", "/api/attempts?limit=200")).json()).attempts;
  const bad = attempts.filter((a) => a.ai && (a.ai.error || a.ai.cached !== true));
  if (bad.length) throw new Error(`${bad.length} AI verdicts were not served from the cache`);
  return out.join(" | ");
}

let failed = 0;
for (let n = 1; n <= runs; n++) {
  try {
    console.log(`run ${n}/${runs}: PASS  ${await once(n)}`);
  } catch (e) {
    failed++;
    console.log(`run ${n}/${runs}: FAIL  ${e.message}`);
  }
}
console.log(failed ? `RED: ${failed} of ${runs} runs failed` : `GREEN: ${runs} of ${runs} runs passed`);
process.exitCode = failed ? 1 : 0;
