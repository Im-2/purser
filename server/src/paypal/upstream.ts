import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { PayPalClient } from "./client.js";

export interface UpstreamTool {
  name: string;
  description?: string;
  inputSchema?: unknown;
}

export interface UpstreamResult {
  isError?: boolean;
  content?: { type: string; text?: string; [k: string]: unknown }[];
  structuredContent?: unknown;
  [k: string]: unknown;
}

/** One interface behind every way of reaching PayPal's MCP tools (stdio child, remote server, in-process toolkit). */
export interface UpstreamClient {
  /** Connect and run tools/list. Safe to call again. */
  start(): Promise<UpstreamTool[]>;
  listTools(): Promise<UpstreamTool[]>;
  callTool(name: string, args: Record<string, unknown>): Promise<UpstreamResult>;
  close(): Promise<void>;
}

export class UpstreamError extends Error {
  override name: string = "UpstreamError";
  constructor(
    message: string,
    /** Last output the child process wrote to stderr (no env values), to show the exact failure. */
    readonly stderr: string = "",
    override readonly cause?: unknown,
  ) {
    super(message);
  }
}

/** Windows needs the .cmd shim for npx; elsewhere it is plain `npx`. */
export function npxCommand(platform: string = process.platform): string {
  return platform === "win32" ? "npx.cmd" : "npx";
}

export interface StdioUpstreamOptions {
  paypal: PayPalClient;
  /** Package to run. Default @paypal/mcp. */
  packageName?: string;
  /** Default ["--tools=all"]. */
  toolsArgs?: string[];
  /** Restart the child when the token has less than this much life left. Default 5 minutes. */
  restartBeforeExpiryMs?: number;
  platform?: string;
  /** Called with the discovered tool list after each (re)start, e.g. to cache it in kv. */
  onTools?: (tools: UpstreamTool[]) => void;
  connectTimeoutMs?: number;
}

/**
 * Spawns `npx -y @paypal/mcp --tools=all` over stdio with PAYPAL_ACCESS_TOKEN minted by our OAuth helper.
 * The token cannot be refreshed inside the child, so the child is restarted when the token nears expiry.
 */
export class StdioUpstream implements UpstreamClient {
  private client: Client | null = null;
  private transport: StdioClientTransport | null = null;
  private tools: UpstreamTool[] = [];
  private tokenExpiresAtMs = 0;
  private stderrBuf = "";
  private starting: Promise<UpstreamTool[]> | null = null;

  constructor(private readonly o: StdioUpstreamOptions) {}

  get stderrTail(): string {
    return this.stderrBuf;
  }

  start(): Promise<UpstreamTool[]> {
    if (this.starting) return this.starting;
    this.starting = this.doStart().finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  private async doStart(): Promise<UpstreamTool[]> {
    await this.close();
    const tok = await this.o.paypal.getAccessToken(true);
    this.tokenExpiresAtMs = tok.expiresAtMs;
    this.stderrBuf = "";

    const transport = new StdioClientTransport({
      command: npxCommand(this.o.platform),
      args: ["-y", this.o.packageName ?? "@paypal/mcp", ...(this.o.toolsArgs ?? ["--tools=all"])],
      env: { ...getDefaultEnvironment(), PAYPAL_ACCESS_TOKEN: tok.token, PAYPAL_ENVIRONMENT: "SANDBOX" },
      stderr: "pipe",
    });
    transport.stderr?.on("data", (chunk: Buffer) => {
      this.stderrBuf = (this.stderrBuf + chunk.toString("utf8")).slice(-8000);
    });
    const client = new Client({ name: "purser-gateway", version: "0.1.0" });

    try {
      await client.connect(transport, { timeout: this.o.connectTimeoutMs ?? 120_000 });
      const listed = await client.listTools(undefined, { timeout: 60_000 });
      this.tools = listed.tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }));
    } catch (err) {
      const stderr = this.stderrBuf;
      await client.close().catch(() => undefined);
      throw new UpstreamError(`Upstream PayPal MCP failed to start: ${(err as Error).message}`, stderr, err);
    }
    this.client = client;
    this.transport = transport;
    this.o.onTools?.(this.tools);
    return this.tools;
  }

  async listTools(): Promise<UpstreamTool[]> {
    if (!this.client) await this.start();
    return this.tools;
  }

  private async ensureFresh(): Promise<void> {
    const margin = this.o.restartBeforeExpiryMs ?? 5 * 60_000;
    if (!this.client || this.tokenExpiresAtMs - margin <= Date.now()) await this.start();
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<UpstreamResult> {
    await this.ensureFresh();
    try {
      return (await this.client!.callTool({ name, arguments: args })) as UpstreamResult;
    } catch (err) {
      throw new UpstreamError(`Upstream tool "${name}" failed: ${(err as Error).message}`, this.stderrBuf, err);
    }
  }

  async close(): Promise<void> {
    const c = this.client;
    this.client = null;
    this.transport = null;
    if (c) await c.close().catch(() => undefined);
  }
}

/** Convenience wrapper matching the spec's callUpstreamTool(name, args). */
export function callUpstreamTool(upstream: UpstreamClient, name: string, args: Record<string, unknown> = {}): Promise<UpstreamResult> {
  return upstream.callTool(name, args);
}

/** Join the text parts of an MCP result. */
export function resultText(r: UpstreamResult): string {
  return (r.content ?? []).map((c) => (c.type === "text" && typeof c.text === "string" ? c.text : "")).join("\n");
}

/** Used when PayPal credentials are missing: every call fails closed with a clear error. */
export class DisabledUpstream implements UpstreamClient {
  private fail(): never {
    throw new UpstreamError("Upstream PayPal MCP is disabled (PayPal credentials are not configured)");
  }
  async start(): Promise<UpstreamTool[]> {
    return this.fail();
  }
  async listTools(): Promise<UpstreamTool[]> {
    return [];
  }
  async callTool(): Promise<UpstreamResult> {
    return this.fail();
  }
  async close(): Promise<void> {}
}
