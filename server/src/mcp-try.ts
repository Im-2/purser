import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { loadConfig } from "./config.js";
import { loadDotEnv } from "./env.js";

// Usage: pnpm --filter @purser/server mcp:try [--skip-payout]
// Connects to the running gateway as the seeded agent, lists tools, pays $120 to the Acme vendor (real sandbox
// money) and then attempts $9,999, which must be denied. The agent key comes from AGENT_API_KEY in .env and is never printed.
loadDotEnv();
const config = loadConfig();
const key = config.AGENT_API_KEY;
if (!key) {
  console.error("mcp:try: AGENT_API_KEY is not set in .env. Run: pnpm --filter @purser/server seed -- --reset --write-env");
  process.exit(1);
}
const acme = config.VENDOR_ACME_EMAIL;
if (!acme) {
  console.error("mcp:try: VENDOR_ACME_EMAIL is not set in .env");
  process.exit(1);
}
const skipPayout = process.argv.includes("--skip-payout");
const url = new URL(`http://127.0.0.1:${config.PORT}/mcp`);

const NATIVE = new Set(["purser_payout", "purser_check_approval", "purser_status"]);

async function callJson(client: Client, name: string, args: Record<string, unknown>) {
  const res = (await client.callTool({ name, arguments: args })) as { content?: { type: string; text?: string }[]; isError?: boolean };
  const raw = res.content?.map((c) => c.text ?? "").join("\n") ?? "";
  let json: Record<string, unknown> | null = null;
  try {
    json = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    // not JSON
  }
  return { raw, json, isError: Boolean(res.isError) };
}

const client = new Client({ name: "purser-mcp-try", version: "0.1.0" });
const transport = new StreamableHTTPClientTransport(url, { requestInit: { headers: { Authorization: `Bearer ${key}` } } });

try {
  console.log(`Connecting to ${url.origin}/mcp ...`);
  await client.connect(transport);
  console.log("connected");
} catch (err) {
  const msg = (err as Error).message;
  console.error(`mcp:try: could not connect: ${msg}`);
  if (/401|unauthor/i.test(msg)) console.error("The key was rejected. Re-seed: pnpm --filter @purser/server seed -- --reset --write-env");
  else console.error("Is the server running? Start it with: pnpm --filter @purser/server dev");
  process.exit(1);
}

let exitCode = 0;
try {
  const { tools } = await client.listTools();
  const upstream = tools.filter((t) => !NATIVE.has(t.name));
  const native = tools.filter((t) => NATIVE.has(t.name));
  const annotated = (t: (typeof tools)[number]) => ((t.inputSchema as { properties?: Record<string, unknown> }).properties ?? {}).reason !== undefined;
  console.log(`\nPayPal tools (${upstream.length}):`);
  console.log("  " + upstream.map((t) => t.name + (annotated(t) ? "*" : "")).join(", "));
  console.log(`Purser tools (${native.length}):`);
  console.log("  " + native.map((t) => t.name + (annotated(t) ? "*" : "")).join(", "));
  console.log("  (* = takes optional reason/source)");

  const status = await callJson(client, "purser_status", {});
  console.log("\nstatus:", status.raw);

  if (skipPayout) {
    console.log("\npayouts skipped (--skip-payout)");
  } else {
    console.log("\nHappy path: $120.00 to the Acme vendor (real sandbox money) ...");
    const ok = await callJson(client, "purser_payout", { recipient_email: acme, amount: 120, currency: "USD", note: "Purser mcp:try", reason: "Monthly supplies invoice", source: "mcp:try CLI" });
    console.log("  ->", ok.raw);
    if (ok.json?.purser !== "executed") {
      console.error("  expected purser=executed");
      exitCode = 1;
    }

    console.log("\nAttack check: $9,999.00 to the same vendor (must be denied) ...");
    const big = await callJson(client, "purser_payout", { recipient_email: acme, amount: 9999, currency: "USD", reason: "Large payment", source: "mcp:try CLI" });
    console.log("  ->", big.raw);
    if (big.json?.purser !== "denied") {
      console.error("  FAIL: the $9,999 payout was not denied");
      exitCode = 2;
    }
  }
} catch (err) {
  console.error(`mcp:try: ${(err as Error).message}`);
  exitCode = 1;
} finally {
  await client.close().catch(() => undefined);
}
console.log(exitCode === 0 ? "\nmcp:try OK" : "\nmcp:try FAILED");
process.exit(exitCode);
