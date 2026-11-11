#!/usr/bin/env node
// Fails if a variable the server reads (the zod EnvSchema in server/src/config.ts) is missing from .env.example.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const schema = readFileSync(path.join(root, "server", "src", "config.ts"), "utf8");
const block = schema.slice(schema.indexOf("EnvSchema = z.object({"), schema.indexOf("export type Config"));
const wanted = [...block.matchAll(/^\s{2}([A-Z][A-Z0-9_]+):/gm)].map((m) => m[1]);
const example = readFileSync(path.join(root, ".env.example"), "utf8");
const have = new Set([...example.matchAll(/^#?\s*([A-Z][A-Z0-9_]+)=/gm)].map((m) => m[1]));
const missing = wanted.filter((k) => !have.has(k));
if (missing.length) {
  console.error(`check-env-example: missing from .env.example: ${missing.join(", ")}`);
  process.exit(1);
}
console.log(`check-env-example: all ${wanted.length} variables are documented in .env.example`);
