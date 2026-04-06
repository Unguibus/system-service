import Loki from "lokijs";
import { join } from "path";
import { mkdirSync } from "fs";

const CONVERSATION_TTL_MS = 42 * 60 * 60 * 1000; // 42 hours
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
const SNAPSHOT_INTERVAL_MS = 60 * 1000; // 60 seconds

export interface ConversationEntry {
  type: "user" | "assistant" | "thought" | "system";
  from: string;
  to?: string;
  message: string;
  timestamp: number;
  created_at: number;
}

export interface AgentStore {
  db: Loki;
  conversations: Collection<ConversationEntry>;
  snapshotTimer: ReturnType<typeof setInterval>;
  cleanupTimer: ReturnType<typeof setInterval>;
}

export function initAgentStore(claudePath: string): AgentStore {
  mkdirSync(claudePath, { recursive: true });
  const dbPath = join(claudePath, "state.json");

  const db = new Loki(dbPath, {
    autoload: true,
    autosave: false, // We handle snapshots manually
    autoloadCallback: () => {
      // Ensure collection exists after load
      if (!db.getCollection("conversations")) {
        db.addCollection("conversations", {
          indices: ["created_at", "type", "from"],
        });
      }
      // Cleanup expired entries on load
      cleanupOldEntries(db.getCollection("conversations")!);
    },
  });

  // Wait for autoload to finish — LokiJS calls the callback synchronously
  let conversations = db.getCollection<ConversationEntry>("conversations");
  if (!conversations) {
    conversations = db.addCollection("conversations", {
      indices: ["created_at", "type", "from"],
    });
  }

  // Periodic snapshot to disk
  const snapshotTimer = setInterval(() => {
    db.saveDatabase();
  }, SNAPSHOT_INTERVAL_MS);

  // Periodic TTL cleanup
  const cleanupTimer = setInterval(() => {
    const deleted = cleanupOldEntries(conversations!);
    if (deleted > 0) {
      console.log(`[store] Cleaned up ${deleted} expired entries`);
      db.saveDatabase();
    }
  }, CLEANUP_INTERVAL_MS);

  // Initial save
  db.saveDatabase();

  return { db, conversations, snapshotTimer, cleanupTimer };
}

export function addConversationEntry(
  store: AgentStore,
  entry: {
    type: ConversationEntry["type"];
    from: string;
    to?: string;
    message: string;
    timestamp: number;
  }
): void {
  store.conversations.insert({
    ...entry,
    created_at: Date.now(),
  });
}

export function getRecentEntries(
  store: AgentStore,
  count: number
): ConversationEntry[] {
  return store.conversations
    .chain()
    .simplesort("created_at", { desc: true })
    .limit(count)
    .data()
    .reverse();
}

export function getEntriesByType(
  store: AgentStore,
  type: ConversationEntry["type"],
  count: number
): ConversationEntry[] {
  return store.conversations
    .chain()
    .find({ type })
    .simplesort("created_at", { desc: true })
    .limit(count)
    .data()
    .reverse();
}

export function getConversationWith(
  store: AgentStore,
  otherAgentId: string,
  count: number
): ConversationEntry[] {
  return store.conversations
    .chain()
    .find({
      $or: [{ from: otherAgentId }, { to: otherAgentId }],
    })
    .simplesort("created_at", { desc: true })
    .limit(count)
    .data()
    .reverse();
}

function cleanupOldEntries(collection: Collection<ConversationEntry>): number {
  const cutoff = Date.now() - CONVERSATION_TTL_MS;
  const old = collection.find({ created_at: { $lt: cutoff } });
  old.forEach((entry) => collection.remove(entry));
  return old.length;
}

export function closeAgentStore(store: AgentStore): void {
  clearInterval(store.snapshotTimer);
  clearInterval(store.cleanupTimer);
  store.db.saveDatabase();
  store.db.close();
}
