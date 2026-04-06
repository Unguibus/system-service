import type { Message } from "./types";
import { AGENT_USER } from "./types";
import { handleMcpSSE, handleMcpMessage } from "./mcp-sse";
import { routeMessage } from "./messages";
import { listAgents, getAgent } from "./agents";
import {
  createAgent,
  onboardAgent,
  assignAgent,
  unassignAgent,
  forkAgent,
  archiveAgent,
  unarchiveAgent,
} from "./lifecycle";
import { stopAgent } from "./runtime";
import { ensureReservedAgent, isReservedAgent } from "./reserved-agents";
import { getAgentConversations } from "./synapse";
import {
  hasPermission,
  getEffectivePermissions,
  grantPermission,
  revokePermission,
  getAuditLog,
} from "./iam";
import {
  isExchangeConnected,
  connectToExchange,
  disconnectFromExchange,
  getHostId,
} from "./exchange-client";

const PORT = parseInt(process.env.PORT ?? "7272");

async function parseBody(req: Request): Promise<any> {
  try {
    return await req.json();
  } catch {
    return null;
  }
}

function json(data: any, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// Extract calling agent ID from request (header or default to user)
function getCallerId(req: Request): string {
  return req.headers.get("x-agent-id") ?? AGENT_USER;
}

async function handleRequest(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname;
  const method = req.method;

  // --- Messages ---

  if (method === "POST" && path === "/messages") {
    return (async () => {
      const body = await parseBody(req);
      if (!body?.to || !body?.body) {
        return json({ error: "Missing 'to' and/or 'body'" }, 400);
      }

      const callerId = getCallerId(req);

      // Check messaging permission
      const isLocal = !body.to.includes("@");
      if (isLocal && !hasPermission(callerId, "message.local")) {
        return json({ error: "No message.local permission" }, 403);
      }
      if (!isLocal && !hasPermission(callerId, "message.crosshost")) {
        // Check subset permissions
        const targetAgent = body.to.split("@")[0];
        if (targetAgent === "911" && hasPermission(callerId, "message.crosshost.911")) {
          // OK
        } else if (targetAgent === "0" && hasPermission(callerId, "message.crosshost.operator")) {
          // OK
        } else {
          return json({ error: "No cross-host messaging permission" }, 403);
        }
      }

      const msg: Message = {
        to: body.to,
        from: body.from ?? callerId,
        type: body.type ?? "message",
        body: body.body,
        timestamp: Date.now(),
      };

      // Lazyload reserved agents if needed
      const targetId = msg.to.split("@")[0];
      if (isReservedAgent(targetId)) {
        ensureReservedAgent(targetId);
      }

      const result = routeMessage(msg);
      if (!result.delivered) {
        return json({ error: result.error }, 502);
      }
      return json({ delivered: true, timestamp: msg.timestamp }, 202);
    })();
  }

  // --- Agents ---

  if (method === "GET" && path === "/agents") {
    const agents = listAgents();
    return json(agents);
  }

  if (method === "GET" && path.startsWith("/agents/") && path.split("/").length === 3) {
    const agentId = path.split("/")[2];
    const agent = getAgent(agentId);
    if (!agent) return json({ error: "Agent not found" }, 404);
    return json(agent);
  }

  // GET /agents/:id/conversations — read conversation history
  if (method === "GET" && path.match(/^\/agents\/[^/]+\/conversations$/)) {
    const agentId = path.split("/")[2];
    const limit = parseInt(url.searchParams.get("limit") ?? "50");
    const entries = getAgentConversations(agentId, limit);
    if (!entries) return json({ error: "Agent not running" }, 404);
    return json(entries);
  }

  // PATCH /agents/:id — update agent config
  if (method === "PATCH" && path.startsWith("/agents/") && path.split("/").length === 3) {
    return (async () => {
      const agentId = path.split("/")[2];
      const body = await parseBody(req);
      if (!body) return json({ error: "Invalid body" }, 400);

      const { updateAgentConfig } = await import("./agents");
      const result = updateAgentConfig(agentId, body);
      if (!result) return json({ error: "Agent not found" }, 404);
      return json(result);
    })();
  }

  if (method === "POST" && path === "/agents") {
    return (async () => {
      const body = await parseBody(req);
      if (!body?.name) return json({ error: "Missing 'name'" }, 400);

      const callerId = getCallerId(req);
      if (!hasPermission(callerId, "agent.create")) {
        return json({ error: "No agent.create permission" }, 403);
      }

      const result = createAgent({
        name: body.name,
        model: body.model,
        effort: body.effort,
        tags: body.tags,
      });

      if (!result.success) return json({ error: result.error }, 400);
      return json({ agentId: result.agentId }, 201);
    })();
  }

  // --- Lifecycle operations ---

  if (method === "POST" && path.match(/^\/agents\/[^/]+\/assign$/)) {
    return (async () => {
      const agentId = path.split("/")[2];
      const body = await parseBody(req);
      if (!body?.targetDir) return json({ error: "Missing 'targetDir'" }, 400);

      const callerId = getCallerId(req);
      if (!hasPermission(callerId, "agent.assign")) {
        return json({ error: "No agent.assign permission" }, 403);
      }

      const result = assignAgent(agentId, body.targetDir);
      return json(result, result.success ? 200 : 400);
    })();
  }

  if (method === "POST" && path.match(/^\/agents\/[^/]+\/unassign$/)) {
    return (async () => {
      const agentId = path.split("/")[2];

      const callerId = getCallerId(req);
      if (!hasPermission(callerId, "agent.unassign")) {
        return json({ error: "No agent.unassign permission" }, 403);
      }

      const result = unassignAgent(agentId);
      return json(result, result.success ? 200 : 400);
    })();
  }

  if (method === "POST" && path.match(/^\/agents\/[^/]+\/fork$/)) {
    return (async () => {
      const agentId = path.split("/")[2];

      const callerId = getCallerId(req);
      if (!hasPermission(callerId, "agent.fork")) {
        return json({ error: "No agent.fork permission" }, 403);
      }

      const result = forkAgent(agentId);
      return json(result, result.success ? 201 : 400);
    })();
  }

  if (method === "POST" && path === "/agents/onboard") {
    return (async () => {
      const body = await parseBody(req);
      if (!body?.targetDir) return json({ error: "Missing 'targetDir'" }, 400);

      const callerId = getCallerId(req);
      if (!hasPermission(callerId, "agent.onboard")) {
        return json({ error: "No agent.onboard permission" }, 403);
      }

      const result = onboardAgent(body.targetDir);
      return json(result, result.success ? 201 : 400);
    })();
  }

  if (method === "POST" && path.match(/^\/agents\/[^/]+\/archive$/)) {
    return (async () => {
      const agentId = path.split("/")[2];

      const callerId = getCallerId(req);
      if (!hasPermission(callerId, "agent.offboard")) {
        return json({ error: "No agent.offboard permission" }, 403);
      }

      const result = archiveAgent(agentId);
      return json(result, result.success ? 200 : 400);
    })();
  }

  if (method === "POST" && path.match(/^\/agents\/[^/]+\/unarchive$/)) {
    return (async () => {
      const agentId = path.split("/")[2];

      const callerId = getCallerId(req);
      if (!hasPermission(callerId, "agent.offboard")) {
        return json({ error: "No agent.offboard permission" }, 403);
      }

      const result = unarchiveAgent(agentId);
      return json(result, result.success ? 200 : 400);
    })();
  }

  // Keep legacy offboard route as alias for archive
  if (method === "POST" && path.match(/^\/agents\/[^/]+\/offboard$/)) {
    return (async () => {
      const agentId = path.split("/")[2];

      const callerId = getCallerId(req);
      if (!hasPermission(callerId, "agent.offboard")) {
        return json({ error: "No agent.offboard permission" }, 403);
      }

      const result = archiveAgent(agentId);
      return json(result, result.success ? 200 : 400);
    })();
  }

  if (method === "POST" && path.match(/^\/agents\/[^/]+\/stop$/)) {
    const agentId = path.split("/")[2];
    const callerId = getCallerId(req);
    if (!hasPermission(callerId, "agent.stop")) {
      return json({ error: "No agent.stop permission" }, 403);
    }
    stopAgent(agentId);
    return json({ success: true, agentId });
  }

  if (method === "POST" && path.match(/^\/agents\/[^/]+\/isolate$/)) {
    const agentId = path.split("/")[2];
    const callerId = getCallerId(req);
    if (!hasPermission(callerId, "agent.isolate")) {
      return json({ error: "No agent.isolate permission" }, 403);
    }
    stopAgent(agentId);
    // TODO: Mark as isolated to prevent restart
    return json({ success: true, agentId, isolated: true });
  }

  // --- IAM / Permissions ---

  if (method === "GET" && path.match(/^\/agents\/[^/]+\/permissions$/)) {
    const agentId = path.split("/")[2];
    const perms = getEffectivePermissions(agentId);
    return json({ agentId, permissions: perms });
  }

  if (method === "POST" && path.match(/^\/agents\/[^/]+\/permissions\/grant$/)) {
    return (async () => {
      const agentId = path.split("/")[2];
      const body = await parseBody(req);
      if (!body?.permission) return json({ error: "Missing 'permission'" }, 400);

      const callerId = getCallerId(req);
      const result = grantPermission(callerId, agentId, body.permission);
      return json(result, result.success ? 200 : 403);
    })();
  }

  if (method === "POST" && path.match(/^\/agents\/[^/]+\/permissions\/revoke$/)) {
    return (async () => {
      const agentId = path.split("/")[2];
      const body = await parseBody(req);
      if (!body?.permission) return json({ error: "Missing 'permission'" }, 400);

      const callerId = getCallerId(req);
      const result = revokePermission(callerId, agentId, body.permission);
      return json(result, result.success ? 200 : 403);
    })();
  }

  if (method === "GET" && path === "/iam/audit") {
    const limit = parseInt(url.searchParams.get("limit") ?? "50");
    return json(getAuditLog(limit));
  }

  // --- Exchange ---

  if (method === "POST" && path === "/exchange/connect") {
    return (async () => {
      const body = await parseBody(req);
      if (!body?.url || !body?.secret || !body?.hostId) {
        return json({ error: "Missing url, secret, or hostId" }, 400);
      }
      await connectToExchange(body);
      return json({ connected: true, hostId: body.hostId });
    })();
  }

  if (method === "POST" && path === "/exchange/disconnect") {
    disconnectFromExchange();
    return json({ connected: false });
  }

  if (method === "GET" && path === "/exchange/status") {
    return json({
      connected: isExchangeConnected(),
      hostId: getHostId(),
    });
  }

  // --- Health ---

  if (method === "GET" && path === "/health") {
    const agents = listAgents();
    return json({
      status: "healthy",
      uptime: process.uptime(),
      agents: {
        total: agents.length,
        idle: agents.filter((a) => a.status === "idle").length,
        running: agents.filter((a) => a.status === "running").length,
        waiting: agents.filter((a) => a.status === "waiting").length,
        error: agents.filter((a) => a.status === "error").length,
      },
      exchange: {
        connected: isExchangeConnected(),
        hostId: getHostId(),
      },
    });
  }

  // --- MCP SSE endpoint ---

  // GET /mcp/:agentId/sse — SSE stream for MCP
  if (method === "GET" && path.match(/^\/mcp\/[^/]+\/sse$/)) {
    const agentId = path.split("/")[2];
    return handleMcpSSE(agentId);
  }

  // POST /mcp/:agentId/message — JSON-RPC messages for MCP
  if (method === "POST" && path.match(/^\/mcp\/[^/]+\/message$/)) {
    const agentId = path.split("/")[2];
    const sessionId = url.searchParams.get("sessionId") ?? "";
    const body = await parseBody(req);
    if (!body) return json({ error: "Invalid body" }, 400);
    return handleMcpMessage(agentId, sessionId, body);
  }

  return json({ error: "Not found" }, 404);
}

export function startServer(): void {
  Bun.serve({
    port: PORT,
    idleTimeout: 0,
    fetch: handleRequest,
  });
  console.log(`[server] System service listening on port ${PORT}`);
}
