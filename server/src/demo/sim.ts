import { randomUUID } from "node:crypto";
import { PayPalClient, type FetchLike, type UpstreamClient, type UpstreamResult, type UpstreamTool } from "../paypal/index.js";

/**
 * Simulated PayPal for judge demo sessions. It is a `fetch` replacement injected into the normal PayPalClient, so the real
 * client code runs end to end but NO network request is ever made: every call is answered here, and anything this simulator
 * does not know is refused (and recorded), so a new code path that wanted PayPal would fail closed instead of reaching it.
 */
export interface SimPayPal {
  client: PayPalClient;
  /** Every request the gateway made to "PayPal" (method and path only). */
  calls: { method: string; path: string }[];
  /** Requests the simulator refused because it does not model them. Always empty in a healthy demo. */
  unexpected: string[];
}

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

export function createSimPayPal(): SimPayPal {
  const calls: SimPayPal["calls"] = [];
  const unexpected: string[] = [];
  const payouts = new Map<string, { sender_batch_id: string; item: { receiver: string; amount: { value: string; currency: string }; sender_item_id: string; note?: string } }>();

  const fetchImpl: FetchLike = async (url, init) => {
    const u = new URL(url);
    const method = (init?.method ?? "GET").toUpperCase();
    const p = u.pathname;
    calls.push({ method, path: p });

    if (method === "POST" && p === "/v1/oauth2/token") return json(200, { access_token: "sim-token", token_type: "Bearer", expires_in: 32_400, scope: "simulated" });

    if (method === "POST" && p === "/v1/payments/payouts") {
      const body = JSON.parse(String(init?.body ?? "{}")) as { sender_batch_header?: { sender_batch_id?: string }; items?: { receiver: string; amount: { value: string; currency: string }; sender_item_id: string; note?: string }[] };
      const item = body.items?.[0];
      if (!item) return json(400, { name: "INVALID_REQUEST", message: "simulated: no items" });
      const id = `SIM${randomUUID().replace(/-/g, "").slice(0, 11).toUpperCase()}`;
      payouts.set(id, { sender_batch_id: body.sender_batch_header?.sender_batch_id ?? "", item });
      return json(201, { batch_header: { payout_batch_id: id, batch_status: "PENDING", sender_batch_header: body.sender_batch_header ?? {} }, links: [] });
    }

    const batch = /^\/v1\/payments\/payouts\/([A-Za-z0-9]+)$/.exec(p);
    if (method === "GET" && batch) {
      const rec = payouts.get(batch[1]!);
      if (!rec) return json(404, { name: "RESOURCE_NOT_FOUND", message: "simulated: unknown batch" });
      return json(200, {
        batch_header: { payout_batch_id: batch[1], batch_status: "SUCCESS", sender_batch_header: { sender_batch_id: rec.sender_batch_id } },
        items: [{ payout_item_id: `SIMITEM${batch[1]}`, transaction_id: `SIMTX${batch[1]}`, transaction_status: "SUCCESS", sender_batch_id: rec.sender_batch_id, payout_item: rec.item }],
      });
    }

    const cap = /^\/v2\/payments\/captures\/([A-Za-z0-9_-]+)$/.exec(p);
    if (method === "GET" && cap) return json(200, { id: cap[1], status: "COMPLETED", amount: { value: "10.00", currency_code: "USD" } });

    unexpected.push(`${method} ${p}`);
    return json(404, { name: "SIMULATED_NOT_MODELLED", message: `The demo simulator does not model ${method} ${p}` });
  };

  const client = new PayPalClient({ clientId: "sim", clientSecret: "sim", fetch: fetchImpl, maxNetworkRetries: 0 });
  return { client, calls, unexpected };
}

const FALLBACK_TOOLS: UpstreamTool[] = ["create_refund", "get_order", "list_invoices", "get_invoice", "create_invoice", "create_order", "send_invoice"].map((name) => ({ name, description: `${name} (simulated)`, inputSchema: { type: "object", properties: {}, additionalProperties: true } }));

/** The PayPal MCP server stand-in for demo sessions: same tool list as the real one (when known), canned results, no process, no network. */
export function createSimUpstream(tools: () => UpstreamTool[]): UpstreamClient {
  const list = () => {
    const real = tools();
    return real.length ? real : FALLBACK_TOOLS;
  };
  const text = (o: unknown): UpstreamResult => ({ content: [{ type: "text", text: JSON.stringify(o) }] });
  return {
    async start() {
      return list();
    },
    async listTools() {
      return list();
    },
    async callTool(name, args) {
      if (name === "create_refund") {
        const a = (args.amount ?? {}) as { value?: string; currency_code?: string };
        return text({ id: `SIMREFUND${randomUUID().replace(/-/g, "").slice(0, 10).toUpperCase()}`, status: "COMPLETED", amount: { value: a.value ?? "1.00", currency_code: a.currency_code ?? "USD" }, simulated: true });
      }
      if (/^(get|list|show)_/.test(name)) return text({ simulated: true, total_items: 0, items: [] });
      return text({ simulated: true, status: "OK", tool: name });
    },
    async close() {
      // nothing to close
    },
  };
}
