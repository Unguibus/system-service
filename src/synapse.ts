import { readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";
import type { AgentConfig, Message } from "./types";
import { AGENTS_DIR, getEffectiveDir } from "./types";
import {
  initAgentStore,
  addConversationEntry,
  getRecentEntries,
  closeAgentStore,
} from "./conversation-db";

interface SynapseState {
  config: AgentConfig;
  agentPath: string;
  lastAckTimestamp: number;
  running: boolean;
  stopped: boolean;
  proc: ReturnType<typeof Bun.spawn> | null;
}

const synapses = new Map<string, SynapseState>();

// Per-agent message inbox (messages waiting to be fetched)
const inboxes = new Map<string, Message[]>();

function agentDataDir(agentId: string): string {
  return join(AGENTS_DIR, agentId);
}

function setStatus(agentPath: string, status: string): void {
  try {
    writeFileSync(join(agentPath, "synapse.status"), status);
  } catch {}
}

function saveLastOutput(agentPath: string, output: string): void {
  try {
    writeFileSync(join(agentPath, "last-run-output.txt"), output);
  } catch {}
}

function buildSystemPrompt(config: AgentConfig): string {
  return `You are ${config.name}, an autonomous agent managed by the unguibus system service.

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
}

function buildPrompt(messages: Message[]): string {
  let prompt = "--- NEW MESSAGES ---\n";
  for (const msg of messages) {
    prompt += `From: ${msg.from}\nType: ${msg.type}\nMessage: ${msg.body}\n\n`;
  }
  return prompt;
}

// --- Inbox API (called by message router) ---

export function deliverToInbox(agentId: string, msg: Message): void {
  if (!inboxes.has(agentId)) inboxes.set(agentId, []);
  inboxes.get(agentId)!.push(msg);
}

export function fetchNewMessages(agentId: string, since: number): Message[] {
  const inbox = inboxes.get(agentId) || [];
  return inbox.filter(m => m.timestamp > since);
}

export function ackMessages(agentId: string, upToTimestamp: number): void {
  const inbox = inboxes.get(agentId) || [];
  inboxes.set(agentId, inbox.filter(m => m.timestamp > upToTimestamp));
}

// Fetch new messages and ack in one call (for MCP tool)
export function fetchNewAndAck(agentId: string): Message[] {
  const state = synapses.get(agentId);
  const since = state?.lastAckTimestamp ?? 0;
  const messages = fetchNewMessages(agentId, since);
  if (messages.length > 0) {
    const maxTs = Math.max(...messages.map(m => m.timestamp));
    ackMessages(agentId, maxTs);
    if (state) state.lastAckTimestamp = maxTs;
  }
  return messages;
}

// --- Claude execution ---

async function runClaude(state: SynapseState, messages: Message[]): Promise<boolean> {
  const { config, agentPath } = state;

  setStatus(agentPath, "running");
  state.running = true;

  // Store incoming messages in conversation store
  for (const msg of messages) {
    addConversationEntry(config.id, {
      type: "user",
      from: msg.from,
      to: config.id,
      message: msg.body,
      timestamp: msg.timestamp,
    });
  }

  const claudePath = process.env.CLAUDE_PATH ?? `${process.env.HOME}/.local/bin/claude`;

  // Write MCP config
  const mcpConfigPath = join(agentPath, "mcp-config.json");
  writeFileSync(mcpConfigPath, JSON.stringify({
    mcpServers: {
      unguibus: {
        type: "sse",
        url: `http://localhost:7272/mcp/${config.id}/sse`,
      },
    },
  }));

  const args = [
    claudePath,
    "--model", config.model,
    "--print",
    "--output-format", "json",
    "--max-turns", String(config.maxTurns || 25),
    "--mcp-config", mcpConfigPath,
    "--allowedTools",
    "mcp__unguibus__send_message",
    "mcp__unguibus__list_agents",
    "mcp__unguibus__get_agent",
    "mcp__unguibus__get_exchange_status",
    "mcp__unguibus__send_to_operator",
  ];

  if (config.sessionId) {
    args.push("--resume", config.sessionId);
  }

  args.push("--system-prompt", buildSystemPrompt(config));


  const userPrompt = buildPrompt(messages);

  try {
    const proc = Bun.spawn(args, {
      cwd: getEffectiveDir(config),
      stdin: new Blob([userPrompt]),
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, CLAUDE_MODEL: config.model },
    });

    state.proc = proc;

    // Session-busy detection: 10s timeout
    let timedOut = false;
    const busyTimer = setTimeout(() => {
      timedOut = true;
      proc.kill("SIGTERM");
    }, 10000);

    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    await proc.exited;
    clearTimeout(busyTimer);

    state.proc = null;

    if (timedOut) {
      console.log(`[synapse] Session busy for ${config.name}, will retry`);
      setStatus(agentPath, "idle");
      state.running = false;
      return false; // Don't ack — retry later
    }

    if (stderr && !stdout) {
      console.error(`[synapse] Claude error for ${config.name}: ${stderr.slice(0, 200)}`);
      setStatus(agentPath, "error");
      state.running = false;
      return false;
    }

    // Parse output
    let output = "";
    try {
      const jsonOut = JSON.parse(stdout);
      output = jsonOut.result || "";
      if (jsonOut.session_id && jsonOut.session_id !== config.sessionId) {
        config.sessionId = jsonOut.session_id;
        writeFileSync(join(agentPath, "agent.json"), JSON.stringify(config, null, 2));
      }
    } catch {
      output = stdout.trim();
    }

    if (output) {
      addConversationEntry(config.id, {
        type: "thought",
        from: config.name,
        message: output,
        timestamp: Date.now(),
      });
      saveLastOutput(agentPath, output);
      console.log(`[synapse] ${config.name} responded (${output.length} chars)`);
    }

    setStatus(agentPath, "idle");
    state.running = false;
    return true; // Success — ack messages

  } catch (err: any) {
    console.error(`[synapse] Error for ${config.name}: ${err.message}`);
    setStatus(agentPath, "error");
    saveLastOutput(agentPath, `Error: ${err.message}`);
    state.running = false;
    return false;
  }
}

// --- Main polling loop ---

async function synapseLoop(state: SynapseState): Promise<void> {
  const { config } = state;
  const pollInterval = config.executionDelay || 1000;
  const errorRetryInterval = 10000;

  console.log(`[synapse] Loop started for ${config.name} (poll: ${pollInterval}ms)`);

  while (!state.stopped) {
    // Fetch new messages since last ack
    const messages = fetchNewMessages(config.id, state.lastAckTimestamp);

    if (messages.length > 0) {
      console.log(`[synapse] ${config.name} has ${messages.length} new message(s)`);
      const success = await runClaude(state, messages);

      if (success) {
        // Ack messages
        const maxTs = Math.max(...messages.map(m => m.timestamp));
        ackMessages(config.id, maxTs);
        state.lastAckTimestamp = maxTs;
      } else {
        // Error or session busy — wait longer before retry
        await sleep(errorRetryInterval);
      }
    } else {
      // No messages — wait and poll again
      await sleep(pollInterval);
    }
  }

  console.log(`[synapse] Loop stopped for ${config.name}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// --- Public API ---

export function initSynapse(agentId: string, config: AgentConfig): void {
  const agentPath = agentDataDir(agentId);
  initAgentStore(agentId);

  const state: SynapseState = {
    config,
    agentPath,
    lastAckTimestamp: Date.now(), // Start from now — don't process old messages
    running: false,
    stopped: false,
    proc: null,
  };

  synapses.set(agentId, state);
  if (!inboxes.has(agentId)) inboxes.set(agentId, []);
  setStatus(agentPath, "idle");
  console.log(`[synapse] Initialized for ${config.name} (${agentId})`);

  // Start the polling loop
  synapseLoop(state);
}

export function stopSynapse(agentId: string): void {
  const state = synapses.get(agentId);
  if (!state) return;

  state.stopped = true;

  if (state.proc && !state.proc.killed) {
    state.proc.kill("SIGTERM");
  }

  closeAgentStore(state.config.id);
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
  addConversationEntry(agentId, entry as any);
}

export function getAgentConversations(agentId: string, limit: number = 50): any[] | null {
  return getRecentEntries(agentId, limit);
}

export function isSynapseRunning(agentId: string): boolean {
  const state = synapses.get(agentId);
  return state?.running ?? false;
}
