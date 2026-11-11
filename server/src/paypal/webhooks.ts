import type { PayPalClient } from "./client.js";

export type HeaderBag = Record<string, string | string[] | undefined>;

export interface VerifyWebhookInput {
  headers: HeaderBag;
  /** The exact request body bytes as a string. Never a re-serialized object. */
  rawBody: string;
  webhookId: string | undefined;
}

const header = (h: HeaderBag, name: string): string | null => {
  const v = h[name] ?? h[name.toLowerCase()];
  const s = Array.isArray(v) ? v[0] : v;
  return typeof s === "string" && s.trim() ? s.trim() : null;
};

/**
 * Verify a webhook via PayPal's verify-webhook-signature endpoint.
 * Fails closed: missing headers, missing webhook id, non-PayPal cert host, or anything but SUCCESS returns false.
 * Transport errors throw (callers must treat a throw as "not verified").
 */
export async function verifyWebhookSignature(client: PayPalClient, input: VerifyWebhookInput): Promise<boolean> {
  const { headers, rawBody, webhookId } = input;
  if (!webhookId || !rawBody) return false;

  const authAlgo = header(headers, "paypal-auth-algo");
  const certUrl = header(headers, "paypal-cert-url");
  const transmissionId = header(headers, "paypal-transmission-id");
  const transmissionSig = header(headers, "paypal-transmission-sig");
  const transmissionTime = header(headers, "paypal-transmission-time");
  if (!authAlgo || !certUrl || !transmissionId || !transmissionSig || !transmissionTime) return false;

  // Defense in depth: the signing certificate must be served by PayPal over https.
  try {
    const u = new URL(certUrl);
    if (u.protocol !== "https:" || !/(^|\.)paypal\.com$/i.test(u.hostname)) return false;
  } catch {
    return false;
  }

  // The body must be valid JSON, but we splice the raw bytes in so the event is not re-serialized.
  try {
    JSON.parse(rawBody);
  } catch {
    return false;
  }

  const prefix = JSON.stringify({
    auth_algo: authAlgo,
    cert_url: certUrl,
    transmission_id: transmissionId,
    transmission_sig: transmissionSig,
    transmission_time: transmissionTime,
    webhook_id: webhookId,
  });
  const requestBody = `${prefix.slice(0, -1)},"webhook_event":${rawBody}}`;

  const res = await client.request<{ verification_status?: string }>("POST", "/v1/notifications/verify-webhook-signature", {
    rawJson: requestBody,
  });
  return res?.verification_status === "SUCCESS";
}
