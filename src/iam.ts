import { Database } from "bun:sqlite";
import { SYSTEM_DB_PATH, AGENT_USER, AGENT_OPERATOR, AGENT_SECURITY } from "./types";
import { mkdirSync } from "fs";
import { dirname } from "path";

let db: Database;

// All known permissions
export const RUNTIME_PERMISSIONS = [
  "disk.read", "disk.write", "web.access", "code.execute",
  "model.haiku", "model.sonnet", "model.opus",
  "effort.low", "effort.medium", "effort.high", "effort.max",
] as const;

export const PLATFORM_PERMISSIONS = [
  "agent.create", "agent.onboard", "agent.assign", "agent.unassign",
  "agent.fork", "agent.offboard", "agent.stop", "agent.isolate",
  "agent.roster",
  "message.local", "message.crosshost", "message.crosshost.911",
  "message.crosshost.operator",
  "exchange.manage",
  "roles.grant", "roles.revoke",
  "host.block",
] as const;

export type Permission = typeof RUNTIME_PERMISSIONS[number] | typeof PLATFORM_PERMISSIONS[number];

// Built-in role definitions
const BUILT_IN_ROLES: Record<string, Permission[]> = {
  admin: [...RUNTIME_PERMISSIONS, ...PLATFORM_PERMISSIONS],

  security: [
    "model.haiku", "effort.low", "disk.read",
    "agent.stop", "agent.isolate", "agent.roster",
    "message.local", "message.crosshost.911", "host.block",
  ],

  operator: [
    "model.haiku", "effort.low", "disk.read",
    "agent.roster", "message.local",
    "message.crosshost.911", "message.crosshost.operator",
  ],

  agent: [
    "model.haiku", "effort.low", "disk.read", "disk.write",
    "message.local",
  ],
};

export function initIAM(): void {
  mkdirSync(dirname(SYSTEM_DB_PATH), { recursive: true });
  db = new Database(SYSTEM_DB_PATH);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");

  db.exec(`
    CREATE TABLE IF NOT EXISTS agents (
      agent_id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'agent',
      working_dir TEXT,
      created_at INTEGER NOT NULL,
      created_by TEXT NOT NULL
    )
  `);

  // Migration: add working_dir if missing
  try {
    db.exec("ALTER TABLE agents ADD COLUMN working_dir TEXT");
  } catch {}  // Column already exists

  db.exec(`
    CREATE TABLE IF NOT EXISTS permissions (
      agent_id TEXT NOT NULL,
      permission TEXT NOT NULL,
      granted_by TEXT NOT NULL,
      granted_at INTEGER NOT NULL,
      PRIMARY KEY (agent_id, permission)
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS role_templates (
      template_name TEXT PRIMARY KEY,
      created_by TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS role_template_permissions (
      template_name TEXT NOT NULL,
      permission TEXT NOT NULL,
      PRIMARY KEY (template_name, permission),
      FOREIGN KEY (template_name) REFERENCES role_templates(template_name) ON DELETE CASCADE
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS iam_audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp INTEGER NOT NULL,
      actor_id TEXT NOT NULL,
      action TEXT NOT NULL,
      target_agent_id TEXT,
      permission TEXT,
      note TEXT
    )
  `);

  // Seed built-in roles as templates
  for (const [roleName, perms] of Object.entries(BUILT_IN_ROLES)) {
    const existing = db.prepare(
      "SELECT template_name FROM role_templates WHERE template_name = ?"
    ).get(roleName);

    if (!existing) {
      db.prepare(
        "INSERT INTO role_templates (template_name, created_by, created_at) VALUES (?, ?, ?)"
      ).run(roleName, "system", Date.now());

      const insert = db.prepare(
        "INSERT OR IGNORE INTO role_template_permissions (template_name, permission) VALUES (?, ?)"
      );
      for (const perm of perms) {
        insert.run(roleName, perm);
      }
    }
  }

  console.log("[iam] IAM database initialized");
}

export function registerAgentIAM(
  agentId: string,
  name: string,
  role: string,
  createdBy: string,
  workingDir?: string
): void {
  db.prepare(
    "INSERT OR REPLACE INTO agents (agent_id, name, role, working_dir, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?)"
  ).run(agentId, name, role, workingDir ?? null, Date.now(), createdBy);

  // Apply role template permissions
  const templatePerms = db
    .prepare(
      "SELECT permission FROM role_template_permissions WHERE template_name = ?"
    )
    .all(role) as { permission: string }[];

  const insert = db.prepare(
    "INSERT OR IGNORE INTO permissions (agent_id, permission, granted_by, granted_at) VALUES (?, ?, ?, ?)"
  );
  for (const { permission } of templatePerms) {
    insert.run(agentId, permission, createdBy, Date.now());
  }

  auditLog(createdBy, "register", agentId, null, `Role: ${role}`);
}

export function updateAgentWorkingDir(agentId: string, workingDir: string | null): void {
  db.prepare("UPDATE agents SET working_dir = ? WHERE agent_id = ?").run(workingDir, agentId);
}

export function getAllRegisteredAgents(): Array<{ agent_id: string; name: string; working_dir: string | null }> {
  return db.prepare("SELECT agent_id, name, working_dir FROM agents").all() as any[];
}

export function getEffectivePermissions(agentId: string): Permission[] {
  // Admin (user) has all permissions
  if (agentId === AGENT_USER) {
    return [...RUNTIME_PERMISSIONS, ...PLATFORM_PERMISSIONS];
  }

  const rows = db
    .prepare("SELECT permission FROM permissions WHERE agent_id = ?")
    .all(agentId) as { permission: string }[];

  return rows.map((r) => r.permission as Permission);
}

export function hasPermission(agentId: string, permission: Permission): boolean {
  if (agentId === AGENT_USER) return true;
  const row = db
    .prepare(
      "SELECT 1 FROM permissions WHERE agent_id = ? AND permission = ?"
    )
    .get(agentId, permission);
  return !!row;
}

export function grantPermission(
  actorId: string,
  targetId: string,
  permission: Permission
): { success: boolean; error?: string } {
  // Check actor has the permission they're granting
  if (!hasPermission(actorId, permission)) {
    return { success: false, error: "Cannot grant permission you don't have" };
  }
  if (!hasPermission(actorId, "roles.grant")) {
    return { success: false, error: "No roles.grant permission" };
  }

  db.prepare(
    "INSERT OR IGNORE INTO permissions (agent_id, permission, granted_by, granted_at) VALUES (?, ?, ?, ?)"
  ).run(targetId, permission, actorId, Date.now());

  auditLog(actorId, "grant", targetId, permission, null);
  return { success: true };
}

export function revokePermission(
  actorId: string,
  targetId: string,
  permission: Permission
): { success: boolean; error?: string } {
  if (!hasPermission(actorId, "roles.revoke")) {
    return { success: false, error: "No roles.revoke permission" };
  }

  db.prepare(
    "DELETE FROM permissions WHERE agent_id = ? AND permission = ?"
  ).run(targetId, permission);

  auditLog(actorId, "revoke", targetId, permission, null);
  return { success: true };
}

export function getAgentRole(agentId: string): string | null {
  const row = db
    .prepare("SELECT role FROM agents WHERE agent_id = ?")
    .get(agentId) as { role: string } | null;
  return row?.role ?? null;
}

export function getAuditLog(
  limit = 50
): Array<{
  timestamp: number;
  actor_id: string;
  action: string;
  target_agent_id: string | null;
  permission: string | null;
  note: string | null;
}> {
  return db
    .prepare(
      "SELECT * FROM iam_audit_log ORDER BY timestamp DESC LIMIT ?"
    )
    .all(limit) as any[];
}

function auditLog(
  actorId: string,
  action: string,
  targetId: string | null,
  permission: string | null,
  note: string | null
): void {
  db.prepare(
    "INSERT INTO iam_audit_log (timestamp, actor_id, action, target_agent_id, permission, note) VALUES (?, ?, ?, ?, ?, ?)"
  ).run(Date.now(), actorId, action, targetId, permission, note);
}

// Get Claude spawn flags based on agent permissions
export function getSpawnFlags(agentId: string): string[] {
  const perms = getEffectivePermissions(agentId);
  const flags: string[] = [];

  // Model selection (highest allowed)
  if (perms.includes("model.opus")) flags.push("--model", "opus");
  else if (perms.includes("model.sonnet")) flags.push("--model", "sonnet");
  else if (perms.includes("model.haiku")) flags.push("--model", "haiku");

  // Disk permissions
  if (!perms.includes("disk.write")) {
    // Read-only mode
  }
  if (!perms.includes("disk.read")) {
    // No disk access
  }

  // Web access
  if (!perms.includes("web.access")) {
    flags.push("--disallowed-tools", "WebFetch,WebSearch");
  }

  // Code execution
  if (!perms.includes("code.execute")) {
    flags.push("--disallowed-tools", "Bash");
  }

  return flags;
}

export function closeIAM(): void {
  if (db) db.close();
}
