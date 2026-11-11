import { randomUUID } from "node:crypto";
import { PayPalAuthError, PayPalNetworkError, errorFromResponse } from "./errors.js";

export const SANDBOX_BASE_URL = "https://api-m.sandbox.paypal.com";

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface PayPalClientOptions {
  clientId: string;
  clientSecret: string;
  /** Sandbox only. Defaults to https://api-m.sandbox.paypal.com. */
  baseUrl?: string;
  fetch?: FetchLike;
  /** Injected clock for tests. */
  now?: () => number;
  /** Refresh the token this long before it expires. Default 60s. */
  refreshSkewMs?: number;
  /** Extra attempts after a network error (no HTTP response). Default 2. */
  maxNetworkRetries?: number;
  /** Delay between network retries. Default 300ms. */
  retryDelayMs?: number;
  timeoutMs?: number;
}

export interface RequestOptions {
  body?: unknown;
  /** Pre-serialized JSON sent byte-for-byte (used for webhook verification). Takes precedence over body. */
  rawJson?: string;
  query?: Record<string, string | number | undefined>;
  /** PayPal-Request-Id for POSTs. A fresh UUID is used if omitted. Reused across network retries. */
  requestId?: string;
  headers?: Record<string, string>;
}

export interface AccessToken {
  token: string;
  expiresAtMs: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class PayPalClient {
  private readonly opts: Required<Omit<PayPalClientOptions, "fetch" | "now">> & { fetch: FetchLike; now: () => number };
  private cached: AccessToken | null = null;
  private inflight: Promise<AccessToken> | null = null;

  constructor(o: PayPalClientOptions) {
    if (!o.clientId || !o.clientSecret) throw new Error("PayPal client id and secret are required");
    const baseUrl = (o.baseUrl ?? SANDBOX_BASE_URL).replace(/\/+$/, "");
    // Sandbox only: refuse the live API host outright.
    if (/^https:\/\/api(-m)?\.paypal\.com$/i.test(baseUrl)) throw new Error("Refusing to use the live PayPal API; Purser is sandbox only");
    this.opts = {
      clientId: o.clientId,
      clientSecret: o.clientSecret,
      baseUrl,
      fetch: o.fetch ?? ((u, i) => fetch(u, i)),
      now: o.now ?? Date.now,
      refreshSkewMs: o.refreshSkewMs ?? 60_000,
      maxNetworkRetries: o.maxNetworkRetries ?? 2,
      retryDelayMs: o.retryDelayMs ?? 300,
      timeoutMs: o.timeoutMs ?? 30_000,
    };
  }

  get baseUrl(): string {
    return this.opts.baseUrl;
  }

  /** Cached client-credentials token; refreshed shortly before expiry. Concurrent callers share one fetch. */
  async getAccessToken(forceRefresh = false): Promise<AccessToken> {
    const { now, refreshSkewMs } = this.opts;
    if (!forceRefresh && this.cached && this.cached.expiresAtMs - refreshSkewMs > now()) return this.cached;
    if (this.inflight) return this.inflight;
    this.inflight = this.fetchToken().finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  private async fetchToken(): Promise<AccessToken> {
    const basic = Buffer.from(`${this.opts.clientId}:${this.opts.clientSecret}`).toString("base64");
    const res = await this.send("POST", "/v1/oauth2/token", {
      headers: { Authorization: `Basic ${basic}`, "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      rawBody: "grant_type=client_credentials",
    });
    const body = await readBody(res);
    if (!res.ok) throw errorFromResponse(res.status, body, PayPalAuthError);
    const b = body as { access_token?: unknown; expires_in?: unknown };
    if (typeof b?.access_token !== "string" || typeof b?.expires_in !== "number") {
      throw new PayPalAuthError("PayPal token response was malformed", res.status, null, null, [], null);
    }
    this.cached = { token: b.access_token, expiresAtMs: this.opts.now() + b.expires_in * 1000 };
    return this.cached;
  }

  /**
   * Authenticated JSON request. POSTs always carry PayPal-Request-Id. Network errors (no response) are retried
   * with the same id; HTTP errors are never retried, except one token refresh after a 401 (nothing was executed).
   */
  async request<T = unknown>(method: "GET" | "POST" | "PATCH" | "DELETE", path: string, o: RequestOptions = {}): Promise<T> {
    const requestId = method === "POST" ? (o.requestId ?? randomUUID()) : o.requestId;
    let token = await this.getAccessToken();
    for (let pass = 0; pass < 2; pass++) {
      const headers: Record<string, string> = {
        Authorization: `Bearer ${token.token}`,
        Accept: "application/json",
        ...(o.body !== undefined || o.rawJson !== undefined ? { "Content-Type": "application/json" } : {}),
        ...(requestId ? { "PayPal-Request-Id": requestId } : {}),
        ...o.headers,
      };
      const res = await this.send(method, path, { headers, rawBody: o.rawJson ?? (o.body === undefined ? undefined : JSON.stringify(o.body)), query: o.query });
      const body = await readBody(res);
      if (res.status === 401 && pass === 0) {
        token = await this.getAccessToken(true);
        continue;
      }
      if (!res.ok) throw errorFromResponse(res.status, body);
      return body as T;
    }
    /* c8 ignore next */
    throw new Error("unreachable");
  }

  private async send(
    method: string,
    path: string,
    o: { headers: Record<string, string>; rawBody?: string; query?: Record<string, string | number | undefined> },
  ): Promise<Response> {
    const url = new URL(this.opts.baseUrl + path);
    for (const [k, v] of Object.entries(o.query ?? {})) if (v !== undefined) url.searchParams.set(k, String(v));
    let lastErr: unknown;
    const attempts = this.opts.maxNetworkRetries + 1;
    for (let i = 0; i < attempts; i++) {
      try {
        return await this.opts.fetch(url.toString(), {
          method,
          headers: o.headers,
          body: o.rawBody,
          signal: AbortSignal.timeout(this.opts.timeoutMs),
        });
      } catch (err) {
        lastErr = err;
        if (i < attempts - 1) await sleep(this.opts.retryDelayMs);
      }
    }
    throw new PayPalNetworkError(`No response from PayPal after ${attempts} attempt(s): ${(lastErr as Error)?.message ?? "unknown"}`, attempts, lastErr);
  }
}

async function readBody(res: Response): Promise<unknown> {
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
