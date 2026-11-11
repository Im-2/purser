/** Admin API client. The token lives in sessionStorage only (cleared when the tab closes) and is never logged. */

const KEY = "purser_admin_token";

export const getToken = (): string | null => {
  try {
    return sessionStorage.getItem(KEY);
  } catch {
    return null;
  }
};
export const setToken = (t: string): void => {
  try {
    sessionStorage.setItem(KEY, t);
  } catch {
    // storage blocked: the session just will not survive a reload
  }
};
export const clearToken = (): void => {
  try {
    sessionStorage.removeItem(KEY);
  } catch {
    // ignore
  }
};

export class ApiError extends Error {
  override name = "ApiError";
  constructor(
    message: string,
    readonly status: number,
    readonly code: string | null,
    readonly body: unknown,
  ) {
    super(message);
  }
}

export const UNAUTHORIZED_EVENT = "purser:unauthorized";

export async function api<T = unknown>(method: "GET" | "POST", path: string, body?: unknown, tokenOverride?: string): Promise<T> {
  const token = tokenOverride ?? getToken();
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  } catch {
    throw new ApiError("Could not reach the Purser server. Is it running?", 0, "network", null);
  }
  const text = await res.text();
  let json: unknown;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = text;
  }
  if (!res.ok) {
    const b = (json && typeof json === "object" ? json : {}) as { error?: string; message?: string };
    if (res.status === 401 && !tokenOverride) window.dispatchEvent(new Event(UNAUTHORIZED_EVENT));
    throw new ApiError(b.message ?? b.error ?? `HTTP ${res.status}`, res.status, b.error ?? null, json);
  }
  return json as T;
}

export const get = <T,>(path: string) => api<T>("GET", path);
export const post = <T,>(path: string, body?: unknown) => api<T>("POST", path, body ?? {});
