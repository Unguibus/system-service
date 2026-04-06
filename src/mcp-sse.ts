// SSE-based MCP server endpoint for the system service
// Agents connect via --mcp-config with url: http://localhost:7272/mcp/<agentId>

import { routeMessage } from "./messages";
import { listAgents, getAgent } from "./agents";
import { getAgentConversations } from "./synapse";
import type { Message } from "./types";

const TOOLS = [
  {
    name: "send_message",
    description: "Send a message to another agent or the user. Use agent ID for local delivery, or agent_id@host_id for cross-host. Use ID '1' to message the user.",
    inputSchema: {
      type: "object",
      properties: {
        to: { type: "string", description: "Recipient address (agent ID, or agent_id@host_id)" },
        body: { type: "string", description: "Message content" },
        type: { type: "string", description: "Message type (default: 'message')" },
      },
      required: ["to", "body"],
    },
  },
  {
    name: "list_agents",
    description: "List all agents on the local host with their current status.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "get_agent",
    description: "Get detailed information about a specific agent.",
    inputSchema: {
      type: "object",
      properties: {
        agent_id: { type: "string", description: "The agent ID to look up" },
      },
      required: ["agent_id"],
    },
  },
  {
    name: "get_exchange_status",
    description: "Get the status of the cross-host message exchange, including this host's ID and whether we're connected.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "send_to_operator",
    description: "Send a message to the Operator on a remote host when you don't know the target agent's ID.",
    inputSchema: {
      type: "object",
      properties: {
        host_id: { type: "string", description: "The target host ID" },
        body: { type: "string", description: "Message content" },
      },
      required: ["host_id", "body"],
    },
  },
];

async function handleToolCall(agentId: string, name: string, args: any): Promise<string> {
  try {
    if (name === "send_message") {
      const msg: Message = {
        to: args.to,
        from: agentId,
        type: args.type || "message",
        body: args.body,
        timestamp: Date.now(),
      };
      const result = routeMessage(msg);
      return result.delivered ? `Message sent to ${args.to}` : `Failed: ${result.error}`;
    }
    if (name === "list_agents") {
      const agents = listAgents();
      return JSON.stringify(agents.map(a => ({
        id: a.config.id, name: a.config.name, status: a.status, location: a.location,
      })), null, 2);
    }
    if (name === "get_agent") {
      const agent = getAgent(args.agent_id);
      if (!agent) return `Agent ${args.agent_id} not found`;
      return JSON.stringify(agent, null, 2);
    }
    if (name === "get_exchange_status") {
      const { isExchangeConnected, getHostId } = await import("./exchange-client");
      return JSON.stringify({ connected: isExchangeConnected(), hostId: getHostId() }, null, 2);
    }
    if (name === "send_to_operator") {
      const msg: Message = {
        to: `0@${args.host_id}`,
        from: agentId,
        type: "message",
        body: args.body,
        timestamp: Date.now(),
      };
      const result = routeMessage(msg);
      return result.delivered ? `Message sent to Operator on ${args.host_id}` : `Failed: ${result.error}`;
    }
    return `Unknown tool: ${name}`;
  } catch (err: any) {
    return `Error: ${err.message}`;
  }
}

// Per-session state for SSE MCP connections
const sessions = new Map<string, {
  agentId: string;
  controller: ReadableStreamDefaultController;
}>();

function sendSSE(sessionId: string, event: string, data: any): void {
  const session = sessions.get(sessionId);
  if (!session) return;
  const json = JSON.stringify(data);
  session.controller.enqueue(`event: ${event}\ndata: ${json}\n\n`);
}

// Handle GET /mcp/:agentId/sse — SSE stream
export function handleMcpSSE(agentId: string): Response {
  const sessionId = crypto.randomUUID();

  const stream = new ReadableStream({
    start(controller) {
      sessions.set(sessionId, { agentId, controller });
      // Send endpoint event so client knows where to POST
      controller.enqueue(`event: endpoint\ndata: /mcp/${agentId}/message?sessionId=${sessionId}\n\n`);
    },
    cancel() {
      sessions.delete(sessionId);
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
    },
  });
}

// Handle POST /mcp/:agentId/message — JSON-RPC messages
export async function handleMcpMessage(
  agentId: string,
  sessionId: string,
  body: any
): Promise<Response> {
  const { method, params, id } = body;

  if (method === "initialize") {
    sendSSE(sessionId, "message", {
      jsonrpc: "2.0", id,
      result: {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "unguibus", version: "1.0.0" },
      },
    });
    return new Response("", { status: 202 });
  }

  if (method === "notifications/initialized") {
    return new Response("", { status: 202 });
  }

  if (method === "tools/list") {
    sendSSE(sessionId, "message", {
      jsonrpc: "2.0", id,
      result: { tools: TOOLS },
    });
    return new Response("", { status: 202 });
  }

  if (method === "tools/call") {
    const text = await handleToolCall(agentId, params.name, params.arguments || {});
    sendSSE(sessionId, "message", {
      jsonrpc: "2.0", id,
      result: { content: [{ type: "text", text }] },
    });
    return new Response("", { status: 202 });
  }

  sendSSE(sessionId, "message", {
    jsonrpc: "2.0", id,
    error: { code: -32601, message: `Unknown method: ${method}` },
  });
  return new Response("", { status: 202 });
}
