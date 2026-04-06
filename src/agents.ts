import { readdirSync, existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import type { AgentConfig, AgentState } from "./types";
import { AGENTS_DIR } from "./types";
import { getAgentStatus } from "./runtime";
import { startAgent } from "./runtime";
import { registerAgentIAM } from "./iam";

// Registry: maps agentId -> AgentConfig (cache, source of truth is agent.json)
const registry = new Map<string, AgentConfig>();

export function registerAgent(agentId: string, config: AgentConfig): void {
  registry.set(agentId, config);
}

export function unregisterAgent(agentId: string): void {
  registry.delete(agentId);
}

export function isAgentRegistered(agentId: string): boolean {
  return registry.has(agentId);
}

function agentHomeDir(agentId: string): string {
  return join(AGENTS_DIR, agentId);
}

function readAgentConfig(agentDir: string): AgentConfig | null {
  const agentJsonPath = join(agentDir, "agent.json");
  if (!existsSync(agentJsonPath)) return null;
  try {
    return JSON.parse(readFileSync(agentJsonPath, "utf-8"));
  } catch {
    return null;
  }
}

function agentLocation(config: AgentConfig): "assigned" | "unassigned" | "archived" {
  if (config.archived) return "archived";
  if (!config.assignedDir) return "unassigned";
  return "assigned";
}

export function getAgent(agentId: string): AgentState | null {
  const agentDir = agentHomeDir(agentId);
  const config = readAgentConfig(agentDir);
  if (!config) return null;

  const loc = agentLocation(config);

  return {
    config,
    status: getAgentStatus(agentId) as AgentState["status"],
    pid: null,
    location: loc,
    assignedPath: loc === "assigned" ? config.assignedDir : null,
    agentPath: agentDir,
  };
}

// Resolve an ID that might be an assignedId alias to the real agent ID
export function resolveAgentId(idOrAlias: string): string | null {
  if (registry.has(idOrAlias)) return idOrAlias;
  // Check assignedId aliases
  for (const [agentId, config] of registry) {
    if (config.assignedId === idOrAlias) return agentId;
  }
  return null;
}

export function listAgents(): AgentState[] {
  const agents: AgentState[] = [];
  for (const [agentId] of registry) {
    const state = getAgent(agentId);
    if (state) agents.push(state);
  }
  return agents;
}

// Update agent config (partial update, writes to agent.json)
export function updateAgentConfig(
  agentId: string,
  updates: Partial<AgentConfig>
): AgentState | null {
  const agentDir = agentHomeDir(agentId);
  const config = readAgentConfig(agentDir);
  if (!config) return null;

  // Apply allowed updates
  if (updates.name !== undefined) config.name = updates.name;
  if (updates.model !== undefined) config.model = updates.model;
  if (updates.effort !== undefined) config.effort = updates.effort;
  if (updates.executionDelay !== undefined) config.executionDelay = updates.executionDelay;
  if (updates.maxContextSize !== undefined) config.maxContextSize = updates.maxContextSize;
  if (updates.maxTurns !== undefined) config.maxTurns = updates.maxTurns;
  if (updates.assignedId !== undefined) config.assignedId = updates.assignedId;
  if (updates.tags !== undefined) config.tags = updates.tags;

  writeFileSync(join(agentDir, "agent.json"), JSON.stringify(config, null, 2));

  // Update cache
  registry.set(agentId, config);

  return getAgent(agentId);
}

// Scan ~/.unguibus/agents/ to discover agents on startup
export function discoverAgents(): void {
  if (!existsSync(AGENTS_DIR)) return;

  for (const entry of readdirSync(AGENTS_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const agentDir = join(AGENTS_DIR, entry.name);
    const config = readAgentConfig(agentDir);
    if (!config) continue;

    registry.set(config.id, config);

    if (!config.archived) {
      registerAgentIAM(config.id, config.name, "agent", "system", config.assignedDir);
      startAgent(config.id, config);
    }
  }

  console.log(`[agents] Discovered ${registry.size} agent(s), started non-archived`);
}
