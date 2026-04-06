import { Database } from "bun:sqlite";
import { join, dirname } from "path";
import { mkdirSync, existsSync } from "fs";

const CONVERSATION_TTL_MS = 48 * 60 * 60 * 1000; // 48 hours
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

export function initConversationDb(claudePath: string): Database {
  const dbPath = join(claudePath, "conversation.db");
  mkdirSync(dirname(dbPath), { recursive: true });

  const db = new Database(dbPath);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");

  db.exec(`
    CREATE TABLE IF NOT EXISTS conversations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL,
      "from" TEXT NOT NULL,
      message TEXT NOT NULL,
      timestamp INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    )
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_conversations_created_at
    ON conversations(created_at)
  `);

  return db;
}

export function addConversationEntry(
  db: Database,
  entry: {
    type: "user" | "assistant" | "system";
    from: string;
    message: string;
    timestamp: number;
  }
): void {
  db.prepare(
    `INSERT INTO conversations (type, "from", message, timestamp, created_at)
     VALUES (?, ?, ?, ?, ?)`
  ).run(entry.type, entry.from, entry.message, entry.timestamp, Date.now());
}

export function getRecentEntries(
  db: Database,
  count: number
): Array<{
  id: number;
  type: string;
  from: string;
  message: string;
  timestamp: number;
  created_at: number;
}> {
  return db
    .prepare(
      `SELECT id, type, "from", message, timestamp, created_at
       FROM conversations
       ORDER BY created_at DESC
       LIMIT ?`
    )
    .all(count) as any[];
}

export function cleanupOldEntries(db: Database): number {
  const cutoff = Date.now() - CONVERSATION_TTL_MS;
  const result = db.prepare(
    "DELETE FROM conversations WHERE created_at < ?"
  ).run(cutoff);
  return result.changes;
}

export function startCleanupTimer(db: Database): ReturnType<typeof setInterval> {
  return setInterval(() => {
    const deleted = cleanupOldEntries(db);
    if (deleted > 0) {
      console.log(`[db] Cleaned up ${deleted} expired conversation entries`);
    }
  }, CLEANUP_INTERVAL_MS);
}
