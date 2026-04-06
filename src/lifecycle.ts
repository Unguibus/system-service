import { mkdirSync, cpSync, existsSync, readFileSync, writeFileSync, appendFileSync } from "fs";
import { join } from "path";
import { randomUUID } from "crypto";
import { createHash } from "crypto";
import type { AgentConfig, LifecycleResult } from "./types";
import { AGENTS_DIR } from "./types";
import { stopAgent, startAgent } from "./runtime";
import { registerAgentIAM, updateAgentWorkingDir } from "./iam";

function generateAgentId(name: string): string {
  const nonce = randomUUID();
  const now = Date.now().toString();
  return createHash("sha256")
    .update(`${name}:${now}:${nonce}`)
    .digest("hex")
    .slice(0, 16);
}

function agentHomeDir(agentId: string): string {
  return join(AGENTS_DIR, agentId);
}

function readAgentJson(agentDir: string): AgentConfig | null {
  const agentJsonPath = join(agentDir, "agent.json");
  if (!existsSync(agentJsonPath)) return null;
  try {
    return JSON.parse(readFileSync(agentJsonPath, "utf-8"));
  } catch {
    return null;
  }
}

function writeAgentJson(agentDir: string, config: AgentConfig): void {
  writeFileSync(
    join(agentDir, "agent.json"),
    JSON.stringify(config, null, 2)
  );
}

function ensureGitignore(dir: string): void {
  const gitignorePath = join(dir, '.gitignore');
  if (existsSync(gitignorePath)) {
    const content = readFileSync(gitignorePath, 'utf-8');
    if (!content.includes('.unguibus')) {
      appendFileSync(gitignorePath, '\n.unguibus\n');
    }
  } else {
    writeFileSync(gitignorePath, '.unguibus\n');
  }
}

// Create — new agent from scratch
export function createAgent(opts: {
  name: string;
  model?: AgentConfig["model"];
  effort?: AgentConfig["effort"];
  tags?: string[];
}): LifecycleResult & { agentId?: string } {
  const id = generateAgentId(opts.name);
  const agentDir = agentHomeDir(id);

  mkdirSync(agentDir, { recursive: true });

  const config: AgentConfig = {
    id,
    name: opts.name,
    tags: opts.tags ?? [],
    model: opts.model ?? "haiku",
    effort: opts.effort ?? "low",
    executionDelay: 2000,
    maxContextSize: 5,
    maxTurns: 25,
    assignedDir: null,
    archived: false,
  };

  writeAgentJson(agentDir, config);

  // Initialize empty status
  writeFileSync(join(agentDir, "synapse.status"), "idle");
  writeFileSync(join(agentDir, "last-run-output.txt"), "");

  // Register and start the agent
  registerAgentIAM(id, config.name, "agent", "system", null);
  startAgent(id, config);

  return { success: true, agentId: id };
}

// Onboard — bring existing .unguibus/agent.json under management
export function onboardAgent(targetDir: string): LifecycleResult & { agentId?: string } {
  const localAgentJson = join(targetDir, ".unguibus", "agent.json");
  if (!existsSync(localAgentJson)) {
    return { success: false, agentId: "", error: "No .unguibus/agent.json found in target directory" };
  }

  let partialConfig: Partial<AgentConfig>;
  try {
    partialConfig = JSON.parse(readFileSync(localAgentJson, "utf-8"));
  } catch {
    return { success: false, agentId: "", error: "Invalid agent.json in target directory" };
  }

  const name = partialConfig.name ?? targetDir.split("/").pop() ?? "unnamed";
  const id = partialConfig.id ?? generateAgentId(name);
  const agentDir = agentHomeDir(id);

  mkdirSync(agentDir, { recursive: true });

  const config: AgentConfig = {
    id,
    name,
    tags: partialConfig.tags ?? [],
    model: partialConfig.model ?? "haiku",
    effort: partialConfig.effort ?? "low",
    executionDelay: partialConfig.executionDelay ?? 2000,
    maxContextSize: partialConfig.maxContextSize ?? 5,
    maxTurns: partialConfig.maxTurns ?? 25,
    assignedDir: targetDir,
    archived: false,
  };

  writeAgentJson(agentDir, config);

  if (!existsSync(join(agentDir, "synapse.status"))) {
    writeFileSync(join(agentDir, "synapse.status"), "idle");
  }
  if (!existsSync(join(agentDir, "last-run-output.txt"))) {
    writeFileSync(join(agentDir, "last-run-output.txt"), "");
  }

  // Create .unguibus dir in target and add to gitignore
  mkdirSync(join(targetDir, ".unguibus"), { recursive: true });
  ensureGitignore(targetDir);

  registerAgentIAM(config.id, config.name, "agent", "system", config.assignedDir);
  startAgent(config.id, config);

  return { success: true, agentId: config.id };
}

// Assign — point agent at a target directory
export function assignAgent(agentId: string, targetDir: string): LifecycleResult {
  const agentDir = agentHomeDir(agentId);
  const config = readAgentJson(agentDir);

  if (!config) {
    return { success: false, agentId, error: "Agent not found" };
  }

  if (config.archived) {
    return { success: false, agentId, error: "Cannot assign an archived agent" };
  }

  // If target already has a .unguibus/agent.json, onboard that agent first
  if (existsSync(join(targetDir, ".unguibus", "agent.json"))) {
    const existingConfig = readAgentJson(join(targetDir, ".unguibus"));
    if (existingConfig?.id && existingConfig.id !== agentId) {
      // Unassign the existing agent first
      const unassignResult = unassignAgent(existingConfig.id);
      if (!unassignResult.success) {
        return { success: false, agentId, error: `Failed to unassign existing agent: ${unassignResult.error}` };
      }
    }
  }

  stopAgent(agentId);

  // Update config
  config.assignedDir = targetDir;
  writeAgentJson(agentDir, config);

  // Create .unguibus in target dir and add to gitignore
  mkdirSync(join(targetDir, ".unguibus"), { recursive: true });
  ensureGitignore(targetDir);

  updateAgentWorkingDir(agentId, targetDir);
  startAgent(agentId, config);

  return { success: true, agentId };
}

// Unassign — point agent back at its own dir
export function unassignAgent(agentId: string): LifecycleResult {
  const agentDir = agentHomeDir(agentId);
  const config = readAgentJson(agentDir);

  if (!config) {
    return { success: false, agentId, error: "Agent not found" };
  }

  stopAgent(agentId);

  config.assignedDir = null;
  writeAgentJson(agentDir, config);

  updateAgentWorkingDir(agentId, null);
  startAgent(agentId, config);

  return { success: true, agentId };
}

// Archive (was offboard) — stop and hide agent
export function archiveAgent(agentId: string): LifecycleResult {
  const agentDir = agentHomeDir(agentId);
  const config = readAgentJson(agentDir);

  if (!config) {
    return { success: false, agentId, error: "Agent not found" };
  }

  stopAgent(agentId);

  config.archived = true;
  writeAgentJson(agentDir, config);

  return { success: true, agentId };
}

// Unarchive — reactivate archived agent
export function unarchiveAgent(agentId: string): LifecycleResult {
  const agentDir = agentHomeDir(agentId);
  const config = readAgentJson(agentDir);

  if (!config) {
    return { success: false, agentId, error: "Agent not found" };
  }

  config.archived = false;
  writeAgentJson(agentDir, config);

  startAgent(agentId, config);

  return { success: true, agentId };
}

// Fork — copy agent to new ID
export function forkAgent(agentId: string): LifecycleResult & { forkId?: string } {
  const sourceDir = agentHomeDir(agentId);
  const sourceConfig = readAgentJson(sourceDir);

  if (!sourceConfig) {
    return { success: false, agentId, error: "Agent not found" };
  }

  const forkId = generateAgentId(`${sourceConfig.name}-fork`);
  const forkDir = agentHomeDir(forkId);

  cpSync(sourceDir, forkDir, { recursive: true });

  // Update fork's identity — unassigned, pointing at its own dir
  const forkConfig: AgentConfig = {
    ...sourceConfig,
    id: forkId,
    name: `${sourceConfig.name} (fork)`,
    assignedDir: null,
    archived: false,
  };
  writeAgentJson(forkDir, forkConfig);

  registerAgentIAM(forkId, forkConfig.name, "agent", "system", forkDir);
  startAgent(forkId, forkConfig);

  return { success: true, agentId, forkId };
}
