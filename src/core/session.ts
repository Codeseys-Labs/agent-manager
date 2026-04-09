/**
 * Core session types and utilities for cross-tool session harvest (ADR-0016).
 *
 * Defines the unified session model, the SessionReader interface that adapters
 * implement, and pure functions for filtering, formatting, and estimation.
 */

// ── Message Types ──────────────────────────────────────────────

export interface ToolCall {
  name: string;
  input?: unknown;
  output?: string;
}

export interface Message {
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  timestamp?: Date;
  toolCalls?: ToolCall[];
}

// ── Session Types ──────────────────────────────────────────────

export interface Session {
  id: string;
  adapter: string;
  project?: string;
  messages: Message[];
  startedAt: Date;
  endedAt?: Date;
  metadata?: Record<string, unknown>;
}

export interface SessionSummary {
  id: string;
  adapter: string;
  project?: string;
  messageCount: number;
  startedAt: Date;
  endedAt?: Date;
  estimatedTokens?: number;
}

// ── SessionReader Interface ────────────────────────────────────

export interface SessionReader {
  /** Check if session storage exists for this tool. */
  hasSessionStorage(): boolean;

  /** List sessions, optionally filtered by project path. */
  listSessions(project?: string): Promise<SessionSummary[]>;

  /** Fully load a session with all messages. */
  loadSession(id: string): Promise<Session | null>;
}

// ── Filter / Selector Types ────────────────────────────────────

export interface SessionFilter {
  /** Only include messages with these roles. */
  roles?: Message["role"][];
  /** Strip tool-role messages. */
  noTools?: boolean;
  /** Strip system-role messages. */
  noSystem?: boolean;
  /** Text search — keep only messages whose content includes the query. */
  query?: string;
}

// ── Pure Functions ─────────────────────────────────────────────

/**
 * Filter messages according to the given filter criteria.
 * Filters are applied in order: roles → noTools → noSystem → query.
 */
export function filterMessages(messages: Message[], filter: SessionFilter): Message[] {
  let result = messages;

  if (filter.roles && filter.roles.length > 0) {
    const allowed = new Set(filter.roles);
    result = result.filter((m) => allowed.has(m.role));
  }

  if (filter.noTools) {
    result = result.filter((m) => m.role !== "tool");
  }

  if (filter.noSystem) {
    result = result.filter((m) => m.role !== "system");
  }

  if (filter.query) {
    const q = filter.query.toLowerCase();
    result = result.filter((m) => m.content.toLowerCase().includes(q));
  }

  return result;
}

/**
 * Format a session as markdown.
 * Applies the optional filter before formatting.
 */
export function formatMarkdown(session: Session, filter?: SessionFilter): string {
  const messages = filter ? filterMessages(session.messages, filter) : session.messages;

  const lines: string[] = [];

  lines.push(`# Session ${session.id}`);
  lines.push("");
  lines.push(`**Adapter:** ${session.adapter}`);
  if (session.project) {
    lines.push(`**Project:** ${session.project}`);
  }
  lines.push(`**Started:** ${session.startedAt.toISOString()}`);
  if (session.endedAt) {
    lines.push(`**Ended:** ${session.endedAt.toISOString()}`);
  }
  lines.push(`**Messages:** ${messages.length}`);
  lines.push("");
  lines.push("---");
  lines.push("");

  for (const msg of messages) {
    const label = msg.role.charAt(0).toUpperCase() + msg.role.slice(1);
    lines.push(`### ${label}`);
    if (msg.timestamp) {
      lines.push(`*${msg.timestamp.toISOString()}*`);
    }
    lines.push("");
    lines.push(msg.content);

    if (msg.toolCalls && msg.toolCalls.length > 0) {
      lines.push("");
      for (const tc of msg.toolCalls) {
        lines.push(`**Tool:** \`${tc.name}\``);
        if (tc.input !== undefined) {
          lines.push("```json");
          lines.push(JSON.stringify(tc.input, null, 2));
          lines.push("```");
        }
        if (tc.output) {
          lines.push("**Output:**");
          lines.push("```");
          lines.push(tc.output);
          lines.push("```");
        }
      }
    }

    lines.push("");
  }

  return lines.join("\n");
}

/**
 * Format a session as a JSON-serializable object.
 * Applies the optional filter before formatting.
 */
export function formatJson(session: Session, filter?: SessionFilter): unknown {
  const messages = filter ? filterMessages(session.messages, filter) : session.messages;

  return {
    id: session.id,
    adapter: session.adapter,
    project: session.project ?? null,
    startedAt: session.startedAt.toISOString(),
    endedAt: session.endedAt?.toISOString() ?? null,
    messageCount: messages.length,
    messages: messages.map((m) => ({
      role: m.role,
      content: m.content,
      timestamp: m.timestamp?.toISOString() ?? null,
      toolCalls: m.toolCalls ?? [],
    })),
    metadata: session.metadata ?? {},
  };
}

/**
 * Rough token estimate: ~4 characters per token.
 * This is intentionally approximate — suitable for cost estimation and sorting,
 * not for precise tokenizer parity.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
