/**
 * ACP (Agent Client Protocol) Types — Config + Runtime types.
 *
 * Config types support adapter generation (IDE registrations).
 * Runtime types support am as an ACP client (ADR-0026 Phase 1).
 *
 * SDK schema types are re-exported where appropriate; am-specific
 * wrapper types are defined here for the client/registry layers.
 */

import type {
  McpServer as AcpMcpServer,
  AgentCapabilities,
  ContentBlock,
  InitializeResponse,
  SessionId,
  SessionInfo,
  SessionNotification,
  SessionUpdate,
  StopReason,
  ToolCall,
  ToolCallUpdate,
  Usage,
} from "@agentclientprotocol/sdk";

// ── Re-exports for convenience ─────────────────────────────────

export type {
  AgentCapabilities,
  ContentBlock,
  AcpMcpServer,
  SessionId,
  SessionInfo,
  SessionNotification,
  SessionUpdate,
  StopReason,
  ToolCall,
  ToolCallUpdate,
  Usage,
};

// ── Config types (existing, for adapter generation) ────────────

/** ACP agent registration for IDE adapter config generation. */
export interface ACPAgentRegistration {
  name: string;
  description: string;
  endpoint: string;
  capabilities: string[];
  authentication?: {
    type: string;
    token?: string;
  };
}

/** Top-level ACP config section used in adapter TOML passthrough. */
export interface ACPConfig {
  agents: ACPAgentRegistration[];
}

/** ACP metadata stored in [agents.<name>.adapters.acp] passthrough. */
export interface ACPAdapterMetadata {
  slash_commands?: string[];
  context_awareness?: boolean;
  streaming?: boolean;
}

// ── Runtime types (new, for am as ACP client) ──────────────────

/** Options for connecting to an ACP agent subprocess. */
export interface ConnectOptions {
  /** Timeout for the initialize handshake in milliseconds. Default: 30000 */
  initTimeout?: number;
  /** Environment variables to pass to the agent subprocess. */
  env?: Record<string, string>;
  /** Arguments to append to the agent command. */
  args?: string[];
}

/** Options for creating a new ACP session. */
export interface NewSessionOptions {
  /** Working directory for the session. */
  cwd: string;
  /** MCP servers to connect to in this session. */
  mcpServers?: AcpMcpServer[];
  /** Additional workspace roots. */
  additionalDirectories?: string[];
}

/** A prompt part sent to the agent (text content block). */
export interface PromptPart {
  type: "text";
  text: string;
}

/** Result from a prompt turn. */
export interface PromptResult {
  /** Why the agent stopped. */
  stopReason: StopReason;
  /** Text content collected from agent_message_chunk updates. */
  text: string;
  /** Tool calls observed during this turn. */
  toolCalls: ToolCall[];
  /** Token usage (if reported by the agent). */
  usage?: Usage | null;
}

/** Callback for receiving session updates during a prompt. */
export type SessionUpdateHandler = (update: SessionUpdate) => void;

/** Represents a live ACP connection to an agent subprocess. */
export interface AcpConnection {
  /** The agent's name and version from initialize response. */
  agentInfo: InitializeResponse["agentInfo"];
  /** Capabilities the agent advertised. */
  capabilities: AgentCapabilities | undefined;
  /** Signal that aborts when the connection closes. */
  signal: AbortSignal;
  /** Promise that resolves when the connection closes. */
  closed: Promise<void>;
}

/** Agent registry entry: maps a name to a spawn command. */
export interface AgentRegistryEntry {
  /** The command to spawn the agent (e.g., "npx -y @agentclientprotocol/claude-agent-acp@latest"). */
  command: string;
  /** Source of the entry: "built-in" or "config". */
  source: "built-in" | "config";
}

/** ACP settings from the TOML config. */
export interface AcpSettings {
  /** Directory for session persistence. */
  session_dir?: string;
  /** Agent command overrides. */
  agents?: Record<string, { command: string }>;
}
