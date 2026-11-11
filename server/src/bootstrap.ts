import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { Repos } from "./db/repos.js";
import { VerdictSchema } from "./ai/reviewer.js";
import { repoRoot } from "./env.js";
import { SEEDED_AGENT_ID, defaultPolicy } from "./policy/defaults.js";

/** Committed, secret-free AI verdicts (see `pnpm --filter @purser/server ai:export-cache`). */
export const VERDICT_SEED_FILE = path.join(repoRoot, "server", "seed", "ai-verdicts.json");

export interface SeedInput {
  acmeEmail: string;
  northwindEmail: string;
  /** The agent's API key. It is hashed by the repo layer; the plain value is never stored or logged. */
  apiKey: string;
}

/** The seeded demo world: the Ops agent, two trusted vendors, and the default policy (SPEC section 6). Idempotent per database. */
export function seedDemoWorld(repos: Repos, s: SeedInput): void {
  repos.agents.create({ id: SEEDED_AGENT_ID, name: "Ops agent", apiKey: s.apiKey, mandate: "Pay approved vendors and issue customer refunds for the store." });
  repos.payees.upsert({ email: s.acmeEmail, display_name: "Acme Supplies", trusted: true, notes: "Seeded vendor" });
  repos.payees.upsert({ email: s.northwindEmail, display_name: "Northwind Parts", trusted: true, notes: "Seeded vendor" });
  repos.policies.apply(SEEDED_AGENT_ID, defaultPolicy({ agentId: SEEDED_AGENT_ID, allowlist: [s.acmeEmail, s.northwindEmail] }), "Seeded default policy (SPEC section 6)");
}

export interface BootResult {
  seeded: boolean;
  reason?: string;
}

/**
 * First boot on an empty (or wiped) database, which is what an ephemeral Render disk looks like after every restart:
 * seed the agent from AGENT_API_KEY so the server-side Attack Lab can authenticate without any key being printed.
 */
export function ensureSeeded(repos: Repos, env: { acme?: string; northwind?: string; agentKey?: string }): BootResult {
  if (repos.agents.get(SEEDED_AGENT_ID)) return { seeded: false };
  if (!env.acme || !env.northwind) return { seeded: false, reason: "VENDOR_ACME_EMAIL and VENDOR_NORTHWIND_EMAIL are not set" };
  if (!env.agentKey) return { seeded: false, reason: "AGENT_API_KEY is not set, so the demo agent cannot be created" };
  seedDemoWorld(repos, { acmeEmail: env.acme, northwindEmail: env.northwind, apiKey: env.agentKey });
  return { seeded: true };
}

const SeedFile = z.object({
  prompt_version: z.string().optional(),
  verdicts: z.array(z.object({ key: z.string().regex(/^[0-9a-f]{64}$/), model: z.string().min(1), verdict: z.unknown() })),
});

/**
 * Load the shipped verdict cache into the database. Existing rows win (they may be newer live verdicts); loaded rows are
 * stamped "now" so they are fresh after a cold start. Invalid entries are skipped. Returns how many were added.
 */
export function loadVerdictSeed(repos: Repos, file: string = VERDICT_SEED_FILE, now: number = Date.now()): { added: number; skipped: number } {
  if (!existsSync(file)) return { added: 0, skipped: 0 };
  let parsed: z.infer<typeof SeedFile>;
  try {
    parsed = SeedFile.parse(JSON.parse(readFileSync(file, "utf8")));
  } catch {
    return { added: 0, skipped: 0 };
  }
  let added = 0;
  let skipped = 0;
  for (const v of parsed.verdicts) {
    if (repos.verdicts.get(v.key)) continue;
    const ok = VerdictSchema.safeParse(v.verdict);
    if (!ok.success) {
      skipped++;
      continue;
    }
    repos.verdicts.put(v.key, ok.data, v.model, now);
    added++;
  }
  return { added, skipped };
}
