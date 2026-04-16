/**
 * A2A Protocol Types — Agent-to-Agent Protocol v0.3.0
 *
 * Types for Google/Linux Foundation AAIF's A2A specification.
 * See: a2a-protocol.org/v0.3.0/specification
 */

// ── Agent Card ──────────────────────────────────────────────────

/** A2A Agent Card — advertises agent capabilities via /.well-known/agent.json */
export interface AgentCard {
  name: string;
  description: string;
  version: string;
  url: string;
  provider?: AgentProvider;
  capabilities: AgentCapabilities;
  skills: AgentSkill[];
  authentication?: AuthenticationScheme[];
  defaultInputModes?: string[];
  defaultOutputModes?: string[];
}

export interface AgentProvider {
  organization: string;
  url?: string;
}

export interface AgentCapabilities {
  streaming?: boolean;
  pushNotifications?: boolean;
  stateTransitionHistory?: boolean;
}

export interface AgentSkill {
  id: string;
  name: string;
  description: string;
  inputModes?: string[];
  outputModes?: string[];
  tags?: string[];
}

export interface AuthenticationScheme {
  type: "bearer" | "api-key" | "oauth2" | "none";
  description?: string;
}

// ── Task Types ──────────────────────────────────────────────────

export type TaskState =
  | "submitted"
  | "working"
  | "input-required"
  | "completed"
  | "canceled"
  | "failed";

export interface Task {
  id: string;
  status: TaskStatus;
  artifacts?: Artifact[];
  history?: Message[];
  metadata?: Record<string, unknown>;
}

export interface TaskStatus {
  state: TaskState;
  message?: Message;
  timestamp: string;
}

// ── Message Types ───────────────────────────────────────────────

export interface Message {
  role: "user" | "agent";
  parts: Part[];
  metadata?: Record<string, unknown>;
}

export type Part = TextPart | FilePart | DataPart;

export interface TextPart {
  type: "text";
  text: string;
}

export interface FilePart {
  type: "file";
  file: {
    name: string;
    mimeType: string;
    bytes?: string;
    uri?: string;
  };
}

export interface DataPart {
  type: "data";
  data: Record<string, unknown>;
}

// ── Artifact ────────────────────────────────────────────────────

export interface Artifact {
  name: string;
  description?: string;
  parts: Part[];
  metadata?: Record<string, unknown>;
}

// ── JSON-RPC Method Params ──────────────────────────────────────

export interface TaskSendParams {
  id: string;
  message: Message;
  metadata?: Record<string, unknown>;
}

export interface TaskQueryParams {
  id: string;
  historyLength?: number;
}

export interface TaskCancelParams {
  id: string;
}

export interface PushNotificationConfig {
  url: string;
  token?: string;
  authentication?: AuthenticationScheme;
}

// ── JSON-RPC Envelope ───────────────────────────────────────────

export interface A2AJsonRpcRequest {
  jsonrpc: "2.0";
  id: string | number;
  method: string;
  params?: Record<string, unknown>;
}

export interface A2AJsonRpcResponse {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: unknown;
  error?: A2AJsonRpcError;
}

export interface A2AJsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

// ── SSE Streaming Events (tasks/sendSubscribe) ────────────────────

/** SSE event sent when a task's status changes. */
export interface TaskStatusUpdateEvent {
  id: string;
  status: TaskStatus;
  /** True when the task has reached a terminal state and the stream will close. */
  final: boolean;
}

/** SSE event sent when a task produces an artifact. */
export interface TaskArtifactUpdateEvent {
  id: string;
  artifact: Artifact;
}

// ── Agent Roster (local discovery) ──────────────────────────────

export interface AgentRosterEntry {
  name: string;
  url: string;
  description?: string;
  addedAt: string;
  lastSeen?: string;
  card?: AgentCard;
}
