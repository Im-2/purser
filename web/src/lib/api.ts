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
const ROLE_KEY = "purser_role";
/** "demo" for a judge's Try-the-demo session, "admin" for the admin token. Only a hint for the UI: the server enforces what each token may do. */
export const getRole = (): "admin" | "demo" => {
  try {
    return sessionStorage.getItem(ROLE_KEY) === "demo" ? "demo" : "admin";
  } catch {
    return "admin";
  }
};
export const setRole = (r: "admin" | "demo"): void => {
  try {
    sessionStorage.setItem(ROLE_KEY, r);
  } catch {
    // ignore
  }
};
export const isDemo = (): boolean => getRole() === "demo";
const NOTICE_KEY = "purser_login_notice";
export const setLoginNotice = (m: string): void => {
  try {
    sessionStorage.setItem(NOTICE_KEY, m);
  } catch {
    // ignore
  }
};
export const takeLoginNotice = (): string | null => {
  try {
    const m = sessionStorage.getItem(NOTICE_KEY);
    sessionStorage.removeItem(NOTICE_KEY);
    return m;
  } catch {
    return null;
  }
};
export const clearToken = (): void => {
  try {
    sessionStorage.removeItem(ROLE_KEY);
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
