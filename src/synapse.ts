import { readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";
import type { AgentConfig, Message } from "./types";
import {
  initConversationDb,
  addConversationEntry,
  getRecentEntries,
  startCleanupTimer,
} from "./conversation-db";
import { drainMessages } from "./messages";
import type { Database } from "bun:sqlite";

interface SynapseState {
  config: AgentConfig;
  workingDir: string;
  claudePath: string;
  db: Database;
  cleanupTimer: ReturnType<typeof setInterval>;
  batchTimer: ReturnType<typeof setTimeout> | null;
  pendingMessages: Message[];
  running: boolean;
  proc: ReturnType<typeof Bun.spawn> | null;
}

const synapses = new Map<string, SynapseState>();

function claudeDir(workingDir: string): string {
  return join(workingDir, ".claude");
}

function setStatus(claudePath: string, status: string): void {
  try {
    writeFileSync(join(claudePath, "synapse.status"), status);
  } catch {}
}

function getResumeContext(claudePath: string): string {
  const file = join(claudePath, "last-run-output.txt");
  if (!existsSync(file)) return "";
  try {
    return readFileSync(file, "utf-8").trim();
  } catch {
    return "";
  }
}

function saveLastOutput(claudePath: string, output: string): void {
  try {
    writeFileSync(join(claudePath, "last-run-output.txt"), output);
  } catch {}
}

function buildSystemPrompt(config: AgentConfig, resumeContext: string): string {
  let prompt = `You are ${config.name}, an autonomous agent managed by the unguibus system service.

You receive messages from other agents and from the user. Process them and take action.

IMPORTANT: Your text output is internal thought only — it is NOT sent to anyone. You MUST use the send_message tool to communicate. If someone messages you, use send_message to reply. If you just think out loud without calling send_message, nobody will see your response.

You have MCP tools available:
- send_message: Send a message to an agent or the user. You MUST use this to reply.
- list_agents: List all agents on the local host with their status.
- get_agent: Get detailed info about a specific agent by ID.
- get_exchange_status: Check if the cross-host exchange is connected and get this host's ID.
- send_to_operator: Message a remote host's Operator when you don't know the target agent.

Addressing:
- <AGENT_ID> for local delivery
- <AGENT_ID>@<HOST_ID> for cross-host delivery
- 0 for local Operator (when you don't know who to message)
- 1 for the user (this is who sent you a message unless otherwise specified)
- 911 for Security

Be proactive. Don't wait for instructions unless you have nothing to do.`;

  if (resumeContext) {
    prompt += `\n\n[RESUMING FROM PREVIOUS RUN]\nLast output was:\n${resumeContext}\n\nYou may have been interrupted mid-execution. Check if your previous action completed.`;
  }

  return prompt;
}

function buildPrompt(
  state: SynapseState,
  messages: Message[],
  resumeContext: string
): string {
  const recentEntries = getRecentEntries(state.db, state.config.maxContextSize)
    .reverse();

  let prompt = "";

  // Add conversation history
  if (recentEntries.length > 0) {
    prompt += "--- CONVERSATION HISTORY ---\n";
    for (const entry of recentEntries) {
      const time = new Date(entry.created_at).toISOString().slice(11, 19);
      prompt += `[${time}] ${entry.type} (${entry.from}): ${entry.message}\n`;
    }
    prompt += "\n";
  }

  // Add current messages
  if (messages.length > 0) {
    prompt += "--- INCOMING MESSAGES ---\n";
    for (const msg of messages) {
      prompt += `From: ${msg.from}\nType: ${msg.type}\nMessage: ${msg.body}\n\n`;
    }
  }

  return prompt;
}

async function executeClaudeRun(state: SynapseState): Promise<void> {
  const { config, claudePath, workingDir, pendingMessages, db } = state;

  if (pendingMessages.length === 0) return;

  // Drain messages
  const messages = [...pendingMessages];
  state.pendingMessages = [];

  // Also drain any new messages that arrived via the queue
  const queuedMessages = drainMessages(config.id);
  messages.push(...queuedMessages);

  if (messages.length === 0) return;

  setStatus(claudePath, "running");
  state.running = true;

  // Store incoming messages in conversation.db
  for (const msg of messages) {
    addConversationEntry(db, {
      type: "user",
      from: msg.from,
      message: msg.body,
      timestamp: msg.timestamp,
    });
  }

  const resumeContext = getResumeContext(claudePath);
  const systemPrompt = buildSystemPrompt(config, resumeContext);
  const userPrompt = buildPrompt(state, messages, resumeContext);

  console.log(
    `[synapse] Running Claude for ${config.name} (${messages.length} message(s))`
  );

  try {
    // Find claude executable
    const claudePath_exec =
      process.env.CLAUDE_PATH ??
      `${process.env.HOME}/.local/bin/claude`;

    // Write MCP config for this agent
    const mcpConfigPath = join(state.claudePath, "mcp-config.json");
    const bunPath = `${process.env.HOME}/.bun/bin/bun`;
    const mcpStdioPath = join(import.meta.dir, "mcp-stdio.ts");
    const mcpConfig = {
      mcpServers: {
        unguibus: {
          command: bunPath,
          args: ["run", mcpStdioPath, config.id],
        },
      },
    };
    writeFileSync(mcpConfigPath, JSON.stringify(mcpConfig));

    const args = [
      claudePath_exec,
      "--model", config.model,
      "--print",
      "--output-format", "text",
      "--max-turns", String(config.maxTurns || 25),
      "--mcp-config", mcpConfigPath,
    ];

    // Add system prompt
    args.push("--system-prompt", systemPrompt);

    // Spawn Claude
    const proc = Bun.spawn(args, {
      cwd: workingDir,
      stdin: new Blob([userPrompt]),
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        CLAUDE_MODEL: config.model,
      },
    });

    state.proc = proc;

    // Collect output
    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;

    if (stderr && exitCode !== 0) {
      console.error(`[synapse] Claude error for ${config.name}: ${stderr.slice(0, 200)}`);
    }

    const output = stdout.trim();

    if (output) {
      // Store response in conversation.db
      addConversationEntry(db, {
        type: "thought",
        from: config.name,
        message: output,
        timestamp: Date.now(),
      });

      // Save for resume context
      saveLastOutput(state.claudePath, output);

      console.log(
        `[synapse] ${config.name} responded (${output.length} chars)`
      );
    }

    setStatus(state.claudePath, "idle");
  } catch (err: any) {
    console.error(`[synapse] Error running Claude for ${config.name}: ${err.message}`);
    setStatus(state.claudePath, "error");
    saveLastOutput(state.claudePath, `Error: ${err.message}`);
  } finally {
    state.running = false;
    state.proc = null;
  }
}

function scheduleBatch(state: SynapseState): void {
  if (state.batchTimer) return; // Already scheduled

  const delay = state.config.executionDelay;

  setStatus(state.claudePath, "waiting");

  state.batchTimer = setTimeout(async () => {
    state.batchTimer = null;
    await executeClaudeRun(state);
  }, delay);
}

// Public API

export function initSynapse(
  agentId: string,
  workingDir: string,
  config: AgentConfig
): void {
  const cPath = claudeDir(workingDir);
  const db = initConversationDb(cPath);
  const cleanupTimer = startCleanupTimer(db);

  const state: SynapseState = {
    config,
    workingDir,
    claudePath: cPath,
    db,
    cleanupTimer,
    batchTimer: null,
    pendingMessages: [],
    running: false,
    proc: null,
  };

  synapses.set(agentId, state);
  setStatus(cPath, "idle");
  console.log(`[synapse] Initialized for ${config.name} (${agentId})`);
}

export function deliverToSynapse(agentId: string, msg: Message): void {
  const state = synapses.get(agentId);
  if (!state) {
    console.warn(`[synapse] No synapse for agent ${agentId}, queueing`);
    return;
  }

  state.pendingMessages.push(msg);

  // If not currently running, schedule batch
  if (!state.running) {
    scheduleBatch(state);
  }
  // If running, messages will be picked up after current run completes
}

export function stopSynapse(agentId: string): void {
  const state = synapses.get(agentId);
  if (!state) return;

  if (state.batchTimer) {
    clearTimeout(state.batchTimer);
  }
  clearInterval(state.cleanupTimer);

  if (state.proc && !state.proc.killed) {
    state.proc.kill("SIGTERM");
  }

  state.db.close();
  synapses.delete(agentId);
  console.log(`[synapse] Stopped for ${state.config.name} (${agentId})`);
}

export function getSynapseState(agentId: string): SynapseState | undefined {
  return synapses.get(agentId);
}

export function addToAgentConversation(agentId: string, entry: {
  type: string;
  from: string;
  message: string;
  timestamp: number;
}): void {
  const state = synapses.get(agentId);
  if (!state) return;
  addConversationEntry(state.db, entry as any);
}

export function getAgentConversations(agentId: string, limit: number = 50): any[] | null {
  const state = synapses.get(agentId);
  if (!state) return null;
  return getRecentEntries(state.db, limit).reverse();
}

export function isSynapseRunning(agentId: string): boolean {
  const state = synapses.get(agentId);
  return state?.running ?? false;
}
