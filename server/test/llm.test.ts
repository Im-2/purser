import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { loadConfig } from "../src/config.js";
import { AnthropicClient, LlmError, OpenAiCompatClient, completeJson, createLlmClient, describeLlm, extractJson, resolveLlmConnection, suggestedWaitMs, type FetchLike, type LlmConnection, type LlmRequest } from "../src/ai/llm.js";

const KEY = "gsk_SECRET_KEY_VALUE_123456";
const conn = (over: Partial<LlmConnection> = {}): LlmConnection => ({ baseUrl: "https://api.groq.com/openai/v1", apiKey: KEY, model: "openai/gpt-oss-120b", timeoutMs: 5000, reasoningEffort: "low", ...over });
const req: LlmRequest = { system: "SYS", user: "USER", schemaName: "verdict", jsonSchema: { type: "object", properties: { a: { type: "string" } }, required: ["a"], additionalProperties: false }, maxTokens: 300 };

interface Seen {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}
type Reply = Response | Error | ((s: Seen) => Response);
function scripted(replies: Reply[]) {
  const seen: Seen[] = [];
  let i = 0;
  const fn: FetchLike = async (url, init) => {
    const s: Seen = { url, headers: init?.headers as Record<string, string>, body: JSON.parse(init?.body as string) };
    seen.push(s);
    const r = replies[Math.min(i++, replies.length - 1)]!;
    if (r instanceof Error) throw r;
    return typeof r === "function" ? r(s) : r.clone();
  };
  return { fn, seen };
}
const ok = (content: string) => new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 });
const status = (code: number, body: unknown = {}, headers: Record<string, string> = {}) => new Response(typeof body === "string" ? body : JSON.stringify(body), { status: code, headers });
const timeoutErr = () => Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });
const sleeps = () => {
  const calls: number[] = [];
  return { calls, sleep: async (ms: number) => void calls.push(ms) };
};

describe("openai_compat request shape", () => {
  it("posts to /chat/completions with bearer auth, json_schema, low reasoning effort and temperature 0", async () => {
    const { fn, seen } = scripted([ok('{"a":"x"}')]);
    const c = new OpenAiCompatClient(conn(), { fetch: fn });
    const r = await c.complete(req);
    expect(r).toMatchObject({ text: '{"a":"x"}', model: "openai/gpt-oss-120b", mode: "json_schema" });
    const s = seen[0]!;
    expect(s.url).toBe("https://api.groq.com/openai/v1/chat/completions");
    expect(s.headers.Authorization).toBe(`Bearer ${KEY}`);
    expect(s.body).toMatchObject({ model: "openai/gpt-oss-120b", temperature: 0, max_tokens: 300, reasoning_effort: "low" });
    expect(s.body.response_format).toEqual({ type: "json_schema", json_schema: { name: "verdict", strict: true, schema: req.jsonSchema } });
    const msgs = s.body.messages as { role: string; content: string }[];
    expect(msgs.map((m) => m.role)).toEqual(["system", "user"]);
    expect(msgs[0]!.content).toBe("SYS"); // schema is enforced by response_format, not repeated in the prompt
  });
  it("omits reasoning_effort when set to none and tolerates a trailing slash in the base URL", async () => {
    const { fn, seen } = scripted([ok("{}")]);
    await new OpenAiCompatClient(conn({ reasoningEffort: "none", baseUrl: "https://x.test/v1/" }), { fetch: fn }).complete(req);
    expect(seen[0]!.body).not.toHaveProperty("reasoning_effort");
    expect(seen[0]!.url).toBe("https://x.test/v1/chat/completions");
  });
});

describe("openai_compat capability fallback", () => {
  it("falls back from json_schema to json_object and remembers it", async () => {
    const { fn, seen } = scripted([status(400, { error: { message: "response_format of type json_schema is not supported with this model" } }), ok('{"a":"x"}'), ok('{"a":"y"}')]);
    const c = new OpenAiCompatClient(conn(), { fetch: fn });
    const r1 = await c.complete(req);
    expect(r1.mode).toBe("json_object");
    expect(seen).toHaveLength(2);
    expect(seen[1]!.body.response_format).toEqual({ type: "json_object" });
    expect((seen[1]!.body.messages as { content: string }[])[0]!.content).toContain("conforms to this JSON Schema"); // schema moves into the prompt
    await c.complete(req);
    expect(seen).toHaveLength(3); // learned: no new probing
    expect(seen[2]!.body.response_format).toEqual({ type: "json_object" });
    expect(c.mode).toBe("json_object");
  });
  it("falls back again to prompt-only when json_object is unsupported too", async () => {
    const { fn, seen } = scripted([status(400, "response_format json_schema unsupported"), status(400, "response_format json_object unsupported"), ok('{"a":"x"}')]);
    const c = new OpenAiCompatClient(conn(), { fetch: fn });
    expect((await c.complete(req)).mode).toBe("prompt_only");
    expect(seen[2]!.body).not.toHaveProperty("response_format");
  });
  it("drops reasoning_effort when the endpoint rejects it, then keeps json_schema", async () => {
    const { fn, seen } = scripted([status(400, { error: { message: "unknown parameter: reasoning_effort" } }), ok('{"a":"x"}')]);
    const r = await new OpenAiCompatClient(conn(), { fetch: fn }).complete(req);
    expect(r.mode).toBe("json_schema");
    expect(seen[0]!.body).toHaveProperty("reasoning_effort");
    expect(seen[1]!.body).not.toHaveProperty("reasoning_effort");
    expect(seen[1]!.body).toHaveProperty("response_format");
  });
  it("treats a provider-side schema validation failure as bad model output, not a missing capability", async () => {
    const { fn, seen } = scripted([status(400, { error: { code: "json_validate_failed", message: "Generated JSON does not match the expected schema" } })]);
    const err = await new OpenAiCompatClient(conn(), { fetch: fn }).complete(req).catch((e) => e);
    expect(err).toBeInstanceOf(LlmError);
    expect(err.kind).toBe("invalid_output");
    expect(seen).toHaveLength(1);
  });
  it("gives up with an http error if every option is rejected, and unrelated 400s are not downgrades", async () => {
    const { fn } = scripted([status(400, { error: { message: "context length exceeded" } })]);
    const err = await new OpenAiCompatClient(conn(), { fetch: fn }).complete(req).catch((e) => e);
    expect(err.kind).toBe("http");
    expect(err.status).toBe(400);
  });
});

describe("rate limits, timeouts and errors", () => {
  it("on 429 waits as told (retry-after) and retries once", async () => {
    const { fn, seen } = scripted([status(429, { error: { message: "rate limit" } }, { "retry-after": "2" }), ok('{"a":"x"}')]);
    const s = sleeps();
    const r = await new OpenAiCompatClient(conn(), { fetch: fn, sleep: s.sleep }).complete(req);
    expect(r.text).toBe('{"a":"x"}');
    expect(seen).toHaveLength(2);
    expect(s.calls).toEqual([2000]);
  });
  it("parses Groq's 'try again in' message when there is no header", async () => {
    const { fn } = scripted([status(429, { error: { message: "Rate limit reached. Please try again in 1.5s." } }), ok("{}")]);
    const s = sleeps();
    await new OpenAiCompatClient(conn(), { fetch: fn, sleep: s.sleep }).complete(req);
    expect(s.calls).toEqual([1500]);
  });
  it("fails with rate_limited after one retry (never loops)", async () => {
    const { fn, seen } = scripted([status(429, "slow down", { "retry-after": "1" })]);
    const s = sleeps();
    const err = await new OpenAiCompatClient(conn(), { fetch: fn, sleep: s.sleep }).complete(req).catch((e) => e);
    expect(err).toBeInstanceOf(LlmError);
    expect(err.kind).toBe("rate_limited");
    expect(seen).toHaveLength(2);
    expect(s.calls).toHaveLength(1);
  });
  it("does not wait when the provider asks for a long wait (fails closed immediately)", async () => {
    const { fn, seen } = scripted([status(429, { error: { message: "Daily limit. Please try again in 12m30s." } })]);
    const s = sleeps();
    const err = await new OpenAiCompatClient(conn(), { fetch: fn, sleep: s.sleep, maxWaitMs: 15000 }).complete(req).catch((e) => e);
    expect(err.kind).toBe("rate_limited");
    expect(seen).toHaveLength(1);
    expect(s.calls).toEqual([]);
  });
  it("retries once after a timeout, then reports timeout", async () => {
    const a = scripted([timeoutErr(), ok('{"a":"x"}')]);
    const s1 = sleeps();
    expect((await new OpenAiCompatClient(conn(), { fetch: a.fn, sleep: s1.sleep }).complete(req)).text).toBe('{"a":"x"}');
    expect(s1.calls).toEqual([1000]);

    const b = scripted([timeoutErr()]);
    const err = await new OpenAiCompatClient(conn(), { fetch: b.fn, sleep: sleeps().sleep }).complete(req).catch((e) => e);
    expect(err.kind).toBe("timeout");
    expect(b.seen).toHaveLength(2);
  });
  it("retries once after a network error and a 5xx", async () => {
    const a = scripted([new TypeError("fetch failed"), ok("{}")]);
    await expect(new OpenAiCompatClient(conn(), { fetch: a.fn, sleep: sleeps().sleep }).complete(req)).resolves.toBeTruthy();
    const b = scripted([status(503, "unavailable"), status(503, "unavailable")]);
    const err = await new OpenAiCompatClient(conn(), { fetch: b.fn, sleep: sleeps().sleep }).complete(req).catch((e) => e);
    expect(err.kind).toBe("http");
    expect(err.status).toBe(503);
    expect(b.seen).toHaveLength(2);
  });
  it("401 and 403 are auth errors and are not retried", async () => {
    const { fn, seen } = scripted([status(401, { error: { message: "Invalid API Key" } })]);
    const err = await new OpenAiCompatClient(conn(), { fetch: fn }).complete(req).catch((e) => e);
    expect(err.kind).toBe("auth");
    expect(seen).toHaveLength(1);
  });
  it("empty or malformed responses are invalid_output", async () => {
    for (const r of [ok(""), status(200, "not json"), status(200, { choices: [] })]) {
      const err = await new OpenAiCompatClient(conn(), { fetch: scripted([r]).fn }).complete(req).catch((e) => e);
      expect(err.kind).toBe("invalid_output");
    }
  });
  it("never puts the API key in an error message", async () => {
    const cases: Reply[] = [status(401, `bad key ${"x"}`), status(500, "boom"), status(429, "limit"), new TypeError("fetch failed")];
    for (const c of cases) {
      const err = await new OpenAiCompatClient(conn(), { fetch: scripted([c]).fn, sleep: sleeps().sleep }).complete(req).catch((e) => e);
      expect(String(err.message)).not.toContain(KEY);
      expect(JSON.stringify(err)).not.toContain(KEY);
    }
  });
});

describe("openai_compat tool calling (chat)", () => {
  const tools = [{ type: "function" as const, function: { name: "purser_payout", description: "pay", parameters: { type: "object", properties: { amount: { type: "number" } } } } }];
  const chatReply = (message: unknown, finish = "tool_calls") => new Response(JSON.stringify({ choices: [{ finish_reason: finish, message }] }), { status: 200 });

  it("sends tools with tool_choice auto, bearer auth and low reasoning effort, and returns the tool calls", async () => {
    const { fn, seen } = scripted([chatReply({ role: "assistant", content: null, tool_calls: [{ id: "fc_1", type: "function", function: { name: "purser_payout", arguments: '{"amount":90}' } }] })]);
    const c = new OpenAiCompatClient(conn(), { fetch: fn });
    const r = await c.chat({ messages: [{ role: "system", content: "s" }, { role: "user", content: "u" }], tools, maxTokens: 300 });
    expect(r.message.tool_calls).toEqual([{ id: "fc_1", type: "function", function: { name: "purser_payout", arguments: '{"amount":90}' } }]);
    expect(r.finish_reason).toBe("tool_calls");
    expect(seen[0]!.url).toBe("https://api.groq.com/openai/v1/chat/completions");
    expect(seen[0]!.headers.Authorization).toBe(`Bearer ${KEY}`);
    expect(seen[0]!.body).toMatchObject({ tool_choice: "auto", temperature: 0, max_tokens: 300, reasoning_effort: "low" });
    expect(seen[0]!.body.tools).toEqual(tools);
    expect(seen[0]!.body).not.toHaveProperty("response_format");
  });
  it("returns plain text when the model makes no tool call, and omits tools entirely when none are given", async () => {
    const { fn, seen } = scripted([chatReply({ role: "assistant", content: "All done." }, "stop")]);
    const r = await new OpenAiCompatClient(conn(), { fetch: fn }).chat({ messages: [{ role: "user", content: "hi" }], tools: [] });
    expect(r.message).toEqual({ role: "assistant", content: "All done." });
    expect(seen[0]!.body).not.toHaveProperty("tools");
  });
  it("normalizes tool calls: missing ids are generated, object arguments are serialized", async () => {
    const { fn } = scripted([chatReply({ role: "assistant", content: null, tool_calls: [{ function: { name: "a", arguments: { x: 1 } } }, { function: { name: 5 } }] })]);
    const r = await new OpenAiCompatClient(conn(), { fetch: fn }).chat({ messages: [], tools });
    expect(r.message.tool_calls).toEqual([{ id: "call_0", type: "function", function: { name: "a", arguments: '{"x":1}' } }]);
  });
  it("threads tool results back (assistant tool_calls plus a tool message) unchanged", async () => {
    const { fn, seen } = scripted([chatReply({ role: "assistant", content: "ok" }, "stop")]);
    const messages = [
      { role: "user" as const, content: "pay" },
      { role: "assistant" as const, content: null, tool_calls: [{ id: "c1", type: "function" as const, function: { name: "purser_payout", arguments: "{}" } }] },
      { role: "tool" as const, tool_call_id: "c1", content: '{"purser":"pending_approval"}' },
    ];
    await new OpenAiCompatClient(conn(), { fetch: fn }).chat({ messages, tools });
    expect(seen[0]!.body.messages).toEqual(messages);
  });
  it("waits once on a 429 and retries; fails with rate_limited after that", async () => {
    const ok = scripted([status(429, "slow", { "retry-after": "2" }), chatReply({ role: "assistant", content: "ok" }, "stop")]);
    const s = sleeps();
    await new OpenAiCompatClient(conn(), { fetch: ok.fn, sleep: s.sleep }).chat({ messages: [], tools });
    expect(s.calls).toEqual([2000]);
    const bad = scripted([status(429, "slow", { "retry-after": "1" })]);
    const err = await new OpenAiCompatClient(conn(), { fetch: bad.fn, sleep: sleeps().sleep }).chat({ messages: [], tools }).catch((e) => e);
    expect(err.kind).toBe("rate_limited");
    expect(bad.seen).toHaveLength(2);
  });
  it("drops reasoning_effort if the endpoint rejects it", async () => {
    const { fn, seen } = scripted([status(400, { error: { message: "unknown parameter reasoning_effort" } }), chatReply({ role: "assistant", content: "ok" }, "stop")]);
    await new OpenAiCompatClient(conn(), { fetch: fn }).chat({ messages: [], tools });
    expect(seen[0]!.body).toHaveProperty("reasoning_effort");
    expect(seen[1]!.body).not.toHaveProperty("reasoning_effort");
  });
  it("a malformed tool call at the provider is invalid_output (so the agent can retry once)", async () => {
    const { fn } = scripted([status(400, { error: { code: "tool_use_failed", message: "Failed to call a function.", failed_generation: "<bad>" } })]);
    const err = await new OpenAiCompatClient(conn(), { fetch: fn }).chat({ messages: [], tools }).catch((e) => e);
    expect(err).toBeInstanceOf(LlmError);
    expect(err.kind).toBe("invalid_output");
  });
  it("timeouts retry once then report timeout; the key never appears in errors", async () => {
    const b = scripted([timeoutErr()]);
    const err = await new OpenAiCompatClient(conn(), { fetch: b.fn, sleep: sleeps().sleep }).chat({ messages: [], tools }).catch((e) => e);
    expect(err.kind).toBe("timeout");
    expect(JSON.stringify(err)).not.toContain(KEY);
  });
  it("supportsToolCalling is true for openai_compat and false for anthropic and null", async () => {
    const { supportsToolCalling } = await import("../src/ai/llm.js");
    expect(supportsToolCalling(new OpenAiCompatClient(conn(), { fetch: scripted([]).fn }))).toBe(true);
    expect(supportsToolCalling(new AnthropicClient(conn({ reasoningEffort: "none" }), { fetch: scripted([]).fn }))).toBe(false);
    expect(supportsToolCalling(null)).toBe(false);
  });
});

describe("anthropic client (same interface)", () => {
  const anth = (over: Partial<LlmConnection> = {}) => conn({ baseUrl: "https://api.anthropic.com", model: "claude-sonnet-5-5", reasoningEffort: "none", ...over });
  it("posts to /v1/messages with x-api-key and parses text content", async () => {
    const { fn, seen } = scripted([new Response(JSON.stringify({ content: [{ type: "text", text: '{"a":"x"}' }] }), { status: 200 })]);
    const r = await new AnthropicClient(anth(), { fetch: fn }).complete(req);
    expect(r).toMatchObject({ text: '{"a":"x"}', model: "claude-sonnet-5-5", mode: "prompt_only" });
    expect(seen[0]!.url).toBe("https://api.anthropic.com/v1/messages");
    expect(seen[0]!.headers["x-api-key"]).toBe(KEY);
    expect(seen[0]!.headers["anthropic-version"]).toBe("2023-06-01");
    expect(seen[0]!.body).toMatchObject({ model: "claude-sonnet-5-5", max_tokens: 300, temperature: 0 });
    expect(String(seen[0]!.body.system)).toContain("JSON Schema");
  });
  it("gives a clear message for a wrong model string, without the key", async () => {
    const { fn } = scripted([status(404, { error: { type: "not_found_error", message: "model: nope" } })]);
    const err = await new AnthropicClient(anth({ model: "nope" }), { fetch: fn }).complete(req).catch((e) => e);
    expect(err.message).toMatch(/rejected the model "nope"/);
    expect(err.message).not.toContain(KEY);
  });
  it("retries a 429 once", async () => {
    const { fn, seen } = scripted([status(429, "x", { "retry-after": "1" }), new Response(JSON.stringify({ content: [{ type: "text", text: "{}" }] }), { status: 200 })]);
    await new AnthropicClient(anth(), { fetch: fn, sleep: sleeps().sleep }).complete(req);
    expect(seen).toHaveLength(2);
  });
});

describe("config resolution", () => {
  const cfg = (env: Record<string, string>) => loadConfig({ LOG_LEVEL: "silent", ...env });
  it("openai_compat needs base url, key and model", () => {
    const r = resolveLlmConnection(cfg({ LLM_PROVIDER: "openai_compat", LLM_API_KEY: KEY }));
    expect(r.conn).toBeNull();
    expect((r as { reason: string }).reason).toMatch(/LLM_BASE_URL, LLM_MODEL/);
  });
  it("resolves Groq settings and defaults reasoning effort to low", () => {
    const r = resolveLlmConnection(cfg({ LLM_PROVIDER: "openai_compat", LLM_BASE_URL: "https://api.groq.com/openai/v1", LLM_API_KEY: KEY, LLM_MODEL: "openai/gpt-oss-120b" }));
    expect(r.conn).toMatchObject({ baseUrl: "https://api.groq.com/openai/v1", model: "openai/gpt-oss-120b", reasoningEffort: "low", timeoutMs: 20000 });
  });
  it("is unconfigured by default and falls back to legacy ANTHROPIC_API_KEY", () => {
    expect(createLlmClient(cfg({}))).toBeNull();
    const c = createLlmClient(cfg({ ANTHROPIC_API_KEY: "sk-ant-x", PURSER_MODEL: "claude-test" }));
    expect(c?.provider).toBe("anthropic");
    expect(c?.model).toBe("claude-test");
  });
  it("describeLlm never contains the key", () => {
    const d = describeLlm(cfg({ LLM_PROVIDER: "openai_compat", LLM_BASE_URL: "https://x.test/v1", LLM_API_KEY: KEY, LLM_MODEL: "m" }));
    expect(d).toContain("model=m");
    expect(d).not.toContain(KEY);
  });
  it("rejects an unknown provider", () => {
    expect(() => cfg({ LLM_PROVIDER: "carrier_pigeon" })).toThrow(/Invalid environment/);
  });
});

describe("suggestedWaitMs / extractJson", () => {
  it("parses headers and provider messages", () => {
    expect(suggestedWaitMs(new Headers({ "retry-after": "3" }), "")).toBe(3000);
    expect(suggestedWaitMs(new Headers(), "Please try again in 7.66s")).toBe(7660);
    expect(suggestedWaitMs(new Headers(), "try again in 2m3.5s")).toBe(123500);
    expect(suggestedWaitMs(new Headers(), "try again in 350ms")).toBe(350);
    expect(suggestedWaitMs(new Headers(), "no hint")).toBeNull();
  });
  it("extracts JSON from plain, fenced and chatty text", () => {
    expect(extractJson('{"a":1}')).toEqual({ a: 1 });
    expect(extractJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(extractJson('Sure! Here you go: {"a":1} Hope that helps.')).toEqual({ a: 1 });
    expect(() => extractJson("no json here")).toThrow();
  });
});

describe("completeJson (validate, retry once, then fail)", () => {
  const schema = z.object({ a: z.string() });
  const llmReturning = (...texts: string[]) => {
    const prompts: string[] = [];
    let i = 0;
    return {
      prompts,
      llm: { provider: "openai_compat" as const, model: "m", complete: vi.fn(async (r: LlmRequest) => (prompts.push(r.user), { text: texts[Math.min(i++, texts.length - 1)]!, model: "m", latencyMs: 1, mode: "json_schema" as const })) },
    };
  };
  it("returns on the first valid reply", async () => {
    const { llm } = llmReturning('{"a":"x"}');
    const r = await completeJson(llm, req, schema);
    expect(r.value).toEqual({ a: "x" });
    expect(r.attempts).toBe(1);
  });
  it("retries once with a corrective hint after invalid JSON, then succeeds", async () => {
    const { llm, prompts } = llmReturning("I think the answer is yes", '{"a":"x"}');
    const r = await completeJson(llm, req, schema);
    expect(r.attempts).toBe(2);
    expect(prompts[1]).toContain("not parseable JSON");
  });
  it("retries once on a schema mismatch and names the problem field", async () => {
    const { llm, prompts } = llmReturning('{"a":5}', '{"a":"ok"}');
    await completeJson(llm, req, schema);
    expect(prompts[1]).toMatch(/did not match the schema.*a:/);
  });
  it("fails with invalid_output after the single retry", async () => {
    const { llm } = llmReturning("nope", '{"wrong":1}');
    const err = await completeJson(llm, req, schema).catch((e) => e);
    expect(err).toBeInstanceOf(LlmError);
    expect(err.kind).toBe("invalid_output");
    expect(llm.complete).toHaveBeenCalledTimes(2);
  });
  it("does not retry transport errors (the client already did)", async () => {
    const llm = { provider: "openai_compat" as const, model: "m", complete: vi.fn(async () => Promise.reject(new LlmError("rate_limited", "x"))) };
    await expect(completeJson(llm, req, schema)).rejects.toMatchObject({ kind: "rate_limited" });
    expect(llm.complete).toHaveBeenCalledTimes(1);
  });
  it("a provider-side invalid_output on the first attempt gets the one retry", async () => {
    let n = 0;
    const llm = {
      provider: "openai_compat" as const,
      model: "m",
      complete: vi.fn(async () => {
        if (n++ === 0) throw new LlmError("invalid_output", "provider schema failure");
        return { text: '{"a":"x"}', model: "m", latencyMs: 1, mode: "json_schema" as const };
      }),
    };
    expect((await completeJson(llm, req, schema)).value).toEqual({ a: "x" });
  });
});
