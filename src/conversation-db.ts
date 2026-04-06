// SQLite-backed conversation store — survives restarts
// Single DB at ~/.unguibus/messages.db for all agents

import { Database } from "bun:sqlite";
import { UNGUIBUS_HOME } from "./types";
import { join } from "path";
import { mkdirSync } from "fs";

const CONVERSATION_TTL_MS = 42 * 60 * 60 * 1000;
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000;

export interface ConversationEntry {
  type: "user" | "assistant" | "thought" | "system";
  from: string;
  to?: string;
  message: string;
  timestamp: number;
}

let db: Database;

export function initMessageDb(): void {
  mkdirSync(UNGUIBUS_HOME, { recursive: true });
  db = new Database(join(UNGUIBUS_HOME, "messages.db"));
  db.exec("PRAGMA journal_mode = WAL");

  db.exec(`
    CREATE TABLE IF NOT EXISTS conversations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id TEXT NOT NULL,
      type TEXT NOT NULL,
      "from" TEXT NOT NULL,
      "to" TEXT,
      message TEXT NOT NULL,
      timestamp INTEGER NOT NULL
    )
  `);

  db.exec(`CREATE INDEX IF NOT EXISTS idx_conv_agent ON conversations(agent_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_conv_timestamp ON conversations(timestamp)`);

  db.exec(`
    CREATE TABLE IF NOT EXISTS inbox (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id TEXT NOT NULL,
      "from" TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'message',
      body TEXT NOT NULL,
      timestamp INTEGER NOT NULL
    )
  `);

  db.exec(`CREATE INDEX IF NOT EXISTS idx_inbox_agent ON inbox(agent_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_inbox_timestamp ON inbox(timestamp)`);

  // Initial cleanup
  cleanup();
}

// --- Inbox (pending messages for agents) ---

export function addToInbox(agentId: string, msg: { from: string; type: string; body: string; timestamp: number }): void {
  db.prepare(
    `INSERT INTO inbox (agent_id, "from", type, body, timestamp) VALUES (?, ?, ?, ?, ?)`
  ).run(agentId, msg.from, msg.type, msg.body, msg.timestamp);
}

export function getInboxSince(agentId: string, since: number): Array<{ from: string; type: string; body: string; timestamp: number }> {
  return db.prepare(
    `SELECT "from", type, body, timestamp FROM inbox WHERE agent_id = ? AND timestamp > ? ORDER BY timestamp ASC`
  ).all(agentId, since) as any[];
}

export function ackInbox(agentId: string, upToTimestamp: number): void {
  db.prepare(`DELETE FROM inbox WHERE agent_id = ? AND timestamp <= ?`).run(agentId, upToTimestamp);
}

export function initAgentStore(agentId: string): void {
  // No-op — single shared DB, no per-agent init needed
}

export function addConversationEntry(agentId: string, entry: ConversationEntry): void {
  db.prepare(
    `INSERT INTO conversations (agent_id, type, "from", "to", message, timestamp) VALUES (?, ?, ?, ?, ?, ?)`
  ).run(agentId, entry.type, entry.from, entry.to ?? null, entry.message, entry.timestamp);
}

export function getRecentEntries(agentId: string, count: number): ConversationEntry[] {
  return db.prepare(
    `SELECT type, "from", "to", message, timestamp FROM conversations WHERE agent_id = ? ORDER BY timestamp DESC LIMIT ?`
  ).all(agentId, count).reverse() as ConversationEntry[];
}

export function getAllEntries(agentId: string): ConversationEntry[] {
  return db.prepare(
    `SELECT type, "from", "to", message, timestamp FROM conversations WHERE agent_id = ? ORDER BY timestamp ASC`
  ).all(agentId) as ConversationEntry[];
}

export function closeAgentStore(agentId: string): void {
  // No-op — shared DB stays open
}

function cleanup(): void {
  const cutoff = Date.now() - CONVERSATION_TTL_MS;
  const result = db.prepare("DELETE FROM conversations WHERE timestamp < ?").run(cutoff);
  if (result.changes > 0) {
    console.log(`[db] Cleaned up ${result.changes} expired conversation entries`);
  }
}

export function startCleanupTimer(): void {
  setInterval(cleanup, CLEANUP_INTERVAL_MS);
}
