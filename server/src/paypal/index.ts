import type { Config } from "../config.js";
import type { Repos } from "../db/repos.js";
import { PayPalClient, type FetchLike } from "./client.js";
import { StdioUpstream, type UpstreamClient, type UpstreamTool } from "./upstream.js";

export * from "./errors.js";
export * from "./client.js";
export * from "./payouts.js";
export * from "./captures.js";
export * from "./webhooks.js";
export * from "./upstream.js";

export const UPSTREAM_TOOLS_KV_KEY = "upstream_tools";

export function createPayPalClient(config: Config, fetchImpl?: FetchLike): PayPalClient {
  if (!config.PAYPAL_CLIENT_ID || !config.PAYPAL_CLIENT_SECRET) {
    throw new Error("PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET must be set in .env");
  }
  return new PayPalClient({ clientId: config.PAYPAL_CLIENT_ID, clientSecret: config.PAYPAL_CLIENT_SECRET, fetch: fetchImpl });
}

/** Stdio upstream that caches the discovered tool list in kv after each start. */
export function createUpstream(paypal: PayPalClient, repos?: Repos): UpstreamClient {
  return new StdioUpstream({
    paypal,
    onTools: (tools) => repos?.kv.set(UPSTREAM_TOOLS_KV_KEY, JSON.stringify({ fetched_at: Date.now(), tools })),
  });
}

export function cachedUpstreamTools(repos: Repos): UpstreamTool[] {
  const raw = repos.kv.get(UPSTREAM_TOOLS_KV_KEY);
  if (!raw) return [];
  try {
    return (JSON.parse(raw) as { tools: UpstreamTool[] }).tools;
  } catch {
    return [];
  }
}
