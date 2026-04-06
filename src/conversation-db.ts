// Simple in-memory conversation store per agent
// No LokiJS, no SQLite — just arrays with TTL cleanup

const CONVERSATION_TTL_MS = 42 * 60 * 60 * 1000; // 42 hours

export interface ConversationEntry {
  type: "user" | "assistant" | "thought" | "system";
  from: string;
  to?: string;
  message: string;
  timestamp: number;
}

// Per-agent conversation history
const stores = new Map<string, ConversationEntry[]>();

export function initAgentStore(agentId: string): void {
  if (!stores.has(agentId)) {
    stores.set(agentId, []);
  }
}

export function addConversationEntry(agentId: string, entry: ConversationEntry): void {
  if (!stores.has(agentId)) stores.set(agentId, []);
  stores.get(agentId)!.push(entry);
}

export function getRecentEntries(agentId: string, count: number): ConversationEntry[] {
  const entries = stores.get(agentId) || [];
  return entries.slice(-count);
}

export function getAllEntries(agentId: string): ConversationEntry[] {
  return stores.get(agentId) || [];
}

export function closeAgentStore(agentId: string): void {
  stores.delete(agentId);
}

// Run periodically to clean up old entries across all agents
export function cleanupAllStores(): void {
  const cutoff = Date.now() - CONVERSATION_TTL_MS;
  for (const [agentId, entries] of stores) {
    stores.set(agentId, entries.filter(e => e.timestamp > cutoff));
  }
}

// Start cleanup timer
let cleanupTimer: ReturnType<typeof setInterval> | null = null;
export function startCleanupTimer(): void {
  if (cleanupTimer) return;
  cleanupTimer = setInterval(cleanupAllStores, 60 * 60 * 1000); // hourly
}
