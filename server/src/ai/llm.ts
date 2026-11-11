import type { ZodType } from "zod";
import type { Config } from "../config.js";

/**
 * Provider-agnostic structured-output LLM client. Both the payment reviewer and the policy compiler go through it.
 * Two implementations behind one interface: openai_compat (plain fetch to /chat/completions: Groq, Gemini's
 * OpenAI-compatible endpoint, OpenRouter, ...) and anthropic (plain fetch to /v1/messages).
 * Nothing here ever logs or returns the API key.
 */

export interface LlmRequest {
  system: string;
  user: string;
  schemaName: string;
  /** JSON Schema of the expected output. Used for response_format when supported, and always described in the prompt. */
  jsonSchema: Record<string, unknown>;
  maxTokens?: number;
}

export type StructuredMode = "json_schema" | "json_object" | "prompt_only";

export interface LlmResponse {
  text: string;
  model: string;
  latencyMs: number;
  mode: StructuredMode;
}

export interface LlmClient {
  readonly provider: "anthropic" | "openai_compat";
  readonly model: string;
  complete(req: LlmRequest): Promise<LlmResponse>;
}

export type LlmErrorKind = "rate_limited" | "timeout" | "network" | "auth" | "http" | "invalid_output";

export class LlmError extends Error {
  override name: string = "LlmError";
  constructor(
    readonly kind: LlmErrorKind,
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface LlmConnection {
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutMs: number;
  reasoningEffort: "none" | "low" | "medium" | "high";
}

export interface LlmClientOptions {
  fetch?: FetchLike;
  sleep?: (ms: number) => Promise<void>;
  /** Longest wait for a 429/5xx before giving up (fail closed). Default 15s. */
  maxWaitMs?: number;
}

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Resolve connection settings from env. Returns null (and a reason) when no provider is configured. */
export function resolveLlmConnection(c: Config): { conn: LlmConnection; provider: "anthropic" | "openai_compat" } | { conn: null; reason: string } {
  const provider = c.LLM_PROVIDER ?? (c.ANTHROPIC_API_KEY ? "anthropic" : undefined);
  if (!provider) return { conn: null, reason: "LLM_PROVIDER is not set" };
  if (provider === "anthropic") {
    const apiKey = c.LLM_API_KEY ?? c.ANTHROPIC_API_KEY;
    if (!apiKey) return { conn: null, reason: "LLM_API_KEY (or ANTHROPIC_API_KEY) is not set" };
    return { provider, conn: { baseUrl: c.LLM_BASE_URL ?? "https://api.anthropic.com", apiKey, model: c.LLM_MODEL ?? c.PURSER_MODEL, timeoutMs: c.LLM_TIMEOUT_MS, reasoningEffort: "none" } };
  }
  if (!c.LLM_BASE_URL || !c.LLM_API_KEY || !c.LLM_MODEL) {
    const missing = ["LLM_BASE_URL", "LLM_API_KEY", "LLM_MODEL"].filter((k) => !c[k as keyof Config]);
    return { conn: null, reason: `openai_compat needs ${missing.join(", ")}` };
  }
  return { provider, conn: { baseUrl: c.LLM_BASE_URL, apiKey: c.LLM_API_KEY, model: c.LLM_MODEL, timeoutMs: c.LLM_TIMEOUT_MS, reasoningEffort: c.LLM_REASONING_EFFORT } };
}

export function createLlmClient(config: Config, opts: LlmClientOptions = {}): LlmClient | null {
  const r = resolveLlmConnection(config);
  if (!r.conn) return null;
  return r.provider === "anthropic" ? new AnthropicClient(r.conn, opts) : new OpenAiCompatClient(r.conn, opts);
}

/** Safe-to-log description (no key). */
export function describeLlm(c: Config): string {
  const r = resolveLlmConnection(c);
  return r.conn ? `${r.provider} model=${r.conn.model} base=${r.conn.baseUrl}` : `not configured (${r.reason})`;
}

// ---------- shared transport behaviour ----------

/** Parse "retry-after" (seconds) or a provider message like "try again in 1.5s" / "in 2m3.5s". Returns ms or null. */
export function suggestedWaitMs(headers: Headers, bodyText: string): number | null {
  const h = headers.get("retry-after");
  if (h && /^\d+(\.\d+)?$/.test(h.trim())) return Math.ceil(Number(h) * 1000);
  const m = /try again in\s+(?:(\d+(?:\.\d+)?)h)?\s*(?:(\d+(?:\.\d+)?)m(?!s))?\s*(?:(\d+(?:\.\d+)?)s)?(?:(\d+(?:\.\d+)?)ms)?/i.exec(bodyText);
  if (m && (m[1] || m[2] || m[3] || m[4])) return Math.ceil((Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0)) * 1000 + Number(m[4] ?? 0));
  return null;
}

/**
 * Run a request; on a timeout, network error, 429 or 5xx wait and retry exactly once.
 * If the provider asks for a wait longer than maxWaitMs we do not wait at all (the caller fails closed).
 * Returns the final Response (which may still be a 429/5xx) or throws LlmError for transport failures.
 */
async function withTransientRetry(run: () => Promise<Response>, sleep: (ms: number) => Promise<void>, maxWaitMs: number): Promise<Response> {
  for (let n = 0; n < 2; n++) {
    let res: Response | null = null;
    let err: unknown;
    try {
      res = await run();
    } catch (e) {
      err = e;
    }
    if (res && res.status !== 429 && res.status < 500) return res;
    if (n === 1) {
      if (res) return res;
      throw transportError(err);
    }
    let wait = 1000;
    if (res) {
      const body = await res.clone().text().catch(() => "");
      const suggested = suggestedWaitMs(res.headers, body);
      if (suggested !== null) wait = Math.max(suggested, 500);
      if (wait > maxWaitMs) return res; // too long to wait inside a payment decision
    }
    await sleep(wait);
  }
  /* c8 ignore next */
  throw new LlmError("network", "unreachable");
}

function transportError(e: unknown): LlmError {
  const name = (e as { name?: string })?.name;
  if (name === "TimeoutError" || name === "AbortError") return new LlmError("timeout", "The model request timed out");
  // Node's fetch hides the real reason in `cause` (ECONNRESET, ENOTFOUND, UND_ERR_CONNECT_TIMEOUT...). Codes are safe to show.
  const cause = (e as { cause?: { code?: unknown; message?: unknown } })?.cause;
  const code = typeof cause?.code === "string" ? cause.code : typeof cause?.message === "string" ? cause.message.slice(0, 80) : null;
  return new LlmError("network", `The model request failed: ${(e as Error)?.message ?? "unknown error"}${code ? ` (${code})` : ""}`);
}

function mapBadStatus(res: Response, bodyText: string): LlmError {
  const detail = bodyText.replace(/\s+/g, " ").slice(0, 300);
  if (res.status === 429) return new LlmError("rate_limited", `Model rate limit: ${detail}`, 429);
  if (res.status === 401 || res.status === 403) return new LlmError("auth", `Model request was not authorized (HTTP ${res.status})`, res.status);
  return new LlmError("http", `Model returned HTTP ${res.status}: ${detail}`, res.status);
}

// ---------- openai_compat ----------

export class OpenAiCompatClient implements LlmClient {
  readonly provider = "openai_compat" as const;
  readonly model: string;
  private readonly fetchFn: FetchLike;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly maxWaitMs: number;
  /** Learned at runtime: strongest structured-output mode this endpoint/model accepts. */
  private schemaMode: StructuredMode = "json_schema";
  private reasoning: boolean;

  constructor(private readonly conn: LlmConnection, opts: LlmClientOptions = {}) {
    this.model = conn.model;
    this.fetchFn = opts.fetch ?? ((u, i) => fetch(u, i));
    this.sleep = opts.sleep ?? realSleep;
    this.maxWaitMs = opts.maxWaitMs ?? 15_000;
    this.reasoning = conn.reasoningEffort !== "none";
  }

  /** Which structured-output mode is currently in use (for diagnostics and tests). */
  get mode(): StructuredMode {
    return this.schemaMode;
  }

  async complete(req: LlmRequest): Promise<LlmResponse> {
    const started = performance.now();
    // Each downgrade (reasoning_effort, json_schema -> json_object -> prompt only) re-sends the same request.
    for (let downgrades = 0; downgrades < 4; downgrades++) {
      const mode = this.schemaMode;
      const body: Record<string, unknown> = {
        model: this.conn.model,
        temperature: 0,
        max_tokens: req.maxTokens ?? 800,
        messages: [
          { role: "system", content: mode === "json_schema" ? req.system : `${req.system}\n\n${schemaInstruction(req)}` },
          { role: "user", content: req.user },
        ],
      };
      if (this.reasoning) body.reasoning_effort = this.conn.reasoningEffort;
      if (mode === "json_schema") body.response_format = { type: "json_schema", json_schema: { name: req.schemaName, strict: true, schema: req.jsonSchema } };
      else if (mode === "json_object") body.response_format = { type: "json_object" };

      const res = await withTransientRetry(
        () =>
          this.fetchFn(`${this.conn.baseUrl.replace(/\/+$/, "")}/chat/completions`, {
            method: "POST",
            headers: { Authorization: `Bearer ${this.conn.apiKey}`, "content-type": "application/json" },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(this.conn.timeoutMs),
          }),
        this.sleep,
        this.maxWaitMs,
      );
      const raw = await res.text();

      if (res.status === 400 || res.status === 422) {
        // The model produced output that failed the provider's own schema validation: an output problem, not a capability one.
        if (/json_validate_failed|failed_generation|failed to generate json/i.test(raw)) throw new LlmError("invalid_output", "The model's JSON failed schema validation at the provider", res.status);
        if (this.reasoning && /reasoning/i.test(raw)) {
          this.reasoning = false;
          continue;
        }
        if (mode === "json_schema" && /response_format|json_schema|schema|strict|structured/i.test(raw)) {
          this.schemaMode = "json_object";
          continue;
        }
        if (mode === "json_object" && /response_format|json_object|json mode/i.test(raw)) {
          this.schemaMode = "prompt_only";
          continue;
        }
      }
      if (!res.ok) throw mapBadStatus(res, raw);

      let content: unknown;
      try {
        content = (JSON.parse(raw) as { choices?: { message?: { content?: unknown } }[] }).choices?.[0]?.message?.content;
      } catch {
        throw new LlmError("invalid_output", "The model endpoint returned a non-JSON response");
      }
      if (typeof content !== "string" || !content.trim()) throw new LlmError("invalid_output", "The model returned no content");
      return { text: content, model: this.conn.model, latencyMs: Math.round(performance.now() - started), mode };
    }
    throw new LlmError("http", "The model endpoint rejected every structured-output option");
  }
}

function schemaInstruction(req: LlmRequest): string {
  return `Respond with ONLY a single JSON object, no prose and no markdown fences, that conforms to this JSON Schema:\n${JSON.stringify(req.jsonSchema)}`;
}

// ---------- anthropic ----------

export class AnthropicClient implements LlmClient {
  readonly provider = "anthropic" as const;
  readonly model: string;
  private readonly fetchFn: FetchLike;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly maxWaitMs: number;

  constructor(private readonly conn: LlmConnection, opts: LlmClientOptions = {}) {
    this.model = conn.model;
    this.fetchFn = opts.fetch ?? ((u, i) => fetch(u, i));
    this.sleep = opts.sleep ?? realSleep;
    this.maxWaitMs = opts.maxWaitMs ?? 15_000;
  }

  async complete(req: LlmRequest): Promise<LlmResponse> {
    const started = performance.now();
    const body = {
      model: this.conn.model,
      max_tokens: req.maxTokens ?? 800,
      temperature: 0,
      system: `${req.system}\n\n${schemaInstruction(req)}`,
      messages: [{ role: "user", content: req.user }],
    };
    const res = await withTransientRetry(
      () =>
        this.fetchFn(`${this.conn.baseUrl.replace(/\/+$/, "")}/v1/messages`, {
          method: "POST",
          headers: { "x-api-key": this.conn.apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(this.conn.timeoutMs),
        }),
      this.sleep,
      this.maxWaitMs,
    );
    const raw = await res.text();
    if (!res.ok) {
      // A wrong model string is the common failure here; say so clearly (the key is never included).
      if (res.status === 404 || (res.status === 400 && /model/i.test(raw))) {
        throw new LlmError("http", `Anthropic rejected the model "${this.conn.model}". Set LLM_MODEL (or PURSER_MODEL) to a valid model id.`, res.status);
      }
      throw mapBadStatus(res, raw);
    }
    let text: unknown;
    try {
      text = (JSON.parse(raw) as { content?: { type: string; text?: string }[] }).content?.find((c) => c.type === "text")?.text;
    } catch {
      throw new LlmError("invalid_output", "Anthropic returned a non-JSON response");
    }
    if (typeof text !== "string" || !text.trim()) throw new LlmError("invalid_output", "The model returned no content");
    return { text, model: this.conn.model, latencyMs: Math.round(performance.now() - started), mode: "prompt_only" };
  }
}

// ---------- structured output with validation ----------

/** Pull a JSON value out of model text: plain JSON, fenced JSON, or the first {...} block. */
export function extractJson(text: string): unknown {
  let s = text.trim();
  const fence = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(s);
  if (fence?.[1]) s = fence[1].trim();
  try {
    return JSON.parse(s);
  } catch {
    const a = s.indexOf("{");
    const b = s.lastIndexOf("}");
    if (a >= 0 && b > a) return JSON.parse(s.slice(a, b + 1));
    throw new Error("no JSON object found");
  }
}

/**
 * Call the model and validate with zod. On unparseable or invalid output, retry once with a corrective hint;
 * after that throw LlmError("invalid_output") so callers fail closed. Transport errors are not retried here
 * (the client already waited and retried once).
 */
export async function completeJson<T>(llm: LlmClient, req: LlmRequest, schema: ZodType<T>): Promise<{ value: T; response: LlmResponse; attempts: number }> {
  let hint = "";
  for (let attempt = 1; attempt <= 2; attempt++) {
    let response: LlmResponse | undefined;
    try {
      response = await llm.complete(attempt === 1 ? req : { ...req, user: `${req.user}\n\n${hint}` });
    } catch (e) {
      if (e instanceof LlmError && e.kind === "invalid_output" && attempt === 1) {
        hint = "Your previous reply was not valid. Reply with ONLY the JSON object that matches the schema.";
        continue;
      }
      throw e;
    }
    try {
      const parsed = schema.safeParse(extractJson(response.text));
      if (parsed.success) return { value: parsed.data, response, attempts: attempt };
      hint = `Your previous reply did not match the schema (${parsed.error.issues.slice(0, 4).map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ")}). Reply with ONLY the corrected JSON object.`;
    } catch {
      hint = "Your previous reply was not parseable JSON. Reply with ONLY the JSON object that matches the schema.";
    }
  }
  throw new LlmError("invalid_output", "The model did not return valid JSON for the required schema after one retry");
}
