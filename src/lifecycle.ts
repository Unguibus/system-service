import { mkdirSync, cpSync, existsSync, readFileSync, readdirSync, writeFileSync, appendFileSync, statSync } from "fs";
import { join, basename } from "path";
import { randomUUID } from "crypto";
import { createHash } from "crypto";
import { execSync } from "child_process";
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
    sessionId: null,
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

// Convert a directory path to Claude's project folder name
function dirToClaudeProjectName(dir: string): string {
  return dir.replace(/\//g, "-");
}

// Find all Claude sessions for a directory
function findClaudeSessions(targetDir: string): Array<{ sessionId: string; mtime: number }> {
  const projectName = dirToClaudeProjectName(targetDir);
  const projectDir = join(process.env.HOME || "~", ".claude", "projects", projectName);

  if (!existsSync(projectDir)) return [];

  return readdirSync(projectDir)
    .filter(f => f.endsWith(".jsonl"))
    .map(f => ({
      sessionId: basename(f, ".jsonl"),
      mtime: statSync(join(projectDir, f)).mtimeMs,
    }))
    .sort((a, b) => b.mtime - a.mtime); // newest first
}

// Ask a session what its name should be
function askSessionForName(sessionId: string, targetDir: string): string {
  const claudePath = process.env.CLAUDE_PATH ?? `${process.env.HOME}/.local/bin/claude`;

  try {
    const result = execSync(
      `echo "You are being onboarded into a new agent management system. Respond with ONLY a short name for yourself (2-4 words, no quotes, no explanation). Base it on what you were working on." | ${claudePath} --print --resume ${sessionId} --model haiku --max-turns 1 --output-format text`,
      {
        cwd: targetDir,
        timeout: 30000,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      }
    );
    const name = result.trim().replace(/["\n]/g, "").slice(0, 50);
    return name || "unnamed-agent";
  } catch {
    return "unnamed-agent";
  }
}

// Onboard — discover all Claude sessions for a directory and create agents
export async function onboardAgent(targetDir: string): Promise<LifecycleResult & { agentIds?: string[] }> {
  if (!existsSync(targetDir)) {
    return { success: false, agentId: "", error: "Directory not found" };
  }

  const sessions = findClaudeSessions(targetDir);
  if (sessions.length === 0) {
    return { success: false, agentId: "", error: "No Claude sessions found for this directory" };
  }

  // Create .unguibus dir in target and add to gitignore
  mkdirSync(join(targetDir, ".unguibus"), { recursive: true });
  ensureGitignore(targetDir);

  const agentIds: string[] = [];

  for (const session of sessions) {
    const id = session.sessionId; // Use session ID as agent ID

    // Skip if already onboarded
    const agentDir = agentHomeDir(id);
    if (existsSync(join(agentDir, "agent.json"))) {
      agentIds.push(id);
      continue;
    }

    console.log(`[onboard] Asking session ${id} for its name...`);
    const name = askSessionForName(id, targetDir);
    console.log(`[onboard] Session ${id} → "${name}"`);

    mkdirSync(agentDir, { recursive: true });

    const config: AgentConfig = {
      id,
      name,
      tags: ["onboarded"],
      model: "haiku",
      effort: "low",
      executionDelay: 2000,
      maxContextSize: 5,
      maxTurns: 25,
      assignedDir: targetDir,
      sessionId: id, // session ID = agent ID for onboarded agents
      archived: false,
    };

    writeAgentJson(agentDir, config);
    writeFileSync(join(agentDir, "synapse.status"), "idle");
    writeFileSync(join(agentDir, "last-run-output.txt"), "");

    registerAgentIAM(id, name, "agent", "system", targetDir);
    startAgent(id, config);
    agentIds.push(id);
  }

  return { success: true, agentId: agentIds[0] || "", agentIds };
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
    sessionId: null,
    archived: false,
  };
  writeAgentJson(forkDir, forkConfig);

  registerAgentIAM(forkId, forkConfig.name, "agent", "system", forkDir);
  startAgent(forkId, forkConfig);

  return { success: true, agentId, forkId };
}
