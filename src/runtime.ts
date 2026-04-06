import { readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";
import type { AgentConfig } from "./types";

interface ManagedProcess {
  proc: ReturnType<typeof Bun.spawn> | null;
  config: AgentConfig;
  workingDir: string;
  crashCount: number;
  lastCrashTime: number;
  intentionalStop: boolean;
}

const processes = new Map<string, ManagedProcess>();

function claudeDir(workingDir: string): string {
  return join(workingDir, ".claude");
}

function setStatus(workingDir: string, status: string): void {
  const statusFile = join(claudeDir(workingDir), "synapse.status");
  try {
    writeFileSync(statusFile, status);
  } catch {}
}

function getResumeContext(workingDir: string): string {
  const file = join(claudeDir(workingDir), "last-run-output.txt");
  if (!existsSync(file)) return "";
  try {
    return readFileSync(file, "utf-8").trim();
  } catch {
    return "";
  }
}

function backoffMs(crashCount: number): number {
  if (crashCount <= 1) return 5000;
  if (crashCount === 2) return 10000;
  if (crashCount === 3) return 20000;
  return 60000;
}

export function startAgent(
  agentId: string,
  workingDir: string,
  config: AgentConfig
): void {
  const existing = processes.get(agentId);
  if (existing?.proc && !existing.proc.killed) {
    return; // Already running
  }

  const managed: ManagedProcess = {
    proc: null,
    config,
    workingDir,
    crashCount: existing?.crashCount ?? 0,
    lastCrashTime: existing?.lastCrashTime ?? 0,
    intentionalStop: false,
  };

  processes.set(agentId, managed);
  spawnSynapse(agentId, managed);
}

function spawnSynapse(agentId: string, managed: ManagedProcess): void {
  const { config, workingDir } = managed;
  const resumeContext = getResumeContext(workingDir);

  const env: Record<string, string> = {
    ...process.env as Record<string, string>,
    AGENT_ID: agentId,
    AGENT_NAME: config.name,
    CLAUDE_MODEL: config.model,
    CLAUDE_EFFORT: config.effort,
    EXECUTION_DELAY: config.executionDelay.toString(),
    MAX_CONTEXT_SIZE: config.maxContextSize.toString(),
  };

  if (resumeContext) {
    env.RESUME_CONTEXT = resumeContext;
  }

  setStatus(workingDir, "idle");

  // TODO: Replace with actual Synapse loop (SSE subscribe, batch, spawn claude)
  // For now, this is a placeholder that starts claude in the working directory
  const bunPath = `${process.env.HOME}/.local/bin/bun`;

  console.log(`[runtime] Starting agent ${config.name} (${agentId}) in ${workingDir}`);

  // The actual Synapse loop will be implemented here.
  // For now we just track the managed process entry.
  managed.proc = null; // Will be set when Synapse loop is implemented

  // Watch for crashes
  watchForCrash(agentId, managed);
}

function watchForCrash(agentId: string, managed: ManagedProcess): void {
  if (!managed.proc) return;

  managed.proc.exited.then((exitCode) => {
    if (managed.intentionalStop) return;

    console.log(
      `[runtime] Agent ${managed.config.name} (${agentId}) exited with code ${exitCode}`
    );

    managed.crashCount++;
    managed.lastCrashTime = Date.now();

    // Reset crash count if agent was stable for 5 minutes
    const timeSinceLastCrash = Date.now() - managed.lastCrashTime;
    if (timeSinceLastCrash > 5 * 60 * 1000) {
      managed.crashCount = 1;
    }

    const delay = backoffMs(managed.crashCount);
    setStatus(managed.workingDir, "error");

    console.log(
      `[runtime] Restarting ${managed.config.name} in ${delay}ms (crash #${managed.crashCount})`
    );

    setTimeout(() => {
      if (!managed.intentionalStop) {
        spawnSynapse(agentId, managed);
      }
    }, delay);
  });
}

export function stopAgent(agentId: string): void {
  const managed = processes.get(agentId);
  if (!managed) return;

  managed.intentionalStop = true;

  if (managed.proc && !managed.proc.killed) {
    managed.proc.kill("SIGTERM");

    // Force kill after 10 seconds
    setTimeout(() => {
      if (managed.proc && !managed.proc.killed) {
        managed.proc.kill("SIGKILL");
      }
    }, 10000);
  }

  setStatus(managed.workingDir, "idle");
  processes.delete(agentId);
}

export function getAgentStatus(agentId: string): string {
  const managed = processes.get(agentId);
  if (!managed) return "stopped";

  const statusFile = join(claudeDir(managed.workingDir), "synapse.status");
  if (existsSync(statusFile)) {
    try {
      return readFileSync(statusFile, "utf-8").trim();
    } catch {}
  }
  return "unknown";
}

export function isAgentRunning(agentId: string): boolean {
  const managed = processes.get(agentId);
  return !!managed?.proc && !managed.proc.killed;
}

export function getAllManagedAgents(): Map<string, ManagedProcess> {
  return processes;
}
