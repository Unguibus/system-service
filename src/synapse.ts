import { readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";
import type { AgentConfig, Message } from "./types";
import { AGENTS_DIR } from "./types";
import {
  initAgentStore,
  addConversationEntry,
  getRecentEntries,
  closeAgentStore,
  type AgentStore,
} from "./conversation-db";
import { drainMessages } from "./messages";

interface SynapseState {
  config: AgentConfig;
  agentPath: string; // permanent home: ~/.unguibus/agents/<id>/
  store: AgentStore;
  batchTimer: ReturnType<typeof setTimeout> | null;
  pendingMessages: Message[];
  running: boolean;
  proc: ReturnType<typeof Bun.spawn> | null;
}

const synapses = new Map<string, SynapseState>();

function agentDataDir(agentId: string): string {
  return join(AGENTS_DIR, agentId);
}

function setStatus(agentPath: string, status: string): void {
  try {
    writeFileSync(join(agentPath, "synapse.status"), status);
  } catch {}
}

function getResumeContext(agentPath: string): string {
  const file = join(agentPath, "last-run-output.txt");
  if (!existsSync(file)) return "";
  try {
    return readFileSync(file, "utf-8").trim();
  } catch {
    return "";
  }
}

function saveLastOutput(agentPath: string, output: string): void {
  try {
    writeFileSync(join(agentPath, "last-run-output.txt"), output);
  } catch {}
}

function buildSystemPrompt(config: AgentConfig, resumeContext: string): string {
  let prompt = `You are ${config.name}, an autonomous agent managed by the unguibus system service.

You receive messages from other agents and from the user. Process them and take action.

CRITICAL RULE: Your plain text output is INVISIBLE. Nobody can see it. It is only recorded as internal thoughts. The ONLY way to communicate is by calling the send_message tool. Every response you want someone to see MUST go through send_message. If you want to reply to the user, call send_message with to="1". If you want to talk to another agent, call send_message with their ID.

NEVER just write a response in plain text and assume it was sent. It was NOT sent. You MUST call send_message.

Available tools:
- send_message(to, body): THE ONLY WAY TO COMMUNICATE. Call this for every reply.
- list_agents(): List all agents on the local host with their status.
- get_agent(agent_id): Get detailed info about a specific agent by ID.
- get_exchange_status(): Check if the cross-host exchange is connected.
- send_to_operator(host_id, body): Message a remote host's Operator.

Addressing for send_message:
- "1" = the user who messaged you. ALWAYS reply to "1" unless told otherwise.
- "<AGENT_ID>" = another agent on this host.
- "<AGENT_ID>@<HOST_ID>" = agent on another host.
- "0" = local Operator (routes unknown messages).
- "911" = Security.

Be proactive. Act on requests immediately. Don't ask clarifying questions unless truly ambiguous — just do the thing.`;

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
  const recentEntries = getRecentEntries(state.store, state.config.maxContextSize)
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
  const { config, agentPath, pendingMessages, store } = state;

  if (pendingMessages.length === 0) return;

  // Drain messages
  const messages = [...pendingMessages];
  state.pendingMessages = [];

  // Also drain any new messages that arrived via the queue
  const queuedMessages = drainMessages(config.id);
  messages.push(...queuedMessages);

  if (messages.length === 0) return;

  setStatus(agentPath, "running");
  state.running = true;

  // Store incoming messages in conversation.db
  for (const msg of messages) {
    addConversationEntry(store, {
      type: "user",
      from: msg.from,
      to: config.id,
      message: msg.body,
      timestamp: msg.timestamp,
    });
  }

  const resumeContext = getResumeContext(agentPath);
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

    // Write MCP config pointing to SSE endpoint on system-service
    const mcpConfigPath = join(agentPath, "mcp-config.json");
    const mcpConfig = {
      mcpServers: {
        unguibus: {
          type: "sse",
          url: `http://localhost:7272/mcp/${config.id}/sse`,
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
      "--allowedTools",
      "mcp__unguibus__send_message",
      "mcp__unguibus__list_agents",
      "mcp__unguibus__get_agent",
      "mcp__unguibus__get_exchange_status",
      "mcp__unguibus__send_to_operator",
    ];

    // Add system prompt
    args.push("--system-prompt", systemPrompt);

    // Spawn Claude with cwd = assignedDir (the working directory)
    const proc = Bun.spawn(args, {
      cwd: config.assignedDir,
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
      addConversationEntry(store, {
        type: "thought",
        from: config.name,
        message: output,
        timestamp: Date.now(),
      });

      // Save for resume context
      saveLastOutput(agentPath, output);

      console.log(
        `[synapse] ${config.name} responded (${output.length} chars)`
      );
    }

    setStatus(agentPath, "idle");
  } catch (err: any) {
    console.error(`[synapse] Error running Claude for ${config.name}: ${err.message}`);
    setStatus(agentPath, "error");
    saveLastOutput(agentPath, `Error: ${err.message}`);
  } finally {
    state.running = false;
    state.proc = null;
  }
}

function scheduleBatch(state: SynapseState): void {
  if (state.batchTimer) {
    console.log(`[synapse] Batch already scheduled for ${state.config.name}`);
    return;
  }

  const delay = state.config.executionDelay;
  console.log(`[synapse] Scheduling batch for ${state.config.name} in ${delay}ms`);

  setStatus(state.agentPath, "waiting");

  state.batchTimer = setTimeout(async () => {
    console.log(`[synapse] Batch timer fired for ${state.config.name}`);
    state.batchTimer = null;
    await executeClaudeRun(state);
  }, delay);
}

// Public API

export function initSynapse(
  agentId: string,
  config: AgentConfig
): void {
  const cPath = agentDataDir(agentId);
  const store = initAgentStore(cPath);

  const state: SynapseState = {
    config,
    agentPath: cPath,
    store,
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
  console.log(`[synapse] Delivered to ${state.config.name}, pending: ${state.pendingMessages.length}, running: ${state.running}, batchTimer: ${!!state.batchTimer}`);

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

  if (state.proc && !state.proc.killed) {
    state.proc.kill("SIGTERM");
  }

  closeAgentStore(state.store);
  synapses.delete(agentId);
  console.log(`[synapse] Stopped for ${state.config.name} (${agentId})`);
}

export function getSynapseState(agentId: string): SynapseState | undefined {
  return synapses.get(agentId);
}

export function addToAgentConversation(agentId: string, entry: {
  type: string;
  from: string;
  to?: string;
  message: string;
  timestamp: number;
}): void {
  const state = synapses.get(agentId);
  if (!state) return;
  addConversationEntry(state.store, entry as any);
}

export function getAgentConversations(agentId: string, limit: number = 50): any[] | null {
  const state = synapses.get(agentId);
  if (!state) return null;
  return getRecentEntries(state.store, limit);
}

export function isSynapseRunning(agentId: string): boolean {
  const state = synapses.get(agentId);
  return state?.running ?? false;
}
