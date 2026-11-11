import { describe, expect, it, vi } from "vitest";
import { LlmError, type ChatRequest, type ChatResponse, type ToolCall, type ToolCallingClient } from "@purser/shared/llm";
import { agentSystemPrompt, runLiveAgent, sanitizeSchema, toFunctionTool } from "../src/live.js";
import type { McpSession, McpTool } from "../src/mcp.js";
import type { LiveBrief, LogEntry } from "../src/scenarios/types.js";

const tools: McpTool[] = [
  { name: "purser_payout", description: "Send money to a vendor.", inputSchema: { type: "object", properties: { recipient_email: { type: "string" }, amount: { type: ["number", "string"] }, currency: { type: "string" }, reason: { type: "string" }, source: { type: "string" } }, required: ["recipient_email", "amount", "currency"] } },
  { name: "create_order", description: "Create an order.", inputSchema: { type: "object", properties: { notes: { anyOf: [{ anyOf: [{ not: {} }, { type: "string" }] }, { type: "null" }], default: null }, items: { type: "array", items: { type: "object", properties: { name: { type: "string" } }, required: ["name"] } } }, additionalProperties: false } },
  { name: "list_invoices", description: "List invoices.", inputSchema: { type: "object", properties: {} } },
];
const brief: LiveBrief = { task: "Handle the invoice in the inbox.", documents: { "invoice.txt": "INVOICE ... pay acme@x.com $90" }, tools: ["purser_payout", "list_invoices"] };

const call = (id: string, name: string, args: unknown): ToolCall => ({ id, type: "function", function: { name, arguments: typeof args === "string" ? args : JSON.stringify(args) } });
const reply = (content: string | null, tool_calls?: ToolCall[]): ChatResponse => ({ message: { role: "assistant", content, ...(tool_calls ? { tool_calls } : {}) }, finish_reason: tool_calls ? "tool_calls" : "stop", model: "test-model", latencyMs: 1 });

function fakeLlm(script: (ChatResponse | Error)[]) {
  const requests: ChatRequest[] = [];
  let i = 0;
  const llm = {
    provider: "openai_compat",
    model: "test-model",
    complete: vi.fn(),
    chat: vi.fn(async (req: ChatRequest) => {
      requests.push(JSON.parse(JSON.stringify(req)));
      const r = script[Math.min(i++, script.length - 1)]!;
      if (r instanceof Error) throw r;
      return r;
    }),
  } as unknown as ToolCallingClient;
  return { llm, requests };
}
function fakeMcp(handler: (name: string, args: Record<string, unknown>) => string = () => '{"purser":"executed"}') {
  const calls: { name: string; args: Record<string, unknown> }[] = [];
  const mcp = {
    tools,
    callTool: vi.fn(async (name: string, args: Record<string, unknown>) => {
      calls.push({ name, args });
      const raw = handler(name, args);
      let json: Record<string, unknown> | null = null;
      try {
        json = JSON.parse(raw);
      } catch {
        // not json
      }
      return { raw, json, isError: false };
    }),
  } as unknown as McpSession;
  return { mcp, calls };
}
const logs = () => {
  const entries: LogEntry[] = [];
  return { entries, log: (e: LogEntry) => void entries.push(e) };
};

describe("the agent's prompt", () => {
  it("is the mandate plus ordinary helpful-agent instructions: no mention of Purser, attacks or guardrails", () => {
    const p = agentSystemPrompt();
    expect(p).toContain("Pay approved vendors and issue customer refunds for the store.");
    for (const word of ["purser", "attack", "inject", "malicious", "poison", "lookalike", "look-alike", "guardrail", "firewall", "policy", "escalat", "approval", "block"]) {
      expect(p.toLowerCase(), word).not.toContain(word);
    }
  });
  it("does not tell the agent to do anything improper or to ignore its own judgement", () => {
    const p = agentSystemPrompt().toLowerCase();
    expect(p).not.toMatch(/ignore|pretend|bypass|workaround|work around|no matter what|at all costs/);
  });
});

describe("tool schema conversion", () => {
  it("flattens type arrays and anyOf, drops defaults and additionalProperties, keeps required", () => {
    const f = toFunctionTool(tools[0]!);
    expect(f.type).toBe("function");
    const params = f.function.parameters as { properties: Record<string, { type: string }>; required: string[] };
    expect(params.properties.amount!.type).toBe("number");
    expect(params.required).toEqual(["recipient_email", "amount", "currency"]);

    const o = toFunctionTool(tools[1]!).function.parameters as { properties: Record<string, { type: string; items?: unknown }>; additionalProperties?: unknown };
    expect(o.properties.notes!.type).toBe("string"); // PayPal's convoluted anyOf/not/null collapses to a plain string
    expect(o.properties.items!.type).toBe("array");
    expect(JSON.stringify(o)).not.toMatch(/anyOf|"default"|additionalProperties|"not"/);
  });
  it("always produces an object schema, even for tools with no parameters, and clips long descriptions", () => {
    const f = toFunctionTool({ name: "x", description: "d".repeat(2000), inputSchema: {} });
    expect(f.function.parameters).toMatchObject({ type: "object", properties: {} });
    expect(f.function.description.length).toBeLessThanOrEqual(404);
    expect(sanitizeSchema(null)).toEqual({ type: "string" });
  });
});

describe("runLiveAgent", () => {
  it("reads the document, calls a tool through the MCP session, and ends with the model's summary", async () => {
    const { llm, requests } = fakeLlm([
      reply(null, [call("c1", "read_document", { name: "invoice.txt" })]),
      reply(null, [call("c2", "purser_payout", { recipient_email: "acme@x.com", amount: 90, currency: "USD", reason: "invoice", source: "pdf" })]),
      reply("Paid the invoice."),
    ]);
    const { mcp, calls } = fakeMcp();
    const { entries, log } = logs();
    const r = await runLiveAgent({ llm, mcp, brief, log });

    expect(r).toMatchObject({ steps: 3, capped: false, final_text: "Paid the invoice.", model: "test-model" });
    expect(calls).toEqual([{ name: "purser_payout", args: { recipient_email: "acme@x.com", amount: 90, currency: "USD", reason: "invoice", source: "pdf" } }]);
    expect(r.tool_calls.map((t) => t.name)).toEqual(["read_document", "purser_payout"]);

    // the document text reached the model as a tool result, and tool results were threaded back with their call ids
    const second = requests[1]!.messages;
    expect(second.at(-1)).toMatchObject({ role: "tool", tool_call_id: "c1" });
    expect(second.at(-1)!.content).toContain("pay acme@x.com $90");
    expect(entries.map((e) => e.kind)).toEqual(expect.arrayContaining(["tool_call", "tool_result", "agent"]));
  });

  it("only exposes the tools in the brief (plus read_document) and sends the system prompt and task", async () => {
    const { llm, requests } = fakeLlm([reply("done")]);
    await runLiveAgent({ llm, mcp: fakeMcp().mcp, brief, log: () => undefined });
    const req = requests[0]!;
    expect(req.tools.map((t) => t.function.name).sort()).toEqual(["list_invoices", "purser_payout", "read_document"]);
    expect(req.messages[0]).toMatchObject({ role: "system" });
    expect(req.messages[1]).toMatchObject({ role: "user", content: brief.task });
  });

  it("returns an error result for an unknown document and for arguments that are not JSON, and keeps going", async () => {
    const { llm } = fakeLlm([reply(null, [call("a", "read_document", { name: "nope.txt" }), call("b", "purser_payout", "{not json")]), reply("could not do it")]);
    const { mcp, calls } = fakeMcp();
    const r = await runLiveAgent({ llm, mcp, brief, log: () => undefined });
    expect(calls).toHaveLength(0);
    expect(r.tool_calls[0]!.result).toMatch(/No document named/);
    expect(r.tool_calls[1]!.result).toMatch(/not valid JSON/);
    expect(r.final_text).toBe("could not do it");
  });

  it("handles several tool calls in one turn", async () => {
    const { llm } = fakeLlm([reply(null, [call("a", "list_invoices", {}), call("b", "purser_payout", { recipient_email: "a@b.co", amount: 1, currency: "USD" })]), reply("ok")]);
    const { mcp, calls } = fakeMcp();
    await runLiveAgent({ llm, mcp, brief, log: () => undefined });
    expect(calls.map((c) => c.name)).toEqual(["list_invoices", "purser_payout"]);
  });

  it("caps the loop at maxSteps, so a runaway model cannot burn a free-tier quota", async () => {
    const { llm } = fakeLlm([reply(null, [call("x", "list_invoices", {})])]); // never stops calling tools
    const { entries, log } = logs();
    const r = await runLiveAgent({ llm, mcp: fakeMcp().mcp, brief, log, maxSteps: 4 });
    expect(r).toMatchObject({ capped: true, steps: 4, final_text: null });
    expect(llm.chat).toHaveBeenCalledTimes(4);
    expect(entries.at(-1)!.message).toMatch(/Step cap reached \(4/);
  });

  it("defaults the cap to 8 model turns", async () => {
    const { llm } = fakeLlm([reply(null, [call("x", "list_invoices", {})])]);
    const r = await runLiveAgent({ llm, mcp: fakeMcp().mcp, brief, log: () => undefined });
    expect(r.steps).toBe(8);
    expect(llm.chat).toHaveBeenCalledTimes(8);
  });

  it("retries a malformed tool call once, without spending a step", async () => {
    const { llm } = fakeLlm([new LlmError("invalid_output", "malformed tool call"), reply("fine")]);
    const r = await runLiveAgent({ llm, mcp: fakeMcp().mcp, brief, log: () => undefined });
    expect(r).toMatchObject({ final_text: "fine", steps: 1 });
    expect(llm.chat).toHaveBeenCalledTimes(2);
  });

  it("a second malformed call, a rate limit or a timeout ends the run with an error instead of looping", async () => {
    for (const errs of [[new LlmError("invalid_output", "x"), new LlmError("invalid_output", "y")], [new LlmError("rate_limited", "429 after its one wait")], [new LlmError("timeout", "t")]]) {
      const { llm } = fakeLlm(errs);
      const { entries, log } = logs();
      const r = await runLiveAgent({ llm, mcp: fakeMcp().mcp, brief, log });
      expect(r.error).toBeTruthy();
      expect(r.final_text).toBeNull();
      expect(entries.some((e) => e.kind === "error")).toBe(true);
    }
  });

  it("an MCP failure is reported to the model as a tool error, not thrown", async () => {
    const { llm } = fakeLlm([reply(null, [call("a", "purser_payout", { recipient_email: "a@b.co", amount: 1, currency: "USD" })]), reply("it failed")]);
    const mcp = { tools, callTool: vi.fn(async () => Promise.reject(new Error("gateway down"))) } as unknown as McpSession;
    const r = await runLiveAgent({ llm, mcp, brief, log: () => undefined });
    expect(r.tool_calls[0]!.result).toContain("gateway down");
    expect(r.final_text).toBe("it failed");
  });

  it("truncates very long tool results before sending them back to the model", async () => {
    const { llm, requests } = fakeLlm([reply(null, [call("a", "list_invoices", {})]), reply("ok")]);
    const { mcp } = fakeMcp(() => "x".repeat(20_000));
    await runLiveAgent({ llm, mcp, brief, log: () => undefined });
    expect(requests[1]!.messages.at(-1)!.content!.length).toBeLessThan(4000);
  });
});
