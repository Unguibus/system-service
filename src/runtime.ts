import { readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";
import type { AgentConfig } from "./types";
import { AGENTS_DIR } from "./types";
import { initSynapse, stopSynapse, isSynapseRunning } from "./synapse";
import { registerAgent, unregisterAgent } from "./agents";

interface ManagedAgent {
  config: AgentConfig;
  crashCount: number;
  lastCrashTime: number;
  intentionalStop: boolean;
  started: boolean;
}

const managed = new Map<string, ManagedAgent>();

function agentHomeDir(agentId: string): string {
  return join(AGENTS_DIR, agentId);
}

function setStatus(agentId: string, status: string): void {
  const statusFile = join(agentHomeDir(agentId), "synapse.status");
  try {
    writeFileSync(statusFile, status);
  } catch {}
}

export function startAgent(
  agentId: string,
  config: AgentConfig
): void {
  const existing = managed.get(agentId);
  if (existing?.started) return;

  const agent: ManagedAgent = {
    config,
    crashCount: existing?.crashCount ?? 0,
    lastCrashTime: existing?.lastCrashTime ?? 0,
    intentionalStop: false,
    started: true,
  };

  managed.set(agentId, agent);
  registerAgent(agentId, config);

  // Initialize the Synapse runtime loop for this agent
  initSynapse(agentId, config);

  console.log(`[runtime] Started agent ${config.name} (${agentId}) in ${config.assignedDir}`);
}

export function stopAgent(agentId: string): void {
  const agent = managed.get(agentId);
  if (!agent) return;

  agent.intentionalStop = true;
  agent.started = false;

  stopSynapse(agentId);
  unregisterAgent(agentId);

  setStatus(agentId, "idle");
  managed.delete(agentId);

  console.log(`[runtime] Stopped agent ${agent.config.name} (${agentId})`);
}

export function getAgentStatus(agentId: string): string {
  const agent = managed.get(agentId);
  if (!agent) return "stopped";

  const statusFile = join(agentHomeDir(agentId), "synapse.status");
  if (existsSync(statusFile)) {
    try {
      return readFileSync(statusFile, "utf-8").trim();
    } catch {}
  }
  return "unknown";
}

export function isAgentRunning(agentId: string): boolean {
  return isSynapseRunning(agentId);
}

export function getManagedAgent(agentId: string): ManagedAgent | undefined {
  return managed.get(agentId);
}

export function getAllManagedAgents(): Map<string, ManagedAgent> {
  return managed;
}
