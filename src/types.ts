// Agent identity and configuration (stored in agent.json)
export interface AgentConfig {
  id: string;
  name: string;
  tags: string[];
  model: "haiku" | "sonnet" | "opus";
  effort: "low" | "medium" | "high" | "max";
  executionDelay: number;
  maxContextSize: number;
}

// Agent runtime state (computed, not persisted)
export interface AgentState {
  config: AgentConfig;
  status: "idle" | "running" | "waiting" | "error";
  pid: number | null;
  location: "assigned" | "unassigned" | "offboarded";
  assignedPath: string | null; // null if unassigned
  claudePath: string; // full path to .claude/ directory
}

// Message envelope
export interface Message {
  to: string;
  from: string;
  type: string;
  body: string;
  timestamp: number;
}

// Lifecycle operation results
export interface LifecycleResult {
  success: boolean;
  agentId: string;
  error?: string;
}

// Reserved agent IDs
export const AGENT_OPERATOR = "0";
export const AGENT_USER = "1";
export const AGENT_SECURITY = "911";

// Paths
export const UNGUIBUS_HOME = `${process.env.HOME}/.unguibus`;
export const UNASSIGNED_DIR = `${UNGUIBUS_HOME}/unassigned`;
export const OFFBOARDED_DIR = `${UNGUIBUS_HOME}/offboarded`;
export const SYSTEM_DB_PATH = `${UNGUIBUS_HOME}/system-service.db`;
