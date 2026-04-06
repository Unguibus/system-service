import { routeMessage } from "./messages";
import { listAgents, getAgent } from "./agents";
import { getAgentConversations } from "./synapse";
import type { Message } from "./types";

// MCP Server over stdio — agents connect via --mcp-config
// Protocol: JSON-RPC 2.0 over stdin/stdout

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number | string;
  method: string;
  params?: any;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number | string;
  result?: any;
  error?: { code: number; message: string };
}

const TOOLS = [
  {
    name: "send_message",
    description: "Send a message to another agent or the user. Use agent ID for local delivery, or agent_id@host_id for cross-host.",
    inputSchema: {
      type: "object",
      properties: {
        to: { type: "string", description: "Recipient address (agent ID, or agent_id@host_id for cross-host)" },
        body: { type: "string", description: "Message content" },
        type: { type: "string", description: "Message type (default: 'message')", default: "message" },
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
    name: "get_conversations",
    description: "Get recent conversation history for an agent.",
    inputSchema: {
      type: "object",
      properties: {
        agent_id: { type: "string", description: "The agent ID" },
        limit: { type: "number", description: "Number of entries to return (default 20)", default: 20 },
      },
      required: ["agent_id"],
    },
  },
];

function handleRequest(req: JsonRpcRequest, callerAgentId: string): JsonRpcResponse {
  const { id, method, params } = req;

  if (method === "initialize") {
    return {
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "unguibus", version: "1.0.0" },
      },
    };
  }

  if (method === "notifications/initialized") {
    // Client acknowledgment, no response needed
    return { jsonrpc: "2.0", id, result: null };
  }

  if (method === "tools/list") {
    return { jsonrpc: "2.0", id, result: { tools: TOOLS } };
  }

  if (method === "tools/call") {
    const toolName = params?.name;
    const args = params?.arguments || {};

    if (toolName === "send_message") {
      const msg: Message = {
        to: args.to,
        from: callerAgentId,
        type: args.type || "message",
        body: args.body,
        timestamp: Date.now(),
      };
      const result = routeMessage(msg);
      return {
        jsonrpc: "2.0",
        id,
        result: {
          content: [{ type: "text", text: result.delivered ? `Message sent to ${args.to}` : `Failed: ${result.error}` }],
        },
      };
    }

    if (toolName === "list_agents") {
      const agents = listAgents();
      const summary = agents.map(a => ({
        id: a.config.id,
        name: a.config.name,
        status: a.status,
        location: a.location,
      }));
      return {
        jsonrpc: "2.0",
        id,
        result: { content: [{ type: "text", text: JSON.stringify(summary, null, 2) }] },
      };
    }

    if (toolName === "get_agent") {
      const agent = getAgent(args.agent_id);
      if (!agent) {
        return {
          jsonrpc: "2.0",
          id,
          result: { content: [{ type: "text", text: `Agent ${args.agent_id} not found` }] },
        };
      }
      return {
        jsonrpc: "2.0",
        id,
        result: { content: [{ type: "text", text: JSON.stringify(agent, null, 2) }] },
      };
    }

    if (toolName === "get_conversations") {
      const entries = getAgentConversations(args.agent_id, args.limit || 20);
      if (!entries) {
        return {
          jsonrpc: "2.0",
          id,
          result: { content: [{ type: "text", text: `Agent ${args.agent_id} not running` }] },
        };
      }
      return {
        jsonrpc: "2.0",
        id,
        result: { content: [{ type: "text", text: JSON.stringify(entries, null, 2) }] },
      };
    }

    return {
      jsonrpc: "2.0",
      id,
      error: { code: -32601, message: `Unknown tool: ${toolName}` },
    };
  }

  return {
    jsonrpc: "2.0",
    id,
    error: { code: -32601, message: `Unknown method: ${method}` },
  };
}

// Start an MCP stdio server for a specific agent
// Returns the path to a wrapper script that Claude can use via --mcp-config
export function createMcpConfig(agentId: string): object {
  const bunPath = `${process.env.HOME}/.bun/bin/bun`;
  const scriptPath = `${import.meta.dir}/mcp-stdio.ts`;

  return {
    mcpServers: {
      unguibus: {
        command: bunPath,
        args: ["run", scriptPath, agentId],
      },
    },
  };
}

// This is the entry point when run as a subprocess by Claude
// Usage: bun run mcp-stdio.ts <agentId>
export { handleRequest };
