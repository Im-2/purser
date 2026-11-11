import { loadConfig } from "./config.js";
import { loadDotEnv, resolveDbPath } from "./env.js";
import { openDb } from "./db/index.js";
import { createRepos } from "./db/repos.js";
import { PayPalError, PayPalNetworkError, UpstreamError, UPSTREAM_TOOLS_KV_KEY, createPayPalClient, createPayout, createUpstream, payoutIdsForAttempt, resultText, waitForPayoutBatch } from "./paypal/index.js";

// Usage: pnpm --filter @purser/server smoke:paypal [--skip-payout]
// Prints exact errors and exits non-zero. It never retries differently or works around a failure.
loadDotEnv();
const skipPayout = process.argv.includes("--skip-payout");
const config = loadConfig();
const repos = createRepos(openDb(resolveDbPath(config.DATABASE_PATH)));
const paypal = createPayPalClient(config);
const upstream = createUpstream(paypal, repos);

function fail(title: string, err: unknown): never {
  console.error(`\nFAILED: ${title}`);
  if (err instanceof PayPalError) {
    console.error(JSON.stringify({ status: err.status, code: err.code, debug_id: err.debugId, message: err.message, details: err.details, body: err.body }, null, 2));
  } else if (err instanceof UpstreamError) {
    console.error(`message: ${err.message}`);
    console.error(`stderr from child process:\n${err.stderr || "(empty)"}`);
  } else if (err instanceof PayPalNetworkError) {
    console.error(`network: ${err.message}`);
  } else {
    console.error(err instanceof Error ? `${err.name}: ${err.message}` : String(err));
  }
  process.exit(1);
}

console.log("1. OAuth token ...");
try {
  const t = await paypal.getAccessToken();
  console.log(`   ok, expires in ${Math.round((t.expiresAtMs - Date.now()) / 60000)} min`);
} catch (err) {
  fail("OAuth token", err);
}

console.log("2. Upstream PayPal MCP (stdio: npx -y @paypal/mcp --tools=all) ...");
let toolNames: string[] = [];
try {
  const tools = await upstream.start();
  toolNames = tools.map((t) => t.name);
  console.log(`   discovered ${toolNames.length} tools:`);
  console.log("   " + toolNames.join(", "));
  const cached = repos.kv.get(UPSTREAM_TOOLS_KV_KEY);
  console.log(`   cached in kv: ${cached ? "yes" : "NO"}`);
} catch (err) {
  await upstream.close();
  fail("starting the upstream MCP server", err);
}

console.log("3. Read tool ...");
const readTool = toolNames.find((n) => n === "list_invoices") ?? toolNames.find((n) => /^(list|get|show)_/.test(n));
if (!readTool) {
  await upstream.close();
  fail("no read tool found upstream", new Error("tool list had no list_/get_/show_ tool"));
}
try {
  const r = await upstream.callTool(readTool, readTool === "list_invoices" ? { page: 1, page_size: 5, total_required: true } : {});
  const text = resultText(r);
  console.log(`   called ${readTool}, isError=${Boolean(r.isError)}`);
  console.log("   " + text.replace(/\s+/g, " ").slice(0, 300));
  if (r.isError) {
    await upstream.close();
    fail(`read tool ${readTool} returned an error`, new Error(text));
  }
} catch (err) {
  await upstream.close();
  fail(`calling ${readTool}`, err);
}

if (skipPayout) {
  console.log("4. Payout skipped (--skip-payout)");
} else {
  const acme = config.VENDOR_ACME_EMAIL;
  if (!acme) {
    await upstream.close();
    fail("payout", new Error("VENDOR_ACME_EMAIL is not set in .env"));
  }
  console.log("4. Creating a $1.00 sandbox payout to the Acme vendor ...");
  const attemptId = `smoke_${Date.now()}`;
  const ids = payoutIdsForAttempt(attemptId);
  try {
    const created = await createPayout(paypal, { receiverEmail: acme, amountMinor: 100, currency: "USD", note: "Purser smoke test", ...ids });
    const batchId = created.batch_header.payout_batch_id;
    console.log(`   created batch ${batchId} status=${created.batch_header.batch_status} (sender_batch_id=${ids.senderBatchId})`);
    const batch = await waitForPayoutBatch(paypal, batchId, { timeoutMs: 60_000, intervalMs: 3_000 });
    const item = batch.items?.[0];
    console.log(`   final batch status: ${batch.batch_header.batch_status}; item status: ${item?.transaction_status ?? "n/a"}`);
    if (batch.batch_header.batch_status !== "SUCCESS") {
      await upstream.close();
      fail(`payout batch ended as ${batch.batch_header.batch_status}`, new Error(JSON.stringify(batch)));
    }
  } catch (err) {
    await upstream.close();
    fail("sandbox payout", err);
  }
}

await upstream.close();
console.log("\nsmoke:paypal OK");
process.exit(0);
