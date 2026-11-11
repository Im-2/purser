import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { PurserEvent } from "@purser/shared";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { createRepos, openDb, type Repos } from "../src/db/index.js";
import { createEventBus } from "../src/events.js";
import type { GatewayDeps } from "../src/gateway/pipeline.js";
import { PayPalClient, type FetchLike, type UpstreamClient } from "../src/paypal/index.js";
import { normalizeEvent, type Envelope } from "../src/reconciliation/events.js";
import { processWebhookEvent } from "../src/reconciliation/matcher.js";
import { runReconciliation } from "../src/reconciliation/run.js";

const ACME = "acme-supplies@personal.example.com";
const NORTHWIND = "northwind-parts@personal.example.com";
const TOKEN = "admin-token-for-tests";
const auth = { authorization: `Bearer ${TOKEN}` };

let repos: Repos;
let events: PurserEvent[];
let attemptId: string;
let ledgerId: string;

function reset() {
  repos = createRepos(openDb(":memory:"));
  events = [];
  repos.agents.create({ id: "agent_ops_01", name: "Ops", apiKey: "pk_ops" });
  // An executed $120 payout to Acme, as the gateway would have recorded it.
  const a = repos.attempts.create({ agent_id: "agent_ops_01", tool: "purser_payout", tool_class: "money_out", args: {}, amount: 12000, currency: "USD", payee_email: ACME, decision: "allow", decision_stage: "rules" });
  attemptId = a.id;
  ledgerId = repos.ledger.create({ attempt_id: a.id, paypal_ref: { payout_batch_id: "BATCH1", sender_batch_id: `batch_${a.id}`, sender_item_id: a.id, batch_status: "PENDING" }, amount: 12000, currency: "USD", status: "PENDING" }).id;
}
const bus = () => {
  const b = createEventBus();
  b.subscribe((e) => events.push(e));
  return b;
};
const deps = () => ({ repos, bus: bus() });

let n = 0;
const uid = (p: string) => `${p}-${++n}`;

function itemEvent(o: { id?: string; type?: string; batch?: string | null; senderItem?: string | null; senderBatch?: string | null; amount?: string; currency?: string; receiver?: string; itemId?: string; txn?: string } = {}): Envelope {
  return {
    id: o.id ?? uid("WH"),
    event_type: o.type ?? "PAYMENT.PAYOUTS-ITEM.SUCCEEDED",
    resource_type: "payouts_item",
    create_time: "2026-11-11T10:00:00Z",
    resource: {
      payout_item_id: o.itemId ?? "ITEM1",
      transaction_id: o.txn ?? "TXN1",
      transaction_status: "SUCCESS",
      ...(o.batch === null ? {} : { payout_batch_id: o.batch ?? "BATCH1" }),
      ...(o.senderBatch ? { sender_batch_id: o.senderBatch } : {}),
      payout_item: { receiver: o.receiver ?? ACME, amount: { value: o.amount ?? "120.00", currency: o.currency ?? "USD" }, ...(o.senderItem === null ? {} : { sender_item_id: o.senderItem ?? attemptId }) },
    },
  };
}
const batchEvent = (type: string, o: { id?: string; batch?: string; amount?: string; sender?: string | null } = {}): Envelope => ({
  id: o.id ?? uid("WHB"),
  event_type: type,
  resource: { batch_header: { payout_batch_id: o.batch ?? "BATCH1", batch_status: "SUCCESS", sender_batch_header: { sender_batch_id: o.sender === undefined ? `batch_${attemptId}` : (o.sender ?? undefined) }, ...(o.amount ? { amount: { value: o.amount, currency: "USD" } } : {}) } },
});
const captureEvent = (type: string, o: { id?: string; capture?: string; amount?: string; order?: string } = {}): Envelope => ({
  id: o.id ?? uid("WHC"),
  event_type: type,
  resource: { id: o.capture ?? "CAP123456", amount: { value: o.amount ?? "30.00", currency_code: "USD" }, status: "COMPLETED", supplementary_data: { related_ids: { order_id: o.order ?? "ORDER1" } } },
});
const refundEvent = (o: { id?: string; refund?: string; capture?: string; amount?: string } = {}): Envelope => ({
  id: o.id ?? uid("WHR"),
  event_type: "PAYMENT.CAPTURE.REFUNDED",
  resource: { id: o.refund ?? "REFUND1", amount: { value: o.amount ?? "30.00", currency_code: "USD" }, status: "COMPLETED", links: [{ rel: "self", href: "https://api.sandbox.paypal.com/v2/payments/refunds/REFUND1" }, { rel: "up", href: `https://api.sandbox.paypal.com/v2/payments/captures/${o.capture ?? "CAP123456"}` }] },
});
const types = (r: { findings: { finding_type: string }[] }) => r.findings.map((f) => f.finding_type);
const sseFindings = () => events.filter((e) => e.type === "reconciliation_finding");

beforeEach(reset);

describe("normalizeEvent: PayPal's current payload shapes", () => {
  it("payout item: reads the payout_item object", () => {
    const o = normalizeEvent(itemEvent({ senderBatch: "batch_x" }))!;
    expect(o).toMatchObject({ kind: "payout_item", status: "SUCCESS", amountMinor: 12000, currency: "USD", receiver: ACME, ids: { payout_batch_id: "BATCH1", payout_item_id: "ITEM1", sender_batch_id: "batch_x", sender_item_id: attemptId, transaction_id: "TXN1" } });
  });
  it("covers every payout item, batch, capture and refund event name", () => {
    const item = ["SUCCEEDED", "FAILED", "BLOCKED", "HELD", "RETURNED", "REFUNDED", "UNCLAIMED", "CANCELED", "DENIED"];
    for (const s of item) expect(normalizeEvent(itemEvent({ type: `PAYMENT.PAYOUTS-ITEM.${s}` }))?.kind, s).toBe("payout_item");
    for (const s of ["PROCESSING", "SUCCESS", "DENIED"]) expect(normalizeEvent(batchEvent(`PAYMENT.PAYOUTSBATCH.${s}`))?.kind, s).toBe("payout_batch");
    for (const s of ["COMPLETED", "PENDING", "REVERSED", "DENIED", "DECLINED"]) expect(normalizeEvent(captureEvent(`PAYMENT.CAPTURE.${s}`))?.kind, s).toBe("capture");
    expect(normalizeEvent(refundEvent())?.kind).toBe("refund");
  });
  it("batch events read batch_header; refund events find the capture through the 'up' link", () => {
    expect(normalizeEvent(batchEvent("PAYMENT.PAYOUTSBATCH.SUCCESS", { amount: "5.00" }))).toMatchObject({ ids: { payout_batch_id: "BATCH1", sender_batch_id: `batch_${attemptId}` }, amountMinor: 500 });
    expect(normalizeEvent(refundEvent({ capture: "CAPXYZ" }))).toMatchObject({ ids: { refund_id: "REFUND1", capture_id: "CAPXYZ" }, amountMinor: 3000 });
  });
  it("returns null for events we do not reconcile and tolerates odd payloads", () => {
    expect(normalizeEvent({ id: "x", event_type: "BILLING.SUBSCRIPTION.CREATED", resource: {} })).toBeNull();
    const o = normalizeEvent({ id: "x", event_type: "PAYMENT.PAYOUTS-ITEM.SUCCEEDED", resource: { payout_item: { amount: { value: "abc", currency: "usd" } } } })!;
    expect(o.amountMinor).toBeNull();
    expect(o.currency).toBe("USD");
  });
});

describe("matcher: a payout Purser recorded", () => {
  it("PAYOUTS-ITEM.SUCCEEDED matches the ledger, updates its status and learns the transaction id", () => {
    const r = processWebhookEvent(deps(), itemEvent(), "webhook");
    expect(r).toMatchObject({ outcome: "processed", matched: 1, findings: [] });
    expect(repos.ledger.get(ledgerId)?.status).toBe("SUCCESS");
    expect(JSON.parse(repos.ledger.get(ledgerId)!.paypal_ref_json)).toMatchObject({ transaction_id: "TXN1", payout_item_id: "ITEM1" });
    const row = repos.reconciliation.list()[0]!;
    expect(row).toMatchObject({ matched: 1, finding_type: null, ledger_id: ledgerId });
    expect(JSON.parse(row.detail_json)).toMatchObject({ matched_via: "sender_item_id", attempt_id: attemptId });
    expect(sseFindings()).toHaveLength(0); // ok rows are not findings
  });

  it("matches by the stored payout_batch_id, or by sender_batch_id, when sender_item_id is missing", () => {
    expect(processWebhookEvent(deps(), itemEvent({ senderItem: null, itemId: "I2" }), "webhook").matched).toBe(1);
    reset();
    expect(processWebhookEvent(deps(), itemEvent({ senderItem: null, batch: null, senderBatch: `batch_${attemptId}`, itemId: "I3" }), "webhook").matched).toBe(1);
  });

  it("flags amount_mismatch, with currency and receiver differences listed", () => {
    const a = processWebhookEvent(deps(), itemEvent({ amount: "125.00" }), "webhook");
    expect(types(a)).toEqual(["amount_mismatch"]);
    expect(a.findings[0]!.detail.mismatches).toEqual([expect.stringContaining("recorded 120.00 USD, PayPal 125.00 USD")]);

    reset();
    const b = processWebhookEvent(deps(), itemEvent({ currency: "EUR" }), "webhook");
    expect(JSON.stringify(b.findings[0]!.detail.mismatches)).toMatch(/currency: recorded USD, PayPal EUR/);

    reset();
    const c = processWebhookEvent(deps(), itemEvent({ receiver: NORTHWIND }), "webhook");
    expect(types(c)).toEqual(["amount_mismatch"]);
    expect(JSON.stringify(c.findings[0]!.detail.mismatches)).toMatch(/receiver: approved acme-supplies/);
    expect(sseFindings()).toHaveLength(1); // the reset above cleared earlier events, so this is the receiver mismatch alone
  });

  it.each(["UNCLAIMED", "FAILED", "BLOCKED", "HELD", "RETURNED", "REFUNDED", "CANCELED", "DENIED"])("PAYOUTS-ITEM.%s is a payout_denied_or_unclaimed finding and updates the ledger", (s) => {
    const r = processWebhookEvent(deps(), itemEvent({ type: `PAYMENT.PAYOUTS-ITEM.${s}` }), "webhook");
    expect(types(r)).toEqual(["payout_denied_or_unclaimed"]);
    expect(repos.ledger.get(ledgerId)?.status).toBe(s);
    expect(r.findings[0]!.detail).toMatchObject({ status: s, attempt_id: attemptId });
  });

  it("batch events: SUCCESS matches, DENIED is a finding, PROCESSING only updates the status", () => {
    expect(processWebhookEvent(deps(), batchEvent("PAYMENT.PAYOUTSBATCH.PROCESSING"), "webhook")).toMatchObject({ matched: 0, findings: [] });
    expect(repos.ledger.get(ledgerId)?.status).toBe("PROCESSING");
    expect(processWebhookEvent(deps(), batchEvent("PAYMENT.PAYOUTSBATCH.SUCCESS", { amount: "120.00" }), "webhook")).toMatchObject({ matched: 1, findings: [] });
    expect(repos.ledger.get(ledgerId)?.status).toBe("SUCCESS");
    reset();
    expect(types(processWebhookEvent(deps(), batchEvent("PAYMENT.PAYOUTSBATCH.DENIED"), "webhook"))).toEqual(["payout_denied_or_unclaimed"]);
  });
});

describe("matcher: unrecorded movement", () => {
  it("a payout Purser has no attempt for is flagged and published over the event bus", () => {
    const d = deps();
    const r = processWebhookEvent(d, itemEvent({ batch: "OOBBATCH", senderItem: "oob_item_1", itemId: "OOBITEM", txn: "OOBTXN", receiver: NORTHWIND, amount: "5.00" }), "webhook");
    expect(types(r)).toEqual(["unrecorded_movement"]);
    expect(r.findings[0]!.detail).toMatchObject({ reason: "no_attempt", money_may_have_moved: true, receiver: NORTHWIND, amount: "5.00 USD", payout_batch_id: "OOBBATCH", transaction_id: "OOBTXN" });
    expect(String(r.findings[0]!.detail.message)).toMatch(/bypassed Purser/);
    expect(sseFindings()).toHaveLength(1);
    expect(sseFindings()[0]).toMatchObject({ type: "reconciliation_finding", data: { finding_type: "unrecorded_movement", id: r.findings[0]!.id } });
    expect(repos.ledger.get(ledgerId)?.status).toBe("PENDING"); // the recorded payout is untouched
  });

  it("the batch event for the same payout does not raise a second finding (either order)", () => {
    const first = deps();
    expect(types(processWebhookEvent(first, itemEvent({ batch: "OOB2", senderItem: "oob_item_2", itemId: "OI2" }), "webhook"))).toEqual(["unrecorded_movement"]);
    expect(processWebhookEvent(first, batchEvent("PAYMENT.PAYOUTSBATCH.SUCCESS", { batch: "OOB2", sender: "oob_batch_2" }), "webhook").findings).toEqual([]);

    const second = deps();
    expect(types(processWebhookEvent(second, batchEvent("PAYMENT.PAYOUTSBATCH.SUCCESS", { batch: "OOB3", sender: "oob_batch_3" }), "webhook"))).toEqual(["unrecorded_movement"]);
    expect(processWebhookEvent(second, itemEvent({ batch: "OOB3", senderItem: "oob_item_3", itemId: "OI3" }), "webhook").findings).toEqual([]);
    expect(repos.reconciliation.list({ finding_type: "unrecorded_movement" })).toHaveLength(2);
  });

  it("a failed out-of-band payout is still reported, but marked as no money moved", () => {
    const r = processWebhookEvent(deps(), itemEvent({ type: "PAYMENT.PAYOUTS-ITEM.FAILED", batch: "OOB4", senderItem: "oob_item_4", itemId: "OI4" }), "webhook");
    expect(r.findings[0]!.detail).toMatchObject({ money_may_have_moved: false, status: "FAILED" });
  });

  it("a payout for an attempt Purser did not execute (denied attempt) is unrecorded_movement", () => {
    const denied = repos.attempts.create({ agent_id: "agent_ops_01", tool: "purser_payout", tool_class: "money_out", args: {}, amount: 999900, currency: "USD", payee_email: ACME, decision: "deny", decision_stage: "rules" });
    const r = processWebhookEvent(deps(), itemEvent({ senderItem: denied.id, batch: "OTHER", itemId: "OI5" }), "webhook");
    expect(r.findings[0]).toMatchObject({ finding_type: "unrecorded_movement", detail: { reason: "attempt_not_executed", attempt_id: denied.id, attempt_decision: "deny" } });
  });

  it("an event with no usable identifiers is surfaced, not dropped", () => {
    const r = processWebhookEvent(deps(), { id: "bare", event_type: "PAYMENT.PAYOUTS-ITEM.SUCCEEDED", resource: {} }, "webhook");
    expect(types(r)).toEqual(["unrecorded_movement"]);
  });
});

describe("matcher: duplicates and replays", () => {
  it("a replay of the same event id is ignored: no rows, no findings", () => {
    const d = deps();
    const ev = itemEvent({ id: "WH-SAME" });
    expect(processWebhookEvent(d, ev, "webhook").outcome).toBe("processed");
    const rows = repos.reconciliation.count();
    const again = processWebhookEvent(d, ev, "webhook");
    expect(again).toMatchObject({ outcome: "duplicate_event", matched: 0, findings: [] });
    expect(repos.reconciliation.count()).toBe(rows);
    expect(repos.webhookEvents.count()).toBe(1);
    expect(sseFindings()).toHaveLength(0);
  });
  it("the same outcome for the same payout under a different event id is a duplicate finding", () => {
    const d = deps();
    processWebhookEvent(d, itemEvent({ id: "WH-A" }), "webhook");
    const r = processWebhookEvent(d, itemEvent({ id: "WH-B" }), "webhook");
    expect(types(r)).toEqual(["duplicate"]);
    expect(r.findings[0]!.detail).toMatchObject({ original_event_id: "WH-A" });
    expect(repos.ledger.get(ledgerId)?.status).toBe("SUCCESS"); // not applied twice
    expect(sseFindings()).toHaveLength(1);
  });
  it("different statuses for one payout are not duplicates", () => {
    const d = deps();
    processWebhookEvent(d, itemEvent({ type: "PAYMENT.PAYOUTS-ITEM.HELD" }), "webhook");
    expect(types(processWebhookEvent(d, itemEvent({ type: "PAYMENT.PAYOUTS-ITEM.SUCCEEDED" }), "webhook"))).toEqual([]);
  });
  it("simulated and real events share the dedupe table", () => {
    const d = deps();
    const ev = itemEvent({ id: "WH-BOTH" });
    processWebhookEvent(d, ev, "simulated");
    expect(processWebhookEvent(d, ev, "webhook").outcome).toBe("duplicate_event");
  });
  it("unknown event types are stored and ignored", () => {
    const r = processWebhookEvent(deps(), { id: "u1", event_type: "CUSTOMER.DISPUTE.CREATED", resource: {} }, "webhook");
    expect(r.outcome).toBe("ignored");
    expect(repos.reconciliation.count()).toBe(0);
    expect(processWebhookEvent(deps(), { id: "u1", event_type: "CUSTOMER.DISPUTE.CREATED", resource: {} }, "webhook").outcome).toBe("duplicate_event");
  });
});

describe("matcher: captures and refunds", () => {
  const upstreamLedger = (tool: string, text: string, amount: number | null, args: Record<string, unknown> = {}) => {
    const a = repos.attempts.create({ agent_id: "agent_ops_01", tool, tool_class: tool === "create_refund" ? "money_out" : "capture", args, amount, currency: "USD", payee_email: null, decision: "allow", decision_stage: "rules" });
    return { attempt: a, ledger: repos.ledger.create({ attempt_id: a.id, paypal_ref: { tool, result: text }, amount, currency: "USD", status: "executed" }) };
  };

  it("a capture Purser executed matches by the id in the stored result; an amount difference is flagged", () => {
    upstreamLedger("pay_order", '{"id":"ORDER1","status":"COMPLETED","captures":[{"id":"CAP123456"}]}', 3000);
    expect(processWebhookEvent(deps(), captureEvent("PAYMENT.CAPTURE.COMPLETED"), "webhook")).toMatchObject({ matched: 1, findings: [] });
    expect(types(processWebhookEvent(deps(), captureEvent("PAYMENT.CAPTURE.COMPLETED", { id: "WH-C2", capture: "CAP123456", amount: "31.00" }), "webhook"))).toEqual(["duplicate"]);
    reset();
    upstreamLedger("pay_order", '{"id":"ORDER1","captures":[{"id":"CAP123456"}]}', 3000);
    expect(types(processWebhookEvent(deps(), captureEvent("PAYMENT.CAPTURE.COMPLETED", { amount: "31.00" }), "webhook"))).toEqual(["amount_mismatch"]);
  });
  it("a reversed or denied capture that Purser recorded as executed is a finding", () => {
    upstreamLedger("pay_order", '{"id":"ORDER1","captures":[{"id":"CAP123456"}]}', 3000);
    expect(types(processWebhookEvent(deps(), captureEvent("PAYMENT.CAPTURE.REVERSED"), "webhook"))).toEqual(["payout_denied_or_unclaimed"]);
  });
  it("an inbound customer capture Purser did not initiate is recorded without a finding", () => {
    const d = deps();
    const r = processWebhookEvent(d, captureEvent("PAYMENT.CAPTURE.COMPLETED", { capture: "CUSTCAP99" }), "webhook");
    expect(r).toMatchObject({ outcome: "processed", findings: [], matched: 0 });
    expect(repos.reconciliation.list()[0]).toMatchObject({ matched: 0, finding_type: null });
    expect(sseFindings()).toHaveLength(0);
  });

  it("a refund matches the executed create_refund for that capture", () => {
    upstreamLedger("create_refund", '{"id":"REFUND1","status":"COMPLETED"}', 3000, { capture_id: "CAP123456" });
    expect(processWebhookEvent(deps(), refundEvent(), "webhook")).toMatchObject({ matched: 1, findings: [] });
  });
  it("a refund is matched through the capture id even if the result text lacks the refund id", () => {
    upstreamLedger("create_refund", "{}", 3000, { capture_id: "CAP123456" });
    expect(processWebhookEvent(deps(), refundEvent(), "webhook").matched).toBe(1);
  });
  it("a refund Purser never approved is unrecorded_movement", () => {
    const r = processWebhookEvent(deps(), refundEvent({ refund: "REFUNDX", capture: "CAPUNKNOWN" }), "webhook");
    expect(r.findings[0]).toMatchObject({ finding_type: "unrecorded_movement", detail: { refund_id: "REFUNDX", capture_id: "CAPUNKNOWN", reason: "no_attempt" } });
  });
  it("a refund with a different amount is amount_mismatch; a second refund id for one approval is a duplicate", () => {
    upstreamLedger("create_refund", "{}", 3000, { capture_id: "CAP123456" });
    expect(types(processWebhookEvent(deps(), refundEvent({ amount: "45.00" }), "webhook"))).toEqual(["amount_mismatch"]);
    reset();
    upstreamLedger("create_refund", "{}", 3000, { capture_id: "CAP123456" });
    expect(processWebhookEvent(deps(), refundEvent({ refund: "R-FIRST" }), "webhook").matched).toBe(1);
    expect(types(processWebhookEvent(deps(), refundEvent({ refund: "R-SECOND" }), "webhook"))).toEqual(["duplicate"]);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe("routes: webhook receiver, simulator, findings and manual run", () => {
  let app: FastifyInstance;
  let paypalCalls: { url: string; method: string; body?: string }[];
  let verifyResult: "SUCCESS" | "FAILURE" | "ERROR";
  let batchBodies: Record<string, unknown>;
  let search: { status: number; body: unknown } | "network";
  let nowOffset = 0;

  const batchOf = (id: string, status: string, item: { id: string; txn: string; amount: string; receiver: string; senderItem: string; status?: string }) => ({
    batch_header: { payout_batch_id: id, batch_status: status, sender_batch_header: { sender_batch_id: `batch_${item.senderItem}` }, amount: { value: item.amount, currency: "USD" } },
    items: [{ payout_item_id: item.id, transaction_id: item.txn, transaction_status: item.status ?? "SUCCESS", payout_batch_id: id, payout_item: { receiver: item.receiver, amount: { value: item.amount, currency: "USD" }, sender_item_id: item.senderItem } }],
  });

  async function boot(o: { webhookId?: string | undefined; isProduction?: boolean; paypal?: boolean } = {}) {
    paypalCalls = [];
    verifyResult = "SUCCESS";
    search = { status: 200, body: { transaction_details: [], last_refreshed_datetime: new Date(Date.now() + nowOffset).toISOString(), total_pages: 1 } };
    batchBodies = { BATCH1: batchOf("BATCH1", "SUCCESS", { id: "ITEM1", txn: "TXN1", amount: "120.00", receiver: ACME, senderItem: attemptId }) };
    const fetchFn: FetchLike = async (url, init) => {
      const j = (s: number, b: unknown) => new Response(JSON.stringify(b), { status: s });
      paypalCalls.push({ url, method: init?.method ?? "GET", body: init?.body as string | undefined });
      if (url.endsWith("/v1/oauth2/token")) return j(200, { access_token: "t", expires_in: 3600 });
      if (url.endsWith("/v1/notifications/verify-webhook-signature")) {
        if (verifyResult === "ERROR") return j(500, { name: "INTERNAL_SERVICE_ERROR", message: "x" });
        return j(200, { verification_status: verifyResult });
      }
      const m = /\/v1\/payments\/payouts\/([A-Za-z0-9_-]+)$/.exec(url);
      if (m) return batchBodies[m[1]!] ? j(200, batchBodies[m[1]!]) : j(404, { name: "RESOURCE_NOT_FOUND", message: "no batch" });
      if (url.includes("/v1/reporting/transactions")) {
        if (search === "network") throw new TypeError("fetch failed");
        return j(search.status, search.body);
      }
      return j(404, { name: "NOT_FOUND", message: url });
    };
    const upstream: UpstreamClient = { start: async () => [], listTools: async () => [], callTool: async () => ({ content: [] }), close: async () => undefined };
    const gateway: GatewayDeps = { repos, upstream, paypal: o.paypal === false ? null : new PayPalClient({ clientId: "c", clientSecret: "s", fetch: fetchFn, retryDelayMs: 0, maxNetworkRetries: 0 }), bus: bus(), now: () => Date.now() + nowOffset };
    app = buildApp(loadConfig({ LOG_LEVEL: "silent" }), { gateway, admin: { repos, llm: null, adminToken: TOKEN, gateway, sseHeartbeatMs: 1000, webhookId: "webhookId" in o ? o.webhookId : "WH-ID-1", isProduction: o.isProduction ?? false } });
  }
  beforeEach(async () => {
    nowOffset = 0;
    await boot();
  });
  afterEach(async () => {
    await app.close();
  });

  const SIG = {
    "paypal-auth-algo": "SHA256withRSA",
    "paypal-cert-url": "https://api.sandbox.paypal.com/v1/notifications/certs/CERT-1",
    "paypal-transmission-id": "tid-1",
    "paypal-transmission-sig": "sig==",
    "paypal-transmission-time": "2026-11-11T10:00:00Z",
    "content-type": "application/json",
  };
  const webhook = (raw: string, headers: Record<string, string> = SIG) => app.inject({ method: "POST", url: "/webhooks/paypal", headers, payload: raw });
  const verifyCalls = () => paypalCalls.filter((c) => c.url.endsWith("/verify-webhook-signature"));
  const api = (method: "GET" | "POST", url: string, payload?: unknown, headers: Record<string, string> = auth) => app.inject({ method, url, headers, ...(payload !== undefined ? { payload: payload as object } : {}) });

  describe("POST /webhooks/paypal (signature mocked)", () => {
    it("a valid event is verified first with the exact raw bytes, then reconciled", async () => {
      const raw = JSON.stringify(itemEvent({ id: "WH-OK" })).replace('"id":"WH-OK"', '"id":"WH-OK" ');
      const res = await webhook(raw);
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ status: "processed", findings: 0 });
      expect(verifyCalls()).toHaveLength(1);
      expect(verifyCalls()[0]!.body).toContain(`"webhook_event":${raw}}`); // the raw body, byte for byte, never re-serialized
      expect(JSON.parse(verifyCalls()[0]!.body!)).toMatchObject({ webhook_id: "WH-ID-1", transmission_id: "tid-1" });
      expect(repos.ledger.get(ledgerId)?.status).toBe("SUCCESS");
      expect(repos.reconciliation.list()[0]).toMatchObject({ matched: 1, paypal_event_id: "WH-OK" });
    });

    it("an unrecorded payout arrives as a finding", async () => {
      const res = await webhook(JSON.stringify(itemEvent({ id: "WH-OOB", batch: "OOB9", senderItem: "oob_item_9", itemId: "OI9", receiver: NORTHWIND, amount: "5.00" })));
      expect(res.json()).toEqual({ status: "processed", findings: 1 });
      expect(repos.reconciliation.list({ finding_type: "unrecorded_movement" })).toHaveLength(1);
      expect(events.some((e) => e.type === "reconciliation_finding")).toBe(true);
    });

    it("an invalid signature is rejected with 401 and nothing is stored", async () => {
      verifyResult = "FAILURE";
      const res = await webhook(JSON.stringify(itemEvent({ id: "WH-BAD" })));
      expect(res.statusCode).toBe(401);
      expect(res.json().error).toBe("invalid_signature");
      expect(repos.webhookEvents.count()).toBe(0);
      expect(repos.reconciliation.count()).toBe(0);
      expect(repos.ledger.get(ledgerId)?.status).toBe("PENDING");
    });

    it("missing signature headers are rejected without even calling PayPal", async () => {
      const res = await webhook(JSON.stringify(itemEvent()), { "content-type": "application/json" });
      expect(res.statusCode).toBe(401);
      expect(verifyCalls()).toHaveLength(0);
      expect(repos.webhookEvents.count()).toBe(0);
    });

    it("if PayPal's verification endpoint is down, the delivery is refused (503) so PayPal retries; nothing is stored", async () => {
      verifyResult = "ERROR";
      const res = await webhook(JSON.stringify(itemEvent({ id: "WH-503" })));
      expect(res.statusCode).toBe(503);
      expect(repos.webhookEvents.count()).toBe(0);
    });

    it("without PAYPAL_WEBHOOK_ID webhooks are refused (fail closed)", async () => {
      await app.close();
      await boot({ webhookId: undefined });
      const res = await webhook(JSON.stringify(itemEvent()));
      expect(res.statusCode).toBe(503);
      expect(res.json().error).toBe("webhook_not_configured");
      expect(verifyCalls()).toHaveLength(0);
    });

    it("a replayed event answers 200 and does nothing more", async () => {
      const raw = JSON.stringify(itemEvent({ id: "WH-REPLAY" }));
      expect((await webhook(raw)).json().status).toBe("processed");
      const rows = repos.reconciliation.count();
      const again = await webhook(raw);
      expect(again.statusCode).toBe(200);
      expect(again.json().status).toBe("duplicate_event");
      expect(repos.reconciliation.count()).toBe(rows);
    });

    it("bodies that are not JSON cannot be verified (401); a verified body of the wrong shape is a 400; no admin token is needed", async () => {
      expect((await webhook("not json")).statusCode).toBe(401);
      expect((await webhook("")).statusCode).toBe(401);
      expect((await webhook(JSON.stringify({ hello: "world" }))).statusCode).toBe(400);
      expect(repos.webhookEvents.count()).toBe(0);
    });

    it("the raw-body parser is scoped to the webhook route: admin routes still parse JSON normally", async () => {
      expect((await api("POST", "/api/reconciliation/run", { lookback_hours: 1 })).statusCode).toBe(200);
    });
  });

  describe("POST /api/dev/simulate-webhook", () => {
    it("needs the admin token", async () => {
      expect((await api("POST", "/api/dev/simulate-webhook", itemEvent(), {})).statusCode).toBe(401);
      expect((await api("POST", "/api/dev/simulate-webhook", itemEvent(), { authorization: "Bearer nope" })).statusCode).toBe(401);
    });
    it("skips signature verification, reconciles, and generates an id if none is given", async () => {
      const { id: _drop, ...noId } = itemEvent({ batch: "OOB7", senderItem: "oob_item_7", itemId: "OI7" });
      void _drop;
      const res = await api("POST", "/api/dev/simulate-webhook", noId);
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body).toMatchObject({ simulated: true, signature_verified: false, outcome: "processed" });
      expect(body.event_id).toMatch(/^SIM-/);
      expect(body.findings[0].finding_type).toBe("unrecorded_movement");
      expect(verifyCalls()).toHaveLength(0);
      expect(JSON.parse(repos.reconciliation.list()[0]!.detail_json).simulated).toBe(true);
    });
    it("dedupes replays and validates input", async () => {
      const ev = itemEvent({ id: "SIM-1" });
      expect((await api("POST", "/api/dev/simulate-webhook", ev)).json().outcome).toBe("processed");
      expect((await api("POST", "/api/dev/simulate-webhook", ev)).json().outcome).toBe("duplicate_event");
      expect((await api("POST", "/api/dev/simulate-webhook", { event_type: "X" })).statusCode).toBe(400);
      expect((await api("POST", "/api/dev/simulate-webhook", { event_type: "X", resource: "nope" })).statusCode).toBe(400);
    });
    it("does not exist in production", async () => {
      await app.close();
      await boot({ isProduction: true });
      expect((await api("POST", "/api/dev/simulate-webhook", itemEvent())).statusCode).toBe(404);
      // the real receiver and the admin routes are still there
      expect((await webhook(JSON.stringify(itemEvent({ id: "WH-PROD" })))).statusCode).toBe(200);
      expect((await api("GET", "/api/reconciliation")).statusCode).toBe(200);
    });
    it("NODE_ENV=production in the config also removes it", async () => {
      await app.close();
      const gateway = { repos, upstream: { start: async () => [], listTools: async () => [], callTool: async () => ({ content: [] }), close: async () => undefined }, paypal: null, bus: bus() } as GatewayDeps;
      app = buildApp(loadConfig({ LOG_LEVEL: "silent", NODE_ENV: "production" }), { gateway, admin: { repos, llm: null, adminToken: TOKEN, gateway } });
      expect((await api("POST", "/api/dev/simulate-webhook", itemEvent())).statusCode).toBe(404);
    });
  });

  describe("GET /api/reconciliation", () => {
    it("lists findings with parsed detail and counts, with filters", async () => {
      await api("POST", "/api/dev/simulate-webhook", itemEvent({ id: "M1" })); // matched
      await api("POST", "/api/dev/simulate-webhook", itemEvent({ id: "O1", batch: "OOB1", senderItem: "oob_item_a", itemId: "OIa" })); // unrecorded
      await api("POST", "/api/dev/simulate-webhook", itemEvent({ id: "M1b" })); // duplicate
      const all = (await api("GET", "/api/reconciliation")).json();
      expect(all.counts).toMatchObject({ matched: 1, unrecorded_movement: 1, duplicate: 1 });
      expect(all.findings).toHaveLength(3);
      expect(all.findings[0]).toMatchObject({ matched: false, detail: expect.any(Object) });
      expect((await api("GET", "/api/reconciliation?finding_type=unrecorded_movement")).json().findings).toHaveLength(1);
      expect((await api("GET", "/api/reconciliation?matched=true")).json().findings).toHaveLength(1);
      expect((await api("GET", "/api/reconciliation?limit=1")).json().findings).toHaveLength(1);
      expect((await api("GET", "/api/reconciliation?finding_type=bogus")).statusCode).toBe(400);
      expect((await api("GET", "/api/reconciliation", undefined, {})).statusCode).toBe(401);
    });
  });

  describe("POST /api/reconciliation/run", () => {
    it("looks up recorded payouts at PayPal and reconciles them as matched, and a rerun adds nothing", async () => {
      const r1 = (await api("POST", "/api/reconciliation/run", { lookback_hours: 48 })).json();
      expect(r1).toMatchObject({ ledger: { checked: 1, matched: 1, errors: [] }, matched: 1, findings: [] });
      expect(repos.ledger.get(ledgerId)?.status).toBe("SUCCESS");
      expect(JSON.parse(repos.ledger.get(ledgerId)!.paypal_ref_json)).toMatchObject({ transaction_id: "TXN1" });
      const rows = repos.reconciliation.count();
      const r2 = (await api("POST", "/api/reconciliation/run", { lookback_hours: 48 })).json();
      expect(r2).toMatchObject({ matched: 0, findings: [] });
      expect(repos.reconciliation.count()).toBe(rows);
    });

    it("does not call a webhook-reconciled payout a duplicate when a manual run follows", async () => {
      await api("POST", "/api/dev/simulate-webhook", itemEvent({ id: "WH-FIRST" }));
      expect((await api("POST", "/api/reconciliation/run")).json().findings).toEqual([]);
      expect(repos.reconciliation.list({ finding_type: "duplicate" })).toHaveLength(0);
    });

    it("a webhook that arrives after a manual run already reconciled that payout is not a duplicate", async () => {
      expect((await api("POST", "/api/reconciliation/run")).json().matched).toBe(1);
      const rows = repos.reconciliation.count();
      const res = await api("POST", "/api/dev/simulate-webhook", itemEvent({ id: "WH-LATE" }));
      expect(res.json()).toMatchObject({ outcome: "processed", findings: [] });
      expect(repos.reconciliation.list({ finding_type: "duplicate" })).toHaveLength(0);
      expect(repos.reconciliation.count()).toBe(rows); // nothing new recorded for the same fact
      expect(repos.ledger.get(ledgerId)?.status).toBe("SUCCESS");
    });

    it("flags a payout PayPal reports as failed or unclaimed", async () => {
      batchBodies.BATCH1 = batchOf("BATCH1", "SUCCESS", { id: "ITEM1", txn: "TXN1", amount: "120.00", receiver: ACME, senderItem: attemptId, status: "UNCLAIMED" });
      const r = (await api("POST", "/api/reconciliation/run")).json();
      expect(r.findings.map((f: { finding_type: string }) => f.finding_type)).toEqual(["payout_denied_or_unclaimed"]);
      expect(repos.ledger.get(ledgerId)?.status).toBe("UNCLAIMED");
    });

    it("flags an amount that differs from what Purser recorded", async () => {
      batchBodies.BATCH1 = batchOf("BATCH1", "SUCCESS", { id: "ITEM1", txn: "TXN1", amount: "150.00", receiver: ACME, senderItem: attemptId });
      const r = (await api("POST", "/api/reconciliation/run")).json();
      expect(r.findings[0]).toMatchObject({ finding_type: "amount_mismatch" });
    });

    it("one failing batch lookup is reported without failing the run", async () => {
      delete batchBodies.BATCH1;
      const res = await api("POST", "/api/reconciliation/run");
      expect(res.statusCode).toBe(200);
      expect(res.json().ledger.errors[0]).toMatch(/BATCH1: HTTP 404/);
    });

    it("only reconciles payouts recorded since the given time", async () => {
      expect((await api("POST", "/api/reconciliation/run", { since: new Date(Date.now() + 60_000).toISOString() })).json().ledger.checked).toBe(0);
      expect((await api("POST", "/api/reconciliation/run", { since: new Date(Date.now() - 60_000).toISOString() })).json().ledger.checked).toBe(1);
    });

    it("validates its body", async () => {
      expect((await api("POST", "/api/reconciliation/run", { since: "yesterday" })).statusCode).toBe(400);
      expect((await api("POST", "/api/reconciliation/run", { lookback_hours: -1 })).statusCode).toBe(400);
      expect((await api("POST", "/api/reconciliation/run", { nope: 1 })).statusCode).toBe(400);
      expect((await api("POST", "/api/reconciliation/run", undefined, {})).statusCode).toBe(401);
    });

    describe("Transaction Search", () => {
      const txn = (id: string, value: string, code = "T0001") => ({ transaction_info: { transaction_id: id, transaction_event_code: code, transaction_amount: { value, currency_code: "USD" }, transaction_initiation_date: "2026-11-11T09:00:00Z", paypal_reference_id: "REF1" } });

      it("flags outgoing payouts and refunds that no ledger row accounts for; ignores recorded ones, fees and incoming money", async () => {
        search = { status: 200, body: { transaction_details: [txn("TXN1", "-120.00"), txn("TXN-OOB", "-5.00"), txn("TXN-REF", "-9.00", "T1107"), txn("TXN-FEE", "-1.25", "T1503"), txn("TXN-IN", "50.00"), txn("TXN-HOLD", "-2.00", "T0400")], last_refreshed_datetime: new Date().toISOString(), total_pages: 1 } };
        const r = (await api("POST", "/api/reconciliation/run")).json();
        expect(r.transaction_search).toMatchObject({ status: "ok", transactions_seen: 6, outgoing_seen: 3 });
        const ids = r.findings.filter((f: { detail: { source?: string } }) => f.detail.source === "transaction_search").map((f: { detail: { transaction_id: string } }) => f.detail.transaction_id).sort();
        expect(ids).toEqual(["TXN-OOB", "TXN-REF"]); // TXN1 is the recorded $120 payout (its id was learned from the batch lookup)
        expect(r.findings[0]).toMatchObject({ finding_type: "unrecorded_movement" });
        // a rerun does not report them again
        expect((await api("POST", "/api/reconciliation/run")).json().findings).toEqual([]);
      });

      it("degrades gracefully when the sandbox search lags: reports it, still reconciles the ledger", async () => {
        search = { status: 200, body: { transaction_details: [], last_refreshed_datetime: new Date(Date.now() - 7 * 3_600_000).toISOString(), total_pages: 1 } };
        const res = await api("POST", "/api/reconciliation/run");
        expect(res.statusCode).toBe(200);
        const r = res.json();
        expect(r.transaction_search.status).toBe("lagging");
        expect(r.transaction_search.lag_minutes).toBeGreaterThanOrEqual(419);
        expect(r.transaction_search.note).toMatch(/behind.*webhooks and batch lookups still cover it/);
        expect(r.ledger).toMatchObject({ checked: 1, matched: 1 });
      });

      it.each([
        [{ status: 403, body: { name: "NOT_AUTHORIZED", message: "no scope" } }, 403],
        [{ status: 500, body: { name: "INTERNAL_SERVICE_ERROR", message: "x" } }, 500],
        [{ status: 400, body: { name: "INVALID_REQUEST", message: "Data not ready" } }, 400],
      ])("a search error (%#) is reported as unavailable, never a failure", async (s, code) => {
        search = s as typeof search;
        const res = await api("POST", "/api/reconciliation/run");
        expect(res.statusCode).toBe(200);
        const r = res.json();
        expect(r.transaction_search).toMatchObject({ status: "unavailable", error: { status: code } });
        expect(r.transaction_search.note).toMatch(/only ledger and webhook reconciliation ran/);
        expect(r.ledger.matched).toBe(1);
      });

      it("a network failure during search is also graceful", async () => {
        search = "network";
        const r = (await api("POST", "/api/reconciliation/run")).json();
        expect(r.transaction_search.status).toBe("unavailable");
        expect(r.matched).toBe(1);
      });

      it("without PayPal configured the run still works from the ledger and says what was skipped", async () => {
        await app.close();
        await boot({ paypal: false });
        const r = (await api("POST", "/api/reconciliation/run")).json();
        expect(r.transaction_search.status).toBe("skipped");
        expect(r.ledger.errors[0]).toMatch(/PayPal is not configured/);
      });
    });
  });

  describe("findings over SSE", () => {
    it("an unrecorded_movement finding from a simulated webhook arrives on /api/events", async () => {
      await app.listen({ port: 0, host: "127.0.0.1" });
      const addr = app.server.address();
      const base = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
      const ac = new AbortController();
      const res = await fetch(`${base}/api/events`, { headers: auth, signal: ac.signal });
      const reader = res.body!.getReader();
      const dec = new TextDecoder();
      let text = "";
      const reading = (async () => {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) return;
          text += dec.decode(value);
          if (text.includes("event: reconciliation_finding")) return;
        }
      })();
      await new Promise((r) => setTimeout(r, 50));
      const sim = await fetch(`${base}/api/dev/simulate-webhook`, { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify(itemEvent({ id: "WH-SSE", batch: "OOBSSE", senderItem: "oob_item_sse", itemId: "OISSE", receiver: NORTHWIND, amount: "5.00" })) });
      expect(sim.status).toBe(200);
      await Promise.race([reading, new Promise((r) => setTimeout(r, 3000))]);
      ac.abort();
      const m = /event: reconciliation_finding\ndata: (.*)\n\n/.exec(text);
      expect(m).not.toBeNull();
      expect(JSON.parse(m![1]!)).toMatchObject({ finding_type: "unrecorded_movement", detail: { receiver: NORTHWIND, amount: "5.00 USD", payout_batch_id: "OOBSSE" } });
    });
  });
});

describe("runReconciliation without HTTP", () => {
  it("never throws, even when PayPal is null", async () => {
    const r = await runReconciliation({ ...deps(), paypal: null }, {});
    expect(r.transaction_search.status).toBe("skipped");
    expect(r.findings).toEqual([]);
  });
});
