import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { LlmEnv } from "@purser/shared/llm";

/** Repo root (agent/src -> repo). pnpm --filter runs scripts with cwd=agent, so never rely on the cwd. */
export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
export const fixturesDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures");

/** Load <repo>/.env into process.env if present. Real environment variables win. Never prints values. */
export function loadDotEnv(): void {
  const file = path.join(repoRoot, ".env");
  if (existsSync(file)) process.loadEnvFile(file);
}

const opt = (v: string | undefined) => (v && v.trim() ? v.trim() : undefined);

export interface AgentEnv {
  port: number;
  baseUrl: string;
  agentKey: string | undefined;
  adminToken: string | undefined;
  acmeEmail: string | undefined;
  northwindEmail: string | undefined;
  paypalClientId: string | undefined;
  paypalClientSecret: string | undefined;
  llm: LlmEnv;
  aiMode: string;
}

/** Read the environment into one typed object. Secrets are held here and never printed by this package. */
export function readEnv(e: NodeJS.ProcessEnv = process.env): AgentEnv {
  const port = Number(opt(e.PORT) ?? 8799);
  const effort = opt(e.LLM_REASONING_EFFORT);
  const provider = opt(e.LLM_PROVIDER);
  return {
    port,
    baseUrl: `http://127.0.0.1:${port}`,
    agentKey: opt(e.AGENT_API_KEY),
    adminToken: opt(e.PURSER_ADMIN_TOKEN),
    acmeEmail: opt(e.VENDOR_ACME_EMAIL),
    northwindEmail: opt(e.VENDOR_NORTHWIND_EMAIL),
    paypalClientId: opt(e.PAYPAL_CLIENT_ID),
    paypalClientSecret: opt(e.PAYPAL_CLIENT_SECRET),
    aiMode: opt(e.AI_MODE) ?? "live",
    llm: {
      LLM_PROVIDER: provider === "anthropic" || provider === "openai_compat" ? provider : undefined,
      LLM_BASE_URL: opt(e.LLM_BASE_URL),
      LLM_API_KEY: opt(e.LLM_API_KEY),
      LLM_MODEL: opt(e.LLM_MODEL),
      LLM_REASONING_EFFORT: effort === "none" || effort === "low" || effort === "medium" || effort === "high" ? effort : "low",
      LLM_TIMEOUT_MS: Number(opt(e.LLM_TIMEOUT_MS) ?? 20000),
      ANTHROPIC_API_KEY: opt(e.ANTHROPIC_API_KEY),
      PURSER_MODEL: opt(e.PURSER_MODEL) ?? "claude-sonnet-5-5",
    },
  };
}
