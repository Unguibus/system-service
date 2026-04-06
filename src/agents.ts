import { readdirSync, existsSync, readFileSync } from "fs";
import { join } from "path";
import type { AgentConfig, AgentState } from "./types";
import { UNASSIGNED_DIR, OFFBOARDED_DIR } from "./types";
import { getAgentStatus } from "./runtime";

// Registry: maps agentId -> current working directory
const registry = new Map<string, string>();

export function registerAgent(agentId: string, workingDir: string): void {
  registry.set(agentId, workingDir);
}

export function unregisterAgent(agentId: string): void {
  registry.delete(agentId);
}

export function getAgentWorkingDir(agentId: string): string | null {
  return registry.get(agentId) ?? null;
}

function readAgentConfig(claudePath: string): AgentConfig | null {
  const agentJsonPath = join(claudePath, "agent.json");
  if (!existsSync(agentJsonPath)) return null;
  try {
    return JSON.parse(readFileSync(agentJsonPath, "utf-8"));
  } catch {
    return null;
  }
}

function agentLocation(workingDir: string): "assigned" | "unassigned" | "offboarded" {
  if (workingDir.startsWith(UNASSIGNED_DIR)) return "unassigned";
  if (workingDir.startsWith(OFFBOARDED_DIR)) return "offboarded";
  return "assigned";
}

export function getAgent(agentId: string): AgentState | null {
  const workingDir = registry.get(agentId);
  if (!workingDir) return null;

  const claudePath = join(workingDir, ".claude");
  const config = readAgentConfig(claudePath);
  if (!config) return null;

  return {
    config,
    status: getAgentStatus(agentId) as AgentState["status"],
    pid: null, // TODO: get from runtime
    location: agentLocation(workingDir),
    assignedPath: agentLocation(workingDir) === "assigned" ? workingDir : null,
    claudePath,
  };
}

export function listAgents(): AgentState[] {
  const agents: AgentState[] = [];

  for (const [agentId] of registry) {
    const state = getAgent(agentId);
    if (state) agents.push(state);
  }

  return agents;
}

// Scan filesystem to discover agents on startup
export function discoverAgents(): void {
  // Scan unassigned
  if (existsSync(UNASSIGNED_DIR)) {
    for (const entry of readdirSync(UNASSIGNED_DIR, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const claudePath = join(UNASSIGNED_DIR, entry.name, ".claude");
      if (!existsSync(join(claudePath, "agent.json"))) continue;

      const config = readAgentConfig(claudePath);
      if (config) {
        registry.set(config.id, join(UNASSIGNED_DIR, entry.name));
      }
    }
  }

  // TODO: Scan for assigned agents (need a way to track which directories have managed agents)
  // For now, assigned agents are tracked in-memory only after onboard/assign operations

  console.log(`[agents] Discovered ${registry.size} agent(s)`);
}
