import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema, isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { runPipeline, type GatewayDeps } from "./pipeline.js";
import { buildToolList } from "./tools.js";

interface Session {
  transport: StreamableHTTPServerTransport;
  server: Server;
  agentId: string;
}

/** One MCP Server per session, bound to exactly one agent. The agent id never comes from the client. */
function createMcpServer(deps: GatewayDeps, agentId: string): Server {
  const server = new Server({ name: "purser", version: "0.1.0" }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: await buildToolList(deps) }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const res = await runPipeline(deps, agentId, req.params.name, req.params.arguments ?? {});
    return res as never;
  });
  return server;
}

function bearer(req: FastifyRequest): string | null {
  const h = req.headers.authorization;
  const m = typeof h === "string" ? /^Bearer\s+(\S+)$/i.exec(h) : null;
  return m ? (m[1] ?? null) : null;
}

const rpcError = (reply: FastifyReply, status: number, code: number, message: string) =>
  reply.code(status).header("content-type", "application/json").send({ jsonrpc: "2.0", error: { code, message }, id: null });

/** Mount POST/GET/DELETE /mcp (Streamable HTTP). */
export function registerMcpRoutes(app: FastifyInstance, deps: GatewayDeps): { sessionCount: () => number; closeAll: () => Promise<void> } {
  const sessions = new Map<string, Session>();

  const handler = async (req: FastifyRequest, reply: FastifyReply) => {
    // Stage 0 (auth): unknown or missing key is a 401 and nothing else happens.
    const key = bearer(req);
    const agent = key ? deps.repos.agents.byApiKey(key) : undefined;
    if (!agent) {
      reply.header("WWW-Authenticate", 'Bearer realm="purser"');
      return rpcError(reply, 401, -32001, "Unauthorized");
    }

    const sid = req.headers["mcp-session-id"];
    const sessionId = Array.isArray(sid) ? sid[0] : sid;

    let session: Session | undefined;
    if (sessionId) {
      session = sessions.get(sessionId);
      // A session can only be used by the agent that created it. Do not confirm that it exists to anyone else.
      if (!session || session.agentId !== agent.id) return rpcError(reply, 404, -32001, "Session not found");
    } else if (req.method === "POST" && isInitializeRequest(req.body)) {
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        enableJsonResponse: true,
        onsessioninitialized: (id) => {
          sessions.set(id, { transport, server, agentId: agent.id });
        },
      });
      const server = createMcpServer(deps, agent.id);
      transport.onclose = () => {
        if (transport.sessionId) sessions.delete(transport.sessionId);
      };
      await server.connect(transport);
      session = { transport, server, agentId: agent.id };
    } else {
      return rpcError(reply, 400, -32000, "Bad Request: no valid session. Send an initialize request first.");
    }

    reply.hijack();
    await session.transport.handleRequest(req.raw, reply.raw, req.body);
  };

  app.post("/mcp", handler);
  app.get("/mcp", handler);
  app.delete("/mcp", handler);

  return {
    sessionCount: () => sessions.size,
    async closeAll() {
      const all = [...sessions.values()];
      sessions.clear();
      await Promise.all(all.map((s) => s.server.close().catch(() => undefined)));
    },
  };
}
