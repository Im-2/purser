import { loadConfig } from "./config.js";
import { loadDotEnv } from "./env.js";
import { PayPalError, createPayPalClient, createPayout, waitForPayoutBatch } from "./paypal/index.js";

// Usage: pnpm --filter @purser/server demo:oob-payout [--no-simulate]
//
// Simulates a compromised credential or a bypass: a $5 payout to the Northwind vendor made DIRECTLY through the PayPal
// adapter, never touching Purser's gateway, policy or ledger (real sandbox money). It then feeds the matching webhook
// events to the running server's dev-only simulator so reconciliation flags the payout as unrecorded_movement.
// Real webhooks need a public URL, so the events are simulated here and signature verification is skipped on that route only.
// --no-simulate: make the payout and print the events without sending them.
async function main(): Promise<number> {
  loadDotEnv();
  const config = loadConfig();
  const to = config.VENDOR_NORTHWIND_EMAIL;
  if (!to) {
    console.error("demo:oob-payout: VENDOR_NORTHWIND_EMAIL is not set in .env");
    return 1;
  }
  const simulate = !process.argv.includes("--no-simulate");
  const paypal = createPayPalClient(config);

  const stamp = Date.now();
  const ids = { senderBatchId: `oob_batch_${stamp}`, senderItemId: `oob_item_${stamp}`, idempotencyKey: `oob-${stamp}` };
  console.log(`1. Direct payout of $5.00 to ${to} through the PayPal adapter (bypassing Purser) ...`);
  let batchId: string;
  try {
    const created = await createPayout(paypal, { receiverEmail: to, amountMinor: 500, currency: "USD", note: "Out-of-band payout (Purser demo)", ...ids });
    batchId = created.batch_header.payout_batch_id;
    console.log(`   created batch ${batchId} (sender_batch_id=${ids.senderBatchId})`);
  } catch (e) {
    if (e instanceof PayPalError) console.error(JSON.stringify({ status: e.status, code: e.code, debug_id: e.debugId, message: e.message }, null, 2));
    else console.error((e as Error).message);
    return 1;
  }

  const batch = await waitForPayoutBatch(paypal, batchId, { timeoutMs: 60_000, intervalMs: 3_000 });
  const item = batch.items?.[0];
  console.log(`   batch status: ${batch.batch_header.batch_status}; item status: ${item?.transaction_status ?? "n/a"}`);
  if (!item) {
    console.error("   the batch has no item yet; cannot build the webhook event");
    return 1;
  }

  // The event PayPal would send. Item events carry the payout_item object; batch events carry batch_header (no items).
  const now = new Date().toISOString();
  const itemEvent = {
    id: `WH-SIM-OOB-ITEM-${stamp}`,
    create_time: now,
    resource_type: "payouts_item",
    event_version: "1.0",
    event_type: "PAYMENT.PAYOUTS-ITEM.SUCCEEDED",
    summary: "A payout item has succeeded.",
    resource: {
      payout_item_id: item.payout_item_id,
      transaction_id: item.transaction_id,
      transaction_status: item.transaction_status,
      payout_batch_id: batchId,
      sender_batch_id: item.sender_batch_id ?? ids.senderBatchId,
      payout_item: { recipient_type: "EMAIL", receiver: item.payout_item.receiver, amount: item.payout_item.amount, sender_item_id: item.payout_item.sender_item_id ?? ids.senderItemId, note: item.payout_item.note },
      time_processed: now,
    },
  };
  const batchEvent = {
    id: `WH-SIM-OOB-BATCH-${stamp}`,
    create_time: now,
    resource_type: "payouts",
    event_version: "1.0",
    event_type: "PAYMENT.PAYOUTSBATCH.SUCCESS",
    summary: "Payouts batch completed.",
    resource: { batch_header: { payout_batch_id: batchId, batch_status: "SUCCESS", sender_batch_header: { sender_batch_id: ids.senderBatchId }, amount: batch.batch_header.amount } },
  };

  if (!simulate) {
    console.log("\n--no-simulate: events that would be sent:");
    console.log(JSON.stringify([itemEvent, batchEvent], null, 2));
    return 0;
  }

  const token = config.PURSER_ADMIN_TOKEN;
  if (!token) {
    console.error("\nPURSER_ADMIN_TOKEN is not set in .env, cannot call the simulator.");
    return 1;
  }
  const url = `http://127.0.0.1:${config.PORT}/api/dev/simulate-webhook`;
  console.log(`\n2. Feeding the simulated webhook events to ${url} (signature check skipped on this dev-only route) ...`);
  let found = false;
  for (const ev of [itemEvent, batchEvent]) {
    let res: Response;
    try {
      res = await fetch(url, { method: "POST", headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(ev) });
    } catch (e) {
      console.error(`   could not reach the server: ${(e as Error).message}. Is it running? (pnpm --filter @purser/server dev)`);
      return 1;
    }
    const body = (await res.json().catch(() => ({}))) as { outcome?: string; findings?: { id: string; finding_type: string; detail: Record<string, unknown> }[]; error?: string; message?: string };
    console.log(`   ${ev.event_type} -> HTTP ${res.status} outcome=${body.outcome ?? body.error ?? "?"} findings=${body.findings?.length ?? 0}`);
    for (const f of body.findings ?? []) {
      console.log(`     FINDING ${f.finding_type} (${f.id})`);
      console.log(`       ${String(f.detail.message ?? "")}`);
      if (f.finding_type === "unrecorded_movement") found = true;
    }
    if (!res.ok) return 1;
  }
  console.log(found ? "\ndemo:oob-payout OK: reconciliation flagged the payout as unrecorded_movement" : "\ndemo:oob-payout FAILED: no unrecorded_movement finding was created");
  return found ? 0 : 1;
}

process.exitCode = await main().catch((e: Error) => {
  console.error(`demo:oob-payout failed: ${e.message}`);
  return 1;
});
