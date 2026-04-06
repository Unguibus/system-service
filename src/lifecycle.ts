import { mkdirSync, cpSync, existsSync, renameSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { randomUUID } from "crypto";
import { createHash } from "crypto";
import type { AgentConfig, AgentState, LifecycleResult } from "./types";
import { UNASSIGNED_DIR, OFFBOARDED_DIR } from "./types";
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

function agentClaudeDir(agentId: string): string {
  return join(UNASSIGNED_DIR, agentId, ".claude");
}

function readAgentJson(claudePath: string): AgentConfig | null {
  const agentJsonPath = join(claudePath, "agent.json");
  if (!existsSync(agentJsonPath)) return null;
  return JSON.parse(readFileSync(agentJsonPath, "utf-8"));
}

function writeAgentJson(claudePath: string, config: AgentConfig): void {
  writeFileSync(
    join(claudePath, "agent.json"),
    JSON.stringify(config, null, 2)
  );
}

// 3.1 Create — new agent from scratch
export function createAgent(opts: {
  name: string;
  model?: AgentConfig["model"];
  effort?: AgentConfig["effort"];
  tags?: string[];
}): LifecycleResult & { agentId?: string } {
  const id = generateAgentId(opts.name);
  const agentDir = join(UNASSIGNED_DIR, id);
  const claudeDir = join(agentDir, ".claude");

  mkdirSync(claudeDir, { recursive: true });

  const config: AgentConfig = {
    id,
    name: opts.name,
    tags: opts.tags ?? [],
    model: opts.model ?? "haiku",
    effort: opts.effort ?? "low",
    executionDelay: 2000,
    maxContextSize: 5,
    maxTurns: 25,
  };

  writeAgentJson(claudeDir, config);

  // Initialize empty status
  writeFileSync(join(claudeDir, "synapse.status"), "idle");
  writeFileSync(join(claudeDir, "last-run-output.txt"), "");

  // Register and start the agent
  registerAgentIAM(id, config.name, "agent", "system", agentDir);
  startAgent(id, agentDir, config);

  return { success: true, agentId: id };
}

// 3.2 Onboard — bring existing .claude/ under management
export function onboardAgent(targetDir: string): LifecycleResult & { agentId?: string } {
  const claudeDir = join(targetDir, ".claude");
  if (!existsSync(claudeDir)) {
    return { success: false, agentId: "", error: "No .claude/ directory found" };
  }

  // If already has agent.json with an ID, adopt it as-is
  const existing = readAgentJson(claudeDir);
  let config: AgentConfig;

  if (existing?.id) {
    config = existing;
  } else {
    const name = targetDir.split("/").pop() ?? "unnamed";
    const id = generateAgentId(name);
    config = {
      id,
      name,
      tags: [],
      model: "haiku",
      effort: "low",
      executionDelay: 2000,
      maxContextSize: 5,
    maxTurns: 25,
    };
    writeAgentJson(claudeDir, config);
  }

  // Enrich without disturbing existing files
  if (!existsSync(join(claudeDir, "synapse.status"))) {
    writeFileSync(join(claudeDir, "synapse.status"), "idle");
  }
  if (!existsSync(join(claudeDir, "last-run-output.txt"))) {
    writeFileSync(join(claudeDir, "last-run-output.txt"), "");
  }

  registerAgentIAM(config.id, config.name, "agent", "system", targetDir);
  startAgent(config.id, targetDir, config);

  return { success: true, agentId: config.id };
}

// 3.3 Assign — move unassigned agent into a target directory
// If the target already has a .claude/, onboard it first then unassign it
export function assignAgent(agentId: string, targetDir: string): LifecycleResult {
  const srcClaudeDir = join(UNASSIGNED_DIR, agentId, ".claude");
  const destClaudeDir = join(targetDir, ".claude");

  if (!existsSync(srcClaudeDir)) {
    return { success: false, agentId, error: "Agent not found in unassigned" };
  }

  // If target already has a .claude/, handle the existing agent
  if (existsSync(destClaudeDir)) {
    const existingConfig = readAgentJson(destClaudeDir);
    if (existingConfig?.id) {
      // Already managed — unassign it
      const unassignResult = unassignAgent(existingConfig.id, targetDir);
      if (!unassignResult.success) {
        return { success: false, agentId, error: `Failed to unassign existing agent: ${unassignResult.error}` };
      }
    } else {
      // Not managed — onboard first, then unassign
      const onboardResult = onboardAgent(targetDir);
      if (onboardResult.success && onboardResult.agentId) {
        const unassignResult = unassignAgent(onboardResult.agentId, targetDir);
        if (!unassignResult.success) {
          return { success: false, agentId, error: `Failed to unassign onboarded agent: ${unassignResult.error}` };
        }
      }
    }
  }

  stopAgent(agentId);
  renameSync(srcClaudeDir, destClaudeDir);

  // Clean up empty unassigned dir
  try {
    const { rmdirSync } = require("fs");
    rmdirSync(join(UNASSIGNED_DIR, agentId));
  } catch {}

  const config = readAgentJson(destClaudeDir);
  if (config) {
    updateAgentWorkingDir(agentId, targetDir);
    startAgent(agentId, targetDir, config);
  }

  return { success: true, agentId };
}

// 3.4 Unassign — move agent from working directory to unassigned
export function unassignAgent(agentId: string, currentDir: string): LifecycleResult {
  const srcClaudeDir = join(currentDir, ".claude");
  const destDir = join(UNASSIGNED_DIR, agentId);
  const destClaudeDir = join(destDir, ".claude");

  if (!existsSync(srcClaudeDir)) {
    return { success: false, agentId, error: "No .claude/ in current directory" };
  }

  stopAgent(agentId);
  mkdirSync(destDir, { recursive: true });
  renameSync(srcClaudeDir, destClaudeDir);

  const config = readAgentJson(destClaudeDir);
  if (config) {
    updateAgentWorkingDir(agentId, destDir);
    startAgent(agentId, destDir, config);
  }

  return { success: true, agentId };
}

// 3.5 Fork — copy agent, both keep running
export function forkAgent(agentId: string, sourceClaudeDir: string): LifecycleResult & { forkId?: string } {
  if (!existsSync(sourceClaudeDir)) {
    return { success: false, agentId, error: "Source .claude/ not found" };
  }

  const sourceConfig = readAgentJson(sourceClaudeDir);
  if (!sourceConfig) {
    return { success: false, agentId, error: "No agent.json in source" };
  }

  const forkId = generateAgentId(`${sourceConfig.name}-fork`);
  const forkDir = join(UNASSIGNED_DIR, forkId);
  const forkClaudeDir = join(forkDir, ".claude");

  mkdirSync(forkDir, { recursive: true });
  cpSync(sourceClaudeDir, forkClaudeDir, { recursive: true });

  // Update fork's identity
  const forkConfig: AgentConfig = {
    ...sourceConfig,
    id: forkId,
    name: `${sourceConfig.name} (fork)`,
  };
  writeAgentJson(forkClaudeDir, forkConfig);

  // Original keeps running — only start the fork
  startAgent(forkId, forkDir, forkConfig);

  return { success: true, agentId, forkId };
}

// 3.6 Offboard — remove from management
export function offboardAgent(agentId: string, currentClaudeDir: string): LifecycleResult {
  stopAgent(agentId);

  const destDir = join(OFFBOARDED_DIR, agentId);
  mkdirSync(destDir, { recursive: true });

  // If assigned, unassign first
  if (!currentClaudeDir.startsWith(UNASSIGNED_DIR)) {
    const tempDir = join(UNASSIGNED_DIR, agentId);
    mkdirSync(tempDir, { recursive: true });
    renameSync(currentClaudeDir, join(tempDir, ".claude"));
    renameSync(tempDir, destDir);
  } else {
    renameSync(join(UNASSIGNED_DIR, agentId), destDir);
  }

  return { success: true, agentId };
}
