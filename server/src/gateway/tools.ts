import type { ToolClass } from "@purser/shared";
import { cachedUpstreamTools, type UpstreamTool } from "../paypal/index.js";
import { classifyTool } from "../policy/classify.js";
import type { GatewayDeps } from "./pipeline.js";

export interface McpToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/** Classes that move or request money, or message customers. These get the reason/source fields. */
export const ANNOTATED_CLASSES: ReadonlySet<ToolClass> = new Set(["money_in", "outbound_comms", "capture", "money_out"]);

const REASON_SCHEMA = { type: "string", description: "Why you are making this call, in one sentence." };
const SOURCE_SCHEMA = { type: "string", description: 'Where the instruction came from, for example "user chat" or "email from vendor".' };

/** Add optional reason/source to a JSON schema without mutating the original. */
export function withReasonAndSource(schema: unknown): Record<string, unknown> {
  const base = typeof schema === "object" && schema !== null && !Array.isArray(schema) ? (schema as Record<string, unknown>) : {};
  const props = typeof base.properties === "object" && base.properties !== null ? (base.properties as Record<string, unknown>) : {};
  return {
    ...base,
    type: "object",
    properties: { ...props, reason: props.reason ?? REASON_SCHEMA, source: props.source ?? SOURCE_SCHEMA },
  };
}

export const NATIVE_TOOL_DEFS: McpToolDef[] = [
  {
    name: "purser_payout",
    description: "Send money from the store's PayPal account to a vendor by email (PayPal Payouts, sandbox). Subject to spending policy; may require human approval.",
    inputSchema: {
      type: "object",
      properties: {
        recipient_email: { type: "string", description: "PayPal email of the payee." },
        amount: { type: ["number", "string"], description: "Amount, for example 120 or \"120.00\"." },
        currency: { type: "string", description: "Three-letter currency code, for example USD." },
        note: { type: "string", description: "Optional note shown to the recipient." },
      },
      required: ["recipient_email", "amount", "currency"],
    },
  },
  {
    name: "purser_check_approval",
    description: "Check the status of an approval you were asked to wait for.",
    inputSchema: { type: "object", properties: { approval_id: { type: "string" } }, required: ["approval_id"] },
  },
  {
    name: "purser_status",
    description: "Show whether this agent is active or suspended and how many approvals are pending.",
    inputSchema: { type: "object", properties: {} },
  },
];

/**
 * tools/list: cached upstream tools (never a hardcoded list) plus native tools.
 * Unknown upstream tools are hidden unless named in `exposeUnknown`; calling them is still denied.
 */
export async function buildToolList(deps: GatewayDeps): Promise<McpToolDef[]> {
  let upstream: UpstreamTool[] = cachedUpstreamTools(deps.repos);
  if (upstream.length === 0) {
    try {
      upstream = await deps.upstream.listTools();
    } catch {
      upstream = []; // upstream down: still serve native tools; proxied calls will fail closed
    }
  }
  const out: McpToolDef[] = [];
  const seen = new Set<string>();
  for (const t of upstream) {
    if (seen.has(t.name) || t.name.startsWith("purser_")) continue; // native names cannot be shadowed
    seen.add(t.name);
    const cls = classifyTool(t.name, deps.classifier);
    if (cls === "unknown" && !(deps.exposeUnknown ?? []).includes(t.name)) continue;
    out.push({
      name: t.name,
      description: t.description ?? "",
      inputSchema: ANNOTATED_CLASSES.has(cls) ? withReasonAndSource(t.inputSchema) : ((t.inputSchema as Record<string, unknown>) ?? { type: "object", properties: {} }),
    });
  }
  for (const n of NATIVE_TOOL_DEFS) {
    const cls = classifyTool(n.name, deps.classifier);
    out.push({ ...n, inputSchema: ANNOTATED_CLASSES.has(cls) ? withReasonAndSource(n.inputSchema) : n.inputSchema });
  }
  return out;
}
