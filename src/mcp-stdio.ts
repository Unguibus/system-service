#!/usr/bin/env bun
// MCP stdio bridge — spawned by Claude as a subprocess
// Reads JSON-RPC from stdin (Content-Length framing), writes to stdout

const agentId = Bun.argv[2] || "unknown";
const SERVICE_URL = "http://localhost:7272";

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

async function handleToolCall(name: string, args: any): Promise<string> {
  try {
    if (name === "send_message") {
      const res = await fetch(`${SERVICE_URL}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-agent-id": agentId },
        body: JSON.stringify({ to: args.to, from: agentId, body: args.body, type: args.type || "message" }),
      });
      const data = await res.json() as any;
      return data.delivered ? `Message sent to ${args.to}` : `Failed: ${data.error}`;
    }
    if (name === "list_agents") {
      const res = await fetch(`${SERVICE_URL}/agents`);
      const agents = await res.json() as any[];
      return JSON.stringify(agents.map((a: any) => ({
        id: a.config?.id, name: a.config?.name, status: a.status, location: a.location,
      })), null, 2);
    }
    if (name === "get_agent") {
      const res = await fetch(`${SERVICE_URL}/agents/${args.agent_id}`);
      return JSON.stringify(await res.json(), null, 2);
    }
    if (name === "get_exchange_status") {
      const res = await fetch(`${SERVICE_URL}/exchange/status`);
      return JSON.stringify(await res.json(), null, 2);
    }
    if (name === "send_to_operator") {
      const res = await fetch(`${SERVICE_URL}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-agent-id": agentId },
        body: JSON.stringify({ to: `0@${args.host_id}`, from: agentId, body: args.body, type: "message" }),
      });
      const data = await res.json() as any;
      return data.delivered ? `Message sent to Operator on ${args.host_id}` : `Failed: ${data.error}`;
    }
    return `Unknown tool: ${name}`;
  } catch (err: any) {
    return `Error: ${err.message}`;
  }
}

function write(obj: any): void {
  const json = JSON.stringify(obj);
  const bytes = Buffer.from(json, "utf-8");
  const header = `Content-Length: ${bytes.length}\r\n\r\n`;
  Bun.write(Bun.stdout, header + json);
}

async function handleMessage(request: any): Promise<void> {
  const { method, params, id } = request;

  // Notifications have no id — don't respond
  if (id === undefined || id === null) return;

  if (method === "initialize") {
    write({
      jsonrpc: "2.0", id,
      result: {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "unguibus", version: "1.0.0" },
      },
    });
    return;
  }

  if (method === "tools/list") {
    write({ jsonrpc: "2.0", id, result: { tools: TOOLS } });
    return;
  }

  if (method === "tools/call") {
    const text = await handleToolCall(params.name, params.arguments || {});
    write({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text }] } });
    return;
  }

  write({ jsonrpc: "2.0", id, error: { code: -32601, message: `Unknown method: ${method}` } });
}

// --- Read stdin with Content-Length framing ---

const reader = Bun.stdin.stream().getReader();
let buffer = "";

async function readLoop(): Promise<void> {
  const decoder = new TextDecoder();

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });

    // Process complete messages
    while (true) {
      const headerEnd = buffer.indexOf("\r\n\r\n");
      if (headerEnd === -1) break;

      const header = buffer.slice(0, headerEnd);
      const match = header.match(/Content-Length:\s*(\d+)/i);
      if (!match) {
        buffer = buffer.slice(headerEnd + 4);
        continue;
      }

      const contentLength = parseInt(match[1]);
      const bodyStart = headerEnd + 4;
      if (buffer.length < bodyStart + contentLength) break;

      const body = buffer.slice(bodyStart, bodyStart + contentLength);
      buffer = buffer.slice(bodyStart + contentLength);

      try {
        await handleMessage(JSON.parse(body));
      } catch {}
    }
  }
}

readLoop();
