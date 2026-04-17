/**
 * A2A Protocol Types — Agent-to-Agent Protocol v0.3.0
 *
 * Types for Google/Linux Foundation AAIF's A2A specification.
 * See: a2a-protocol.org/v0.3.0/specification
 */

// ── Agent Card ──────────────────────────────────────────────────

/** A2A Agent Card — advertises agent capabilities via /.well-known/agent-card.json */
export interface AgentCard {
  /**
   * A2A protocol version this agent implements (e.g. "0.3.0"). REQUIRED as
   * of v0.3 AgentCard schema.
   */
  protocolVersion?: string;
  name: string;
  description: string;
  version: string;
  url: string;
  /**
   * Preferred transport hint for clients. v0.3 defines a transport registry;
   * we use "http+jsonrpc" to indicate JSON-RPC 2.0 over HTTP(S) POST.
   */
  preferredTransport?: string;
  provider?: AgentProvider;
  capabilities: AgentCapabilities;
  skills: AgentSkill[];
  /** Legacy v0.2 authentication list. Retained for backward compatibility. */
  authentication?: AuthenticationScheme[];
  /**
   * v0.3 OpenAPI-style security schemes. A map from scheme name to its
   * description. Clients use this plus `security` to decide how to auth.
   */
  securitySchemes?: Record<string, SecurityScheme>;
  /** v0.3 `security` requirement list (matches OpenAPI convention). */
  security?: Array<Record<string, string[]>>;
  /**
   * v0.3 flag: when true, the agent exposes an extended card via an
   * authenticated endpoint with more detail than the public one.
   */
  supportsAuthenticatedExtendedCard?: boolean;
  defaultInputModes?: string[];
  defaultOutputModes?: string[];
}

/** OpenAPI-style security scheme (v0.3). */
export interface SecurityScheme {
  type: "http" | "apiKey" | "oauth2" | "openIdConnect";
  /** For type=http: "bearer", "basic", etc. */
  scheme?: string;
  /** For type=apiKey: header/query/cookie name. */
  name?: string;
  /** For type=apiKey: where the key is passed. */
  in?: "header" | "query" | "cookie";
  description?: string;
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
