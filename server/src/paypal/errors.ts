/** Typed PayPal errors. Messages never include credentials or tokens. */

export class PayPalError extends Error {
  override name: string = "PayPalError";
  constructor(
    message: string,
    readonly status: number,
    /** PayPal's error "name", e.g. "INSUFFICIENT_FUNDS" or "NOT_AUTHORIZED". */
    readonly code: string | null,
    readonly debugId: string | null,
    readonly details: unknown[],
    /** Raw parsed response body (or text) for the dashboard / logs. Contains no request secrets. */
    readonly body: unknown,
  ) {
    super(message);
  }

  /** Permission or feature not enabled on the app/account. Callers must surface this, not work around it. */
  get isPermissionError(): boolean {
    return this.status === 403 || this.code === "NOT_AUTHORIZED" || this.code === "PERMISSION_DENIED" || this.code === "AUTHORIZATION_ERROR";
  }
  get isInsufficientFunds(): boolean {
    return this.code === "INSUFFICIENT_FUNDS";
  }
}

/** The request never produced an HTTP response (DNS, reset, timeout). Safe to retry with the same request id. */
export class PayPalNetworkError extends Error {
  override name: string = "PayPalNetworkError";
  constructor(
    message: string,
    readonly attempts: number,
    override readonly cause?: unknown,
  ) {
    super(message);
  }
}

/** OAuth token request failed (bad credentials, revoked app). */
export class PayPalAuthError extends PayPalError {
  override name: string = "PayPalAuthError";
}

export function errorFromResponse(status: number, body: unknown, ctor: typeof PayPalError = PayPalError): PayPalError {
  const b = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;
  const code = (typeof b.name === "string" ? b.name : typeof b.error === "string" ? b.error : null) as string | null;
  const msg =
    (typeof b.message === "string" && b.message) ||
    (typeof b.error_description === "string" && b.error_description) ||
    (typeof body === "string" && body.slice(0, 200)) ||
    `HTTP ${status}`;
  const debugId = typeof b.debug_id === "string" ? b.debug_id : null;
  const details = Array.isArray(b.details) ? b.details : [];
  return new ctor(`PayPal ${status}${code ? ` ${code}` : ""}: ${msg}`, status, code, debugId, details, body);
}
