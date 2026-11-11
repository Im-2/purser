const BASE = "https://api-m.sandbox.paypal.com";

export interface SandboxCapture {
  orderId: string;
  captureId: string;
  amount: string;
  currency: string;
}

/**
 * Scenario C setup: a real SANDBOX capture for the store to refund. It plays the part of a customer paying the store and is
 * not an agent action, so it goes straight to the Orders API (not through Purser).
 *
 * A sandbox card order completes in one call with no buyer redirect, so no browser approval step is needed. The card number is
 * PayPal's published sandbox test number; no real card data is involved. Sandbox only: the host is hard-coded.
 */
export async function createSandboxCapture(creds: { clientId: string; clientSecret: string }, amount = "10.00", requestId = `purser-scenario-c-${Date.now()}`): Promise<SandboxCapture> {
  const basic = Buffer.from(`${creds.clientId}:${creds.clientSecret}`).toString("base64");
  const tokRes = await fetch(`${BASE}/v1/oauth2/token`, { method: "POST", headers: { Authorization: `Basic ${basic}`, "content-type": "application/x-www-form-urlencoded" }, body: "grant_type=client_credentials", signal: AbortSignal.timeout(30_000) });
  const tok = (await tokRes.json().catch(() => ({}))) as { access_token?: string };
  if (!tokRes.ok || !tok.access_token) throw new Error(`PayPal sandbox token request failed (HTTP ${tokRes.status})`);

  const res = await fetch(`${BASE}/v2/checkout/orders`, {
    method: "POST",
    headers: { Authorization: `Bearer ${tok.access_token}`, "content-type": "application/json", "PayPal-Request-Id": requestId },
    body: JSON.stringify({
      intent: "CAPTURE",
      purchase_units: [{ amount: { currency_code: "USD", value: amount }, description: "Purser demo: order to be refunded" }],
      payment_source: { card: { number: "4111111111111111", expiry: "2030-12", security_code: "123", name: "Sandbox Test Buyer", attributes: { verification: { method: "SCA_WHEN_REQUIRED" } } } },
    }),
    signal: AbortSignal.timeout(60_000),
  });
  const body = (await res.json().catch(() => ({}))) as { id?: string; status?: string; name?: string; message?: string; purchase_units?: { payments?: { captures?: { id?: string; status?: string; amount?: { value?: string; currency_code?: string } }[] } }[] };
  const cap = body.purchase_units?.[0]?.payments?.captures?.[0];
  if (!res.ok || !body.id || !cap?.id || cap.status !== "COMPLETED") {
    throw new Error(`Sandbox capture was not completed (HTTP ${res.status} ${body.name ?? body.status ?? ""} ${String(body.message ?? "").slice(0, 160)})`.trim());
  }
  return { orderId: body.id, captureId: cap.id, amount: cap.amount?.value ?? amount, currency: cap.amount?.currency_code ?? "USD" };
}
