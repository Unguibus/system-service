import type { Message } from "./types";
import { AGENT_OPERATOR, AGENT_USER } from "./types";
import { deliverToSynapse, addToAgentConversation } from "./synapse";
import { isAgentRegistered, resolveAgentId } from "./agents";

// Callback for cross-host delivery (set when Exchange is connected)
let crossHostSend: ((msg: Message) => void) | null = null;

// Callback for delivering to user (ID 1) — set by Electron app or console
let userMessageHandler: ((msg: Message) => void) | null = null;

// In-memory queue for messages to agents not yet initialized
const pendingQueues = new Map<string, Message[]>();

export function setCrossHostSender(fn: (msg: Message) => void): void {
  crossHostSend = fn;
}

export function setUserMessageHandler(fn: (msg: Message) => void): void {
  userMessageHandler = fn;
}

function parseAddress(address: string): { agentId: string; hostId?: string } {
  if (address.includes("@")) {
    const [agentId, hostId] = address.split("@", 2);
    return { agentId, hostId };
  }
  return { agentId: address };
}

export function routeMessage(msg: Message): { delivered: boolean; error?: string } {
  const { agentId: rawId, hostId } = parseAddress(msg.to);
  // Resolve assignedId aliases (e.g. "operator" → actual agent ID)
  const agentId = resolveAgentId(rawId) ?? rawId;

  // Cross-host: forward to Exchange
  if (hostId) {
    if (!crossHostSend) {
      return { delivered: false, error: "Exchange not connected" };
    }
    crossHostSend(msg);
    return { delivered: true };
  }

  // Local delivery to user (ID 1)
  if (agentId === AGENT_USER) {
    // Store as "assistant" message in the sender's conversation history
    addToAgentConversation(msg.from, {
      type: "assistant",
      from: msg.from,
      to: AGENT_USER,
      message: msg.body,
      timestamp: msg.timestamp,
    });

    if (userMessageHandler) {
      userMessageHandler(msg);
    } else {
      console.log(`[msg→user] From ${msg.from}: ${msg.body}`);
    }
    return { delivered: true };
  }

  // Local delivery to agent
  if (isAgentRegistered(agentId)) {
    // Store outgoing message in sender's conversation history
    if (msg.from && msg.from !== AGENT_USER) {
      addToAgentConversation(msg.from, {
        type: "assistant",
        from: msg.from,
        to: agentId,
        message: msg.body,
        timestamp: msg.timestamp,
      });
    }
    deliverToSynapse(agentId, msg);
    return { delivered: true };
  }

  // Agent not found — route to Operator
  if (agentId !== AGENT_OPERATOR) {
    console.log(`[msg] Agent ${agentId} unknown, routing to Operator`);
    if (isAgentRegistered(AGENT_OPERATOR)) {
      const rerouted: Message = {
        ...msg,
        body: `[Rerouted: original to=${msg.to}] ${msg.body}`,
      };
      deliverToSynapse(AGENT_OPERATOR, rerouted);
      return { delivered: true };
    }
  }

  // Queue for later if agent not yet started
  if (!pendingQueues.has(agentId)) {
    pendingQueues.set(agentId, []);
  }
  pendingQueues.get(agentId)!.push(msg);
  return { delivered: true };
}

// Called by Synapse loop to drain pending messages
export function drainMessages(agentId: string): Message[] {
  const msgs = pendingQueues.get(agentId) ?? [];
  pendingQueues.set(agentId, []);
  return msgs;
}

// Deliver incoming cross-host message to local agent
export function deliverFromExchange(msg: Message): void {
  const { agentId } = parseAddress(msg.to);
  routeMessage({ ...msg, to: agentId }); // Strip host, deliver locally
}

export function getQueueDepth(agentId: string): number {
  return pendingQueues.get(agentId)?.length ?? 0;
}
