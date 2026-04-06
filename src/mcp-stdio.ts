// MCP stdio bridge — spawned by Claude as a subprocess
// Reads JSON-RPC from stdin, forwards to system-service HTTP API, writes responses to stdout

const agentId = process.argv[2] || "unknown";
const SERVICE_URL = "http://localhost:7272";

async function callService(method: string, params: any): Promise<any> {
  // Map MCP tool calls to system-service REST API
  if (method === "initialize") {
    return {
      protocolVersion: "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "unguibus", version: "1.0.0" },
    };
  }

  if (method === "notifications/initialized") {
    return null;
  }

  if (method === "tools/list") {
    return {
      tools: [
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
          description: "Send a message to the Operator on a remote host. Use this when you need to reach an agent on another host but don't know their ID. The remote Operator will route it.",
          inputSchema: {
            type: "object",
            properties: {
              host_id: { type: "string", description: "The target host ID" },
              body: { type: "string", description: "Message content — include who you're trying to reach and why" },
            },
            required: ["host_id", "body"],
          },
        },
      ],
    };
  }

  if (method === "tools/call") {
    const toolName = params?.name;
    const args = params?.arguments || {};

    if (toolName === "send_message") {
      const res = await fetch(`${SERVICE_URL}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-agent-id": agentId },
        body: JSON.stringify({
          to: args.to,
          from: agentId,
          body: args.body,
          type: args.type || "message",
        }),
      });
      const data = await res.json();
      return {
        content: [{ type: "text", text: data.delivered ? `Message sent to ${args.to}` : `Failed: ${data.error}` }],
      };
    }

    if (toolName === "list_agents") {
      const res = await fetch(`${SERVICE_URL}/agents`);
      const agents = await res.json();
      const summary = agents.map((a: any) => ({
        id: a.config?.id,
        name: a.config?.name,
        status: a.status,
        location: a.location,
      }));
      return { content: [{ type: "text", text: JSON.stringify(summary, null, 2) }] };
    }

    if (toolName === "get_agent") {
      const res = await fetch(`${SERVICE_URL}/agents/${args.agent_id}`);
      const agent = await res.json();
      return { content: [{ type: "text", text: JSON.stringify(agent, null, 2) }] };
    }

    if (toolName === "get_exchange_status") {
      const res = await fetch(`${SERVICE_URL}/exchange/status`);
      const status = await res.json();
      return { content: [{ type: "text", text: JSON.stringify(status, null, 2) }] };
    }

    if (toolName === "send_to_operator") {
      const res = await fetch(`${SERVICE_URL}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-agent-id": agentId },
        body: JSON.stringify({
          to: `0@${args.host_id}`,
          from: agentId,
          body: args.body,
          type: "message",
        }),
      });
      const data = await res.json();
      return {
        content: [{ type: "text", text: data.delivered ? `Message sent to Operator on ${args.host_id}` : `Failed: ${data.error}` }],
      };
    }

    return { content: [{ type: "text", text: `Unknown tool: ${toolName}` }] };
  }

  return null;
}

// Read JSON-RPC messages from stdin line by line
const decoder = new TextDecoder();
let buffer = "";

process.stdin.resume();

for await (const chunk of process.stdin) {
  buffer += decoder.decode(chunk as Uint8Array, { stream: true });

  // MCP uses Content-Length headers like LSP
  while (true) {
    const headerEnd = buffer.indexOf("\r\n\r\n");
    if (headerEnd === -1) break;

    const header = buffer.slice(0, headerEnd);
    const contentLengthMatch = header.match(/Content-Length:\s*(\d+)/i);
    if (!contentLengthMatch) {
      buffer = buffer.slice(headerEnd + 4);
      continue;
    }

    const contentLength = parseInt(contentLengthMatch[1]);
    const bodyStart = headerEnd + 4;
    if (buffer.length < bodyStart + contentLength) break; // Wait for more data

    const body = buffer.slice(bodyStart, bodyStart + contentLength);
    buffer = buffer.slice(bodyStart + contentLength);

    try {
      const request = JSON.parse(body);
      const result = await callService(request.method, request.params);

      if (request.method?.startsWith("notifications/")) continue; // No response for notifications

      const response = JSON.stringify({
        jsonrpc: "2.0",
        id: request.id,
        result,
      });

      const responseBytes = new TextEncoder().encode(response);
      process.stdout.write(`Content-Length: ${responseBytes.length}\r\n\r\n`);
      process.stdout.write(response);
    } catch (err: any) {
      // Ignore parse errors
    }
  }
}
