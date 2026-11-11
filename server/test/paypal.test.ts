import { describe, expect, it, vi } from "vitest";
import { PayPalAuthError, PayPalClient, PayPalError, PayPalNetworkError, createPayout, getCapture, getPayoutBatch, npxCommand, payoutIdsForAttempt, verifyWebhookSignature, waitForPayoutBatch, type FetchLike } from "../src/paypal/index.js";

type ErrLike = PayPalError & { attempts: number };
const unexpected = (): never => {
  throw new Error("expected the promise to reject");
};

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | undefined;
}

/** Scripted fetch. Each handler is consumed in order; the last one repeats. */
function mockFetch(handlers: ((c: Call) => Response | Promise<Response>)[]) {
  const calls: Call[] = [];
  let i = 0;
  const fn: FetchLike = async (url, init) => {
    const c: Call = { url, method: init?.method ?? "GET", headers: (init?.headers ?? {}) as Record<string, string>, body: init?.body as string | undefined };
    calls.push(c);
    const h = handlers[Math.min(i++, handlers.length - 1)]!;
    return h(c);
  };
  return { fn, calls };
}
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const tokenRes = (token = "tok", expires_in = 32400) => json(200, { access_token: token, expires_in, scope: "x", app_id: "APP" });
const isToken = (c: Call) => c.url.endsWith("/v1/oauth2/token");

function client(fetchFn: FetchLike, extra: Partial<ConstructorParameters<typeof PayPalClient>[0]> = {}) {
  return new PayPalClient({ clientId: "cid", clientSecret: "csecret", fetch: fetchFn, retryDelayMs: 0, ...extra });
}

describe("PayPalClient: safety", () => {
  it("refuses the live API host", () => {
    expect(() => client(vi.fn() as never, { baseUrl: "https://api-m.paypal.com" })).toThrow(/sandbox only/i);
    expect(() => client(vi.fn() as never, { baseUrl: "https://api.paypal.com/" })).toThrow(/sandbox only/i);
  });
  it("requires credentials", () => {
    expect(() => new PayPalClient({ clientId: "", clientSecret: "" })).toThrow();
  });
});

describe("OAuth token", () => {
  it("sends client credentials as Basic auth with a form body", async () => {
    const { fn, calls } = mockFetch([() => tokenRes()]);
    await client(fn).getAccessToken();
    const c = calls[0]!;
    expect(c.method).toBe("POST");
    expect(c.url).toBe("https://api-m.sandbox.paypal.com/v1/oauth2/token");
    expect(c.headers.Authorization).toBe(`Basic ${Buffer.from("cid:csecret").toString("base64")}`);
    expect(c.headers["Content-Type"]).toBe("application/x-www-form-urlencoded");
    expect(c.body).toBe("grant_type=client_credentials");
  });

  it("caches the token until shortly before expiry, then refreshes", async () => {
    let now = 1_000_000;
    const { fn, calls } = mockFetch([() => tokenRes("t1", 3600), () => tokenRes("t2", 3600)]);
    const c = client(fn, { now: () => now, refreshSkewMs: 60_000 });
    expect((await c.getAccessToken()).token).toBe("t1");
    now += 3_000_000; // 3000s: still 600s of life
    expect((await c.getAccessToken()).token).toBe("t1");
    expect(calls.length).toBe(1);
    now += 541_000; // 59s left < 60s skew
    expect((await c.getAccessToken()).token).toBe("t2");
    expect(calls.length).toBe(2);
  });

  it("shares one in-flight fetch between concurrent callers", async () => {
    const { fn, calls } = mockFetch([async () => tokenRes()]);
    const c = client(fn);
    const [a, b, d] = await Promise.all([c.getAccessToken(), c.getAccessToken(), c.getAccessToken()]);
    expect(calls.length).toBe(1);
    expect(a).toBe(b);
    expect(b).toBe(d);
  });

  it("maps bad credentials to PayPalAuthError without leaking the secret", async () => {
    const { fn } = mockFetch([() => json(401, { error: "invalid_client", error_description: "Client Authentication failed" })]);
    const err = await client(fn).getAccessToken().then(unexpected, (e) => e as ErrLike);
    expect(err).toBeInstanceOf(PayPalAuthError);
    expect(err.status).toBe(401);
    expect(err.code).toBe("invalid_client");
    expect(String(err.message)).not.toContain("csecret");
  });

  it("rejects a malformed token response", async () => {
    const { fn } = mockFetch([() => json(200, { nope: true })]);
    await expect(client(fn).getAccessToken()).rejects.toBeInstanceOf(PayPalAuthError);
  });
});

describe("request: idempotency and retries", () => {
  it("adds PayPal-Request-Id on POST (given or generated) and never on GET", async () => {
    const { fn, calls } = mockFetch([() => tokenRes(), () => json(201, { ok: 1 }), () => json(201, { ok: 2 }), () => json(200, { ok: 3 })]);
    const c = client(fn);
    await c.request("POST", "/v1/x", { body: { a: 1 }, requestId: "my-key" });
    await c.request("POST", "/v1/x", { body: { a: 1 } });
    await c.request("GET", "/v1/y");
    const [, p1, p2, g] = calls;
    expect(p1!.headers["PayPal-Request-Id"]).toBe("my-key");
    expect(p2!.headers["PayPal-Request-Id"]).toMatch(/^[0-9a-f-]{36}$/);
    expect(g!.headers["PayPal-Request-Id"]).toBeUndefined();
    expect(p1!.headers.Authorization).toBe("Bearer tok");
    expect(p1!.headers["Content-Type"]).toBe("application/json");
    expect(p1!.body).toBe('{"a":1}');
  });

  it("retries network errors with the SAME request id, then succeeds", async () => {
    const { fn, calls } = mockFetch([
      () => tokenRes(),
      () => {
        throw new TypeError("fetch failed");
      },
      () => {
        throw new TypeError("fetch failed");
      },
      () => json(201, { done: true }),
    ]);
    const res = await client(fn).request("POST", "/v1/payments/payouts", { body: {}, requestId: "k1" });
    expect(res).toEqual({ done: true });
    const posts = calls.filter((c) => !isToken(c));
    expect(posts.length).toBe(3);
    expect(new Set(posts.map((p) => p.headers["PayPal-Request-Id"]))).toEqual(new Set(["k1"]));
  });

  it("gives up after maxNetworkRetries with a PayPalNetworkError", async () => {
    const { fn, calls } = mockFetch([
      () => tokenRes(),
      () => {
        throw new TypeError("ECONNRESET");
      },
    ]);
    const err = await client(fn, { maxNetworkRetries: 2 }).request("POST", "/v1/x", { body: {} }).then(unexpected, (e) => e as ErrLike);
    expect(err).toBeInstanceOf(PayPalNetworkError);
    expect(err.attempts).toBe(3);
    expect(calls.filter((c) => !isToken(c)).length).toBe(3);
  });

  it("does NOT retry HTTP errors, including 500", async () => {
    for (const status of [400, 422, 500, 503]) {
      const { fn, calls } = mockFetch([() => tokenRes(), () => json(status, { name: "X", message: "boom" })]);
      await expect(client(fn).request("POST", "/v1/x", { body: {} })).rejects.toBeInstanceOf(PayPalError);
      expect(calls.filter((c) => !isToken(c)).length).toBe(1);
    }
  });

  it("refreshes the token once on 401 and retries once; a second 401 is an error", async () => {
    const ok = mockFetch([() => tokenRes("old"), () => json(401, { name: "AUTHENTICATION_FAILURE", message: "expired" }), () => tokenRes("new"), () => json(200, { fine: true })]);
    expect(await client(ok.fn).request("GET", "/v1/x")).toEqual({ fine: true });
    expect(ok.calls[3]!.headers.Authorization).toBe("Bearer new");

    const bad = mockFetch([() => tokenRes("a"), () => json(401, { name: "AUTHENTICATION_FAILURE", message: "no" }), () => tokenRes("b"), () => json(401, { name: "AUTHENTICATION_FAILURE", message: "no" })]);
    const err = await client(bad.fn).request("GET", "/v1/x").then(unexpected, (e) => e as ErrLike);
    expect(err).toBeInstanceOf(PayPalError);
    expect(err.status).toBe(401);
    expect(bad.calls.length).toBe(4);
  });
});

describe("error mapping", () => {
  const fail = async (status: number, body: unknown) => {
    const { fn } = mockFetch([() => tokenRes(), () => (typeof body === "string" ? new Response(body, { status }) : json(status, body))]);
    return client(fn).request("GET", "/v1/x").then(unexpected, (e) => e as ErrLike);
  };

  it("maps PayPal's error shape", async () => {
    const e = await fail(422, { name: "INSUFFICIENT_FUNDS", message: "Sender does not have sufficient funds", debug_id: "abc123", details: [{ issue: "x" }] });
    expect(e).toBeInstanceOf(PayPalError);
    expect(e.status).toBe(422);
    expect(e.code).toBe("INSUFFICIENT_FUNDS");
    expect(e.debugId).toBe("abc123");
    expect(e.details).toEqual([{ issue: "x" }]);
    expect(e.isInsufficientFunds).toBe(true);
    expect(e.isPermissionError).toBe(false);
    expect(e.message).toContain("INSUFFICIENT_FUNDS");
  });
  it("flags permission errors (403 or NOT_AUTHORIZED)", async () => {
    expect((await fail(403, { name: "NOT_AUTHORIZED", message: "Authorization failed due to insufficient permissions." })).isPermissionError).toBe(true);
    expect((await fail(403, {})).isPermissionError).toBe(true);
    expect((await fail(400, { name: "NOT_AUTHORIZED", message: "x" })).isPermissionError).toBe(true);
  });
  it("handles non-JSON and empty bodies", async () => {
    const html = await fail(502, "<html>Bad Gateway</html>");
    expect(html.status).toBe(502);
    expect(html.message).toContain("Bad Gateway");
    const empty = await fail(500, "");
    expect(empty.message).toContain("HTTP 500");
  });
});

describe("payouts", () => {
  it("builds the Payouts request from minor units with derived ids", async () => {
    const { fn, calls } = mockFetch([() => tokenRes(), () => json(201, { batch_header: { payout_batch_id: "B1", batch_status: "PENDING" } })]);
    const ids = payoutIdsForAttempt("att_123");
    const out = await createPayout(client(fn), { receiverEmail: "acme@personal.example.com", amountMinor: 12000, currency: "usd", note: "Invoice 7", ...ids });
    expect(out.batch_header.payout_batch_id).toBe("B1");
    const c = calls[1]!;
    expect(c.method).toBe("POST");
    expect(c.url).toBe("https://api-m.sandbox.paypal.com/v1/payments/payouts");
    expect(c.headers["PayPal-Request-Id"]).toBe("purser-payout-att_123");
    expect(JSON.parse(c.body!)).toEqual({
      sender_batch_header: { sender_batch_id: "batch_att_123", email_subject: "You have a payment" },
      items: [{ recipient_type: "EMAIL", receiver: "acme@personal.example.com", amount: { value: "120.00", currency: "USD" }, note: "Invoice 7", sender_item_id: "att_123" }],
    });
  });
  it("rejects bad input before any network call", async () => {
    const { fn, calls } = mockFetch([() => tokenRes()]);
    const c = client(fn);
    const base = { receiverEmail: "a@b.co", amountMinor: 100, currency: "USD", senderItemId: "i", idempotencyKey: "k" };
    await expect(createPayout(c, { ...base, receiverEmail: "nope" })).rejects.toThrow(/email/);
    await expect(createPayout(c, { ...base, amountMinor: 0 })).rejects.toThrow(/positive integer/);
    await expect(createPayout(c, { ...base, amountMinor: 10.5 })).rejects.toThrow(/positive integer/);
    await expect(createPayout(c, { ...base, currency: "US" })).rejects.toThrow(/currency/);
    await expect(createPayout(c, { ...base, idempotencyKey: "" })).rejects.toThrow(/required/);
    expect(calls.length).toBe(0);
  });
  it("surfaces a payouts permission error untouched", async () => {
    const { fn } = mockFetch([() => tokenRes(), () => json(403, { name: "AUTHORIZATION_ERROR", message: "Payouts not enabled", debug_id: "d1" })]);
    const err = await createPayout(client(fn), { receiverEmail: "a@b.co", amountMinor: 100, currency: "USD", senderItemId: "i", idempotencyKey: "k" }).then(unexpected, (e) => e as ErrLike);
    expect(err).toBeInstanceOf(PayPalError);
    expect(err.isPermissionError).toBe(true);
    expect(err.debugId).toBe("d1");
  });
  it("getPayoutBatch validates the id", async () => {
    const { fn } = mockFetch([() => tokenRes()]);
    expect(() => getPayoutBatch(client(fn), "../etc")).toThrow(/invalid batch id/);
  });
  it("waitForPayoutBatch polls until a final status", async () => {
    const seq = ["PENDING", "PROCESSING", "SUCCESS"];
    let n = 0;
    const { fn, calls } = mockFetch([() => tokenRes(), () => json(200, { batch_header: { payout_batch_id: "B1", batch_status: seq[n++] } })]);
    const sleep = vi.fn(async () => undefined);
    const out = await waitForPayoutBatch(client(fn), "B1", { intervalMs: 1, sleep });
    expect(out.batch_header.batch_status).toBe("SUCCESS");
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(calls.filter((c) => c.url.includes("/payouts/B1")).length).toBe(3);
  });
  it("waitForPayoutBatch returns the last batch when the timeout passes", async () => {
    const { fn } = mockFetch([() => tokenRes(), () => json(200, { batch_header: { payout_batch_id: "B1", batch_status: "PROCESSING" } })]);
    const out = await waitForPayoutBatch(client(fn), "B1", { timeoutMs: 0, sleep: async () => undefined });
    expect(out.batch_header.batch_status).toBe("PROCESSING");
  });
});

describe("captures", () => {
  it("resolves the captured amount to minor units", async () => {
    const { fn, calls } = mockFetch([() => tokenRes(), () => json(200, { id: "CAP12345", status: "COMPLETED", amount: { value: "30.50", currency_code: "USD" } })]);
    const c = await getCapture(client(fn), "CAP12345");
    expect(calls[1]!.url).toBe("https://api-m.sandbox.paypal.com/v2/payments/captures/CAP12345");
    expect(c).toMatchObject({ id: "CAP12345", status: "COMPLETED", amountMinor: 3050, currency: "USD" });
  });
  it("returns a null amount when PayPal's value is unusable (caller escalates)", async () => {
    const { fn } = mockFetch([() => tokenRes(), () => json(200, { id: "CAP12345", status: "COMPLETED", amount: { value: "abc", currency_code: "USD" } })]);
    expect((await getCapture(client(fn), "CAP12345")).amountMinor).toBeNull();
  });
  it("rejects odd ids and propagates 404s", async () => {
    const { fn } = mockFetch([() => tokenRes(), () => json(404, { name: "RESOURCE_NOT_FOUND", message: "nope" })]);
    const c = client(fn);
    await expect(getCapture(c, "../x")).rejects.toThrow(/invalid capture id/);
    await expect(getCapture(c, "CAP12345")).rejects.toMatchObject({ status: 404, code: "RESOURCE_NOT_FOUND" });
  });
});

describe("verifyWebhookSignature", () => {
  const headers = {
    "paypal-auth-algo": "SHA256withRSA",
    "paypal-cert-url": "https://api.sandbox.paypal.com/v1/notifications/certs/CERT-1",
    "paypal-transmission-id": "tid-1",
    "paypal-transmission-sig": "sig==",
    "paypal-transmission-time": "2026-11-10T10:00:00Z",
  };
  const raw = '{"id":"WH-1","event_type":"PAYMENT.PAYOUTS-ITEM.SUCCEEDED",  "resource":{"a":1.10}}';

  it("posts the raw body byte-for-byte as webhook_event and returns true on SUCCESS", async () => {
    const { fn, calls } = mockFetch([() => tokenRes(), () => json(200, { verification_status: "SUCCESS" })]);
    expect(await verifyWebhookSignature(client(fn), { headers, rawBody: raw, webhookId: "WID" })).toBe(true);
    const c = calls[1]!;
    expect(c.url).toBe("https://api-m.sandbox.paypal.com/v1/notifications/verify-webhook-signature");
    expect(c.body).toContain(`"webhook_event":${raw}}`); // exact bytes preserved (odd spacing, 1.10)
    const parsed = JSON.parse(c.body!);
    expect(parsed).toMatchObject({ auth_algo: "SHA256withRSA", transmission_id: "tid-1", transmission_sig: "sig==", webhook_id: "WID", cert_url: headers["paypal-cert-url"] });
  });
  it("returns false on FAILURE", async () => {
    const { fn } = mockFetch([() => tokenRes(), () => json(200, { verification_status: "FAILURE" })]);
    expect(await verifyWebhookSignature(client(fn), { headers, rawBody: raw, webhookId: "WID" })).toBe(false);
  });
  it("fails closed without calling PayPal when anything is missing or suspicious", async () => {
    const { fn, calls } = mockFetch([() => tokenRes()]);
    const c = client(fn);
    expect(await verifyWebhookSignature(c, { headers, rawBody: raw, webhookId: undefined })).toBe(false);
    expect(await verifyWebhookSignature(c, { headers, rawBody: "", webhookId: "W" })).toBe(false);
    expect(await verifyWebhookSignature(c, { headers, rawBody: "not json", webhookId: "W" })).toBe(false);
    for (const k of Object.keys(headers)) {
      const h: Record<string, string> = { ...headers };
      delete h[k];
      expect(await verifyWebhookSignature(c, { headers: h, rawBody: raw, webhookId: "W" })).toBe(false);
    }
    for (const bad of ["http://api.paypal.com/c", "https://evil.example.com/c", "https://paypal.com.evil.io/c", "not a url"]) {
      expect(await verifyWebhookSignature(c, { headers: { ...headers, "paypal-cert-url": bad }, rawBody: raw, webhookId: "W" })).toBe(false);
    }
    expect(calls.length).toBe(0);
  });
  it("accepts header values that arrive as arrays", async () => {
    const { fn } = mockFetch([() => tokenRes(), () => json(200, { verification_status: "SUCCESS" })]);
    const h = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k, [v]]));
    expect(await verifyWebhookSignature(client(fn), { headers: h, rawBody: raw, webhookId: "W" })).toBe(true);
  });
  it("throws on transport/HTTP errors so callers treat it as not verified", async () => {
    const { fn } = mockFetch([() => tokenRes(), () => json(500, { name: "INTERNAL_SERVICE_ERROR", message: "x" })]);
    await expect(verifyWebhookSignature(client(fn), { headers, rawBody: raw, webhookId: "W" })).rejects.toBeInstanceOf(PayPalError);
  });
});

describe("upstream helpers", () => {
  it("uses npx.cmd on Windows and npx elsewhere", () => {
    expect(npxCommand("win32")).toBe("npx.cmd");
    expect(npxCommand("linux")).toBe("npx");
    expect(npxCommand("darwin")).toBe("npx");
  });
});
