#!/usr/bin/env node
// Cross-platform secret check. Never prints secret values, only counts and file names.
//   node scripts/check-secrets.mjs            tracked files + staged diff
//   node scripts/check-secrets.mjs --history  also scans all history (git log -p --all)
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const withHistory = process.argv.includes("--history");

function git(args) {
  const r = spawnSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 512 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`git ${args[0]} failed`);
  return r.stdout;
}

function parseEnv(text) {
  const out = {};
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return out;
}

const SECRET_ENV_KEYS = [
  "PAYPAL_CLIENT_SECRET",
  "PURSER_ADMIN_TOKEN",
  "ANTHROPIC_API_KEY",
  "TELEGRAM_BOT_TOKEN",
  "AGENT_API_KEY",
];
const SECRET_JSON_KEYS = /^(password|client_secret|secret|token|api_key)$/i;

const secrets = new Map(); // value -> label (label is a key name, never the value)

const envPath = path.join(root, ".env");
if (existsSync(envPath)) {
  const env = parseEnv(readFileSync(envPath, "utf8"));
  for (const k of SECRET_ENV_KEYS) if (env[k] && env[k].length >= 8) secrets.set(env[k], `.env:${k}`);
}

const accPath = path.join(root, ".sandbox", "accounts.json");
if (existsSync(accPath)) {
  const walk = (node, label) => {
    if (Array.isArray(node)) node.forEach((n, i) => walk(n, `${label}[${i}]`));
    else if (node && typeof node === "object")
      for (const [k, v] of Object.entries(node)) {
        if (typeof v === "string" && SECRET_JSON_KEYS.test(k) && v.length >= 8) secrets.set(v, `accounts.json:${label}.${k}`);
        else walk(v, `${label}.${k}`);
      }
  };
  walk(JSON.parse(readFileSync(accPath, "utf8")), "$");
}

let failures = 0;
const fail = (msg) => {
  failures++;
  console.error(`FAIL: ${msg}`);
};

// 1. .env / .sandbox must not be tracked (or staged)
const tracked = git(["ls-files", "-z"]).split("\0").filter(Boolean);
const badTracked = tracked.filter((f) => /(^|\/)\.env$/.test(f) || /^\.env\.(?!example$)/.test(f) || f.startsWith(".sandbox/"));
if (badTracked.length) fail(`${badTracked.length} forbidden file(s) tracked: ${badTracked.join(", ")}`);

// 2. secret values must not appear in tracked files
let fileHits = 0;
for (const f of tracked) {
  let text;
  try {
    text = readFileSync(path.join(root, f), "utf8");
  } catch {
    continue;
  }
  for (const [value, label] of secrets) {
    if (text.includes(value)) {
      fileHits++;
      console.error(`  tracked file ${f} contains a value from ${label}`);
    }
  }
}
if (fileHits) fail(`${fileHits} secret occurrence(s) in tracked files`);

// 3. staged diff
const staged = git(["diff", "--cached"]);
let stagedHits = 0;
for (const [value] of secrets) if (staged.includes(value)) stagedHits++;
if (stagedHits) fail(`${stagedHits} secret value(s) in the staged diff`);

// 4. history (optional)
let historyHits = 0;
if (withHistory) {
  const hasCommits = spawnSync("git", ["rev-parse", "--verify", "HEAD"], { cwd: root }).status === 0;
  if (hasCommits) {
    const log = git(["log", "-p", "--all"]);
    for (const [value] of secrets) if (log.includes(value)) historyHits++;
    if (historyHits) fail(`${historyHits} secret value(s) found in git history`);
  }
}

console.log(
  `check-secrets: ${secrets.size} secret value(s) loaded, ${tracked.length} tracked files scanned, ` +
    `forbidden tracked: ${badTracked.length}, file hits: ${fileHits}, staged hits: ${stagedHits}` +
    (withHistory ? `, history hits: ${historyHits}` : "") +
    (failures ? " -> FAILED" : " -> OK"),
);
process.exit(failures ? 1 : 0);
