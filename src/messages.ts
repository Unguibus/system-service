import type { Message } from "./types";
import { AGENT_OPERATOR, AGENT_USER, AGENT_SECURITY } from "./types";

// In-memory message queue per agent (delivered on next Synapse batch)
const queues = new Map<string, Message[]>();

// Callback for cross-host delivery (set when Exchange is connected)
let crossHostSend: ((msg: Message) => void) | null = null;

export function setCrossHostSender(fn: (msg: Message) => void): void {
  crossHostSend = fn;
}

function isLocalAddress(address: string): boolean {
  return !address.includes("@");
}

function parseAddress(address: string): { agentId: string; hostId?: string } {
  if (address.includes("@")) {
    const [agentId, hostId] = address.split("@", 2);
    return { agentId, hostId };
  }
  return { agentId: address };
}

export function routeMessage(msg: Message): { delivered: boolean; error?: string } {
  const { agentId, hostId } = parseAddress(msg.to);

  // Cross-host: forward to Exchange
  if (hostId) {
    if (!crossHostSend) {
      return { delivered: false, error: "Exchange not connected" };
    }
    crossHostSend(msg);
    return { delivered: true };
  }

  // Local delivery: queue for the target agent
  enqueueLocal(agentId, msg);
  return { delivered: true };
}

function enqueueLocal(agentId: string, msg: Message): void {
  if (!queues.has(agentId)) {
    queues.set(agentId, []);
  }
  queues.get(agentId)!.push(msg);
}

// Called by Synapse loop to drain pending messages
export function drainMessages(agentId: string): Message[] {
  const msgs = queues.get(agentId) ?? [];
  queues.set(agentId, []);
  return msgs;
}

// Deliver incoming cross-host message to local agent
export function deliverFromExchange(msg: Message): void {
  const { agentId } = parseAddress(msg.to);
  const localId = agentId; // Strip host from address for local delivery

  // If agent unknown locally, route to Operator
  // TODO: Check agent registry
  enqueueLocal(localId, msg);
}

export function getQueueDepth(agentId: string): number {
  return queues.get(agentId)?.length ?? 0;
}
