import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

export interface McpTool {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

export interface McpCallResult {
  raw: string;
  json: Record<string, unknown> | null;
  isError: boolean;
}

/** One MCP session against Purser's /mcp, authenticated as the agent. The agent key is never logged. */
export class McpSession {
  private constructor(
    private readonly client: Client,
    readonly tools: McpTool[],
  ) {}

  static async connect(baseUrl: string, agentKey: string, name = "purser-demo-agent"): Promise<McpSession> {
    const client = new Client({ name, version: "0.1.0" });
    const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${agentKey}` } } });
    await client.connect(transport);
    const listed = await client.listTools();
    return new McpSession(
      client,
      listed.tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema as Record<string, unknown> })),
    );
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<McpCallResult> {
    const res = (await this.client.callTool({ name, arguments: args })) as { content?: { type: string; text?: string }[]; isError?: boolean };
    const raw = (res.content ?? []).map((c) => c.text ?? "").join("\n");
    let json: Record<string, unknown> | null = null;
    try {
      const p = JSON.parse(raw);
      if (p && typeof p === "object" && !Array.isArray(p)) json = p as Record<string, unknown>;
    } catch {
      // not JSON (an upstream passthrough)
    }
    return { raw, json, isError: Boolean(res.isError) };
  }

  async close(): Promise<void> {
    await this.client.close().catch(() => undefined);
  }
}
