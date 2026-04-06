import type { Message } from "./types";
import { routeMessage } from "./messages";
import { listAgents, getAgent } from "./agents";
import { createAgent, onboardAgent, assignAgent, unassignAgent, forkAgent, offboardAgent } from "./lifecycle";
import { stopAgent } from "./runtime";

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

function handleRequest(req: Request): Response | Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname;
  const method = req.method;

  // POST /messages — send a message
  if (method === "POST" && path === "/messages") {
    return (async () => {
      const body = await parseBody(req);
      if (!body?.to || !body?.body) {
        return json({ error: "Missing 'to' and/or 'body'" }, 400);
      }

      const msg: Message = {
        to: body.to,
        from: body.from ?? "1", // Default: from user
        type: body.type ?? "message",
        body: body.body,
        timestamp: Date.now(),
      };

      const result = routeMessage(msg);
      if (!result.delivered) {
        return json({ error: result.error }, 502);
      }
      return json({ delivered: true, timestamp: msg.timestamp }, 202);
    })();
  }

  // GET /agents — list all agents
  if (method === "GET" && path === "/agents") {
    const agents = listAgents();
    return json(agents);
  }

  // GET /agents/:id — get specific agent
  if (method === "GET" && path.startsWith("/agents/") && path.split("/").length === 3) {
    const agentId = path.split("/")[2];
    const agent = getAgent(agentId);
    if (!agent) return json({ error: "Agent not found" }, 404);
    return json(agent);
  }

  // POST /agents — create agent
  if (method === "POST" && path === "/agents") {
    return (async () => {
      const body = await parseBody(req);
      if (!body?.name) return json({ error: "Missing 'name'" }, 400);

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

  // POST /agents/:id/assign
  if (method === "POST" && path.match(/^\/agents\/[^/]+\/assign$/)) {
    return (async () => {
      const agentId = path.split("/")[2];
      const body = await parseBody(req);
      if (!body?.targetDir) return json({ error: "Missing 'targetDir'" }, 400);

      const result = assignAgent(agentId, body.targetDir);
      return json(result, result.success ? 200 : 400);
    })();
  }

  // POST /agents/:id/unassign
  if (method === "POST" && path.match(/^\/agents\/[^/]+\/unassign$/)) {
    return (async () => {
      const agentId = path.split("/")[2];
      const body = await parseBody(req);
      if (!body?.currentDir) return json({ error: "Missing 'currentDir'" }, 400);

      const result = unassignAgent(agentId, body.currentDir);
      return json(result, result.success ? 200 : 400);
    })();
  }

  // POST /agents/:id/fork
  if (method === "POST" && path.match(/^\/agents\/[^/]+\/fork$/)) {
    return (async () => {
      const agentId = path.split("/")[2];
      const body = await parseBody(req);
      if (!body?.claudePath) return json({ error: "Missing 'claudePath'" }, 400);

      const result = forkAgent(agentId, body.claudePath);
      return json(result, result.success ? 201 : 400);
    })();
  }

  // POST /agents/:id/onboard
  if (method === "POST" && path.match(/^\/agents\/[^/]+\/onboard$/)) {
    return (async () => {
      const body = await parseBody(req);
      if (!body?.targetDir) return json({ error: "Missing 'targetDir'" }, 400);

      const result = onboardAgent(body.targetDir);
      return json(result, result.success ? 201 : 400);
    })();
  }

  // POST /agents/:id/offboard
  if (method === "POST" && path.match(/^\/agents\/[^/]+\/offboard$/)) {
    return (async () => {
      const agentId = path.split("/")[2];
      const agent = getAgent(agentId);
      if (!agent) return json({ error: "Agent not found" }, 404);

      const result = offboardAgent(agentId, agent.claudePath);
      return json(result, result.success ? 200 : 400);
    })();
  }

  // POST /agents/:id/stop
  if (method === "POST" && path.match(/^\/agents\/[^/]+\/stop$/)) {
    const agentId = path.split("/")[2];
    stopAgent(agentId);
    return json({ success: true, agentId });
  }

  // GET /health
  if (method === "GET" && path === "/health") {
    const agents = listAgents();
    return json({
      status: "healthy",
      uptime: process.uptime(),
      agents: {
        total: agents.length,
        idle: agents.filter((a) => a.status === "idle").length,
        running: agents.filter((a) => a.status === "running").length,
        error: agents.filter((a) => a.status === "error").length,
      },
    });
  }

  return json({ error: "Not found" }, 404);
}

export function startServer(): void {
  Bun.serve({
    port: PORT,
    fetch: handleRequest,
  });
  console.log(`[server] System service listening on port ${PORT}`);
}
