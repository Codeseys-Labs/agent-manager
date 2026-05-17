/**
 * Windsurf (Cascade) session reader (ADR-0016).
 *
 * Storage assumption (verified 2026-05-16): Windsurf is a Codeium-based VS Code
 * fork; per `detect.ts:17` everything lives under `~/.codeium/windsurf/`. The
 * agent feature is called "Cascade", so we read JSONL conversation transcripts
 * from `~/.codeium/windsurf/cascade/conversations/*.jsonl`.
 *
 * No production Cascade transcripts are available on the dev machine (the seeds
 * task acknowledges this and prescribes a defensive scaffold). The reader is
 * designed to satisfy the SessionReader contract from `src/core/session.ts` so
 * the harvest pipeline can light up Windsurf as soon as the format is
 * confirmed; if the on-disk shape diverges, only the JSONL record types here
 * need to change.
 *
 * Each line is a typed JSON record:
 *   - "conversation_meta" — conversation metadata (id, start time, cwd, model)
 *   - "user_message"      — user turn
 *   - "assistant_message" — assistant turn (text + optional tool calls)
 *   - "tool_call"         — standalone tool invocation (rare; usually inlined)
 *   - "system_message"    — system / cascade context turn
 *
 * Defensive parsing: malformed lines are skipped, never fatal.
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { estimateTokens } from "../../core/session.ts";
import type {
  Message,
  Session,
  SessionReader,
  SessionSummary,
  ToolCall,
} from "../../core/session.ts";

const ADAPTER_NAME = "windsurf";

// ── JSONL record shapes ──────────────────────────────────────────

interface ConversationMetaRecord {
  type: "conversation_meta";
  conversation_id?: string;
  started_at?: string;
  model?: string;
  cwd?: string;
  workspace?: string;
  [key: string]: unknown;
}

interface UserMessageRecord {
  type: "user_message";
  content?: string;
  timestamp?: string;
  [key: string]: unknown;
}

interface AssistantMessageRecord {
  type: "assistant_message";
  content?: string | AssistantContent[];
  timestamp?: string;
  tool_calls?: ToolCallRecord[];
  [key: string]: unknown;
}

interface AssistantContent {
  type: string;
  text?: string;
  [key: string]: unknown;
}

interface ToolCallRecord {
  name: string;
  arguments?: string;
  output?: string;
  [key: string]: unknown;
}

interface SystemMessageRecord {
  type: "system_message";
  content?: string;
  timestamp?: string;
  [key: string]: unknown;
}

interface ToolCallStandaloneRecord {
  type: "tool_call";
  name?: string;
  arguments?: string;
  output?: string;
  timestamp?: string;
  [key: string]: unknown;
}

type JsonlRecord =
  | ConversationMetaRecord
  | UserMessageRecord
  | AssistantMessageRecord
  | SystemMessageRecord
  | ToolCallStandaloneRecord
  | { type: string; [key: string]: unknown };

// ── SessionReader implementation ─────────────────────────────────

export function createWindsurfSessionReader(homeDir?: string): SessionReader {
  const home = homeDir ?? homedir();
  const conversationsDir = join(home, ".codeium", "windsurf", "cascade", "conversations");

  return {
    hasSessionStorage(): boolean {
      return existsSync(conversationsDir);
    },

    async listSessions(project?: string): Promise<SessionSummary[]> {
      const files = scanConversationFiles(conversationsDir);
      const summaries: SessionSummary[] = [];

      for (const file of files) {
        const summary = parseSessionSummary(file, project);
        if (summary) {
          summaries.push(summary);
        }
      }

      summaries.sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime());
      return summaries;
    },

    async loadSession(id: string): Promise<Session | null> {
      const safeId = id.replace(/\.jsonl$/, "");
      if (/[/\\\0]|\.\./.test(safeId)) {
        return null;
      }

      const files = scanConversationFiles(conversationsDir);

      for (const file of files) {
        if (basename(file, ".jsonl") !== safeId) continue;
        const session = parseSessionFull(file);
        if (session) return session;
      }

      // Fall back to scanning by recorded conversation_id when filename differs.
      for (const file of files) {
        const session = parseSessionFull(file);
        if (session && session.id === safeId) {
          return session;
        }
      }

      return null;
    },
  };
}

// ── File scanning ────────────────────────────────────────────────

function scanConversationFiles(conversationsDir: string): string[] {
  if (!existsSync(conversationsDir)) return [];

  const fs = require("node:fs");
  let entries: string[];
  try {
    entries = fs.readdirSync(conversationsDir);
  } catch {
    return [];
  }

  const results: string[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".jsonl")) continue;
    results.push(join(conversationsDir, entry));
  }
  return results;
}

// ── JSONL parsing ────────────────────────────────────────────────

function readJsonlLines(filePath: string): JsonlRecord[] {
  const fs = require("node:fs");
  let text: string;
  try {
    text = fs.readFileSync(filePath, "utf-8");
  } catch {
    return [];
  }

  const records: JsonlRecord[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed === "object" && parsed.type) {
        records.push(parsed);
      }
    } catch {
      // Skip malformed lines — defensive parsing per ADR-0016
    }
  }

  return records;
}

// ── Session summary (lightweight scan) ──────────────────────────

function parseSessionSummary(filePath: string, projectFilter?: string): SessionSummary | null {
  const records = readJsonlLines(filePath);
  if (records.length === 0) return null;

  const meta = records.find((r) => r.type === "conversation_meta") as
    | ConversationMetaRecord
    | undefined;

  const id = meta?.conversation_id ?? sessionIdFromPath(filePath);

  const startedAt = meta?.started_at
    ? new Date(meta.started_at)
    : (firstTimestamp(records) ?? new Date());

  const project = meta?.cwd ?? meta?.workspace;

  if (projectFilter && project) {
    if (!project.startsWith(projectFilter)) {
      return null;
    }
  } else if (projectFilter && !project) {
    return null;
  }

  const messageRecords = records.filter(
    (r) =>
      r.type === "user_message" || r.type === "assistant_message" || r.type === "system_message",
  );
  const messageCount = messageRecords.length;

  let endedAt: Date | undefined;
  for (let i = records.length - 1; i >= 0; i--) {
    const rec = records[i] as Record<string, unknown>;
    if (rec.timestamp) {
      endedAt = new Date(rec.timestamp as string);
      break;
    }
  }

  let totalText = "";
  for (const rec of messageRecords) {
    const content = (rec as Record<string, unknown>).content;
    if (typeof content === "string") {
      totalText += content;
    } else if (Array.isArray(content)) {
      for (const block of content) {
        if (block && typeof block === "object" && typeof block.text === "string") {
          totalText += block.text;
        }
      }
    }
  }

  return {
    id,
    adapter: ADAPTER_NAME,
    project,
    messageCount,
    startedAt,
    endedAt,
    estimatedTokens: estimateTokens(totalText),
  };
}

// ── Full session parse ───────────────────────────────────────────

function parseSessionFull(filePath: string): Session | null {
  const records = readJsonlLines(filePath);
  if (records.length === 0) return null;

  const meta = records.find((r) => r.type === "conversation_meta") as
    | ConversationMetaRecord
    | undefined;

  const id = meta?.conversation_id ?? sessionIdFromPath(filePath);
  const startedAt = meta?.started_at
    ? new Date(meta.started_at)
    : (firstTimestamp(records) ?? new Date());

  const project = meta?.cwd ?? meta?.workspace;

  const messages: Message[] = [];
  let endedAt: Date | undefined;

  for (const record of records) {
    switch (record.type) {
      case "user_message": {
        const rec = record as UserMessageRecord;
        if (rec.content === undefined) break;
        messages.push({
          role: "user",
          content: rec.content,
          ...(rec.timestamp && { timestamp: new Date(rec.timestamp) }),
        });
        if (rec.timestamp) endedAt = new Date(rec.timestamp);
        break;
      }
      case "assistant_message": {
        const rec = record as AssistantMessageRecord;
        const msg = parseAssistantMessage(rec);
        if (msg) messages.push(msg);
        if (rec.timestamp) endedAt = new Date(rec.timestamp);
        break;
      }
      case "system_message": {
        const rec = record as SystemMessageRecord;
        if (rec.content) {
          messages.push({
            role: "system",
            content: rec.content,
            ...(rec.timestamp && { timestamp: new Date(rec.timestamp) }),
          });
        }
        if (rec.timestamp) endedAt = new Date(rec.timestamp);
        break;
      }
      case "tool_call": {
        const rec = record as ToolCallStandaloneRecord;
        // Attach standalone tool calls to the most recent assistant message
        // when present; otherwise emit a synthetic tool message so the call
        // is still visible to the harvest pipeline.
        const toolCall: ToolCall = {
          name: rec.name ?? "unknown",
          input: rec.arguments ? safeJsonParse(rec.arguments) : undefined,
          output: rec.output,
        };
        const last = messages[messages.length - 1];
        if (last && last.role === "assistant") {
          last.toolCalls = [...(last.toolCalls ?? []), toolCall];
        } else {
          messages.push({
            role: "tool",
            content: rec.output ?? "",
            ...(rec.timestamp && { timestamp: new Date(rec.timestamp) }),
            toolCalls: [toolCall],
          });
        }
        if (rec.timestamp) endedAt = new Date(rec.timestamp);
        break;
      }
      // conversation_meta and unknown types — skip
    }
  }

  return {
    id,
    adapter: ADAPTER_NAME,
    project,
    messages,
    startedAt,
    endedAt,
    metadata: meta
      ? {
          ...(meta.model !== undefined && { model: meta.model }),
          ...(meta.cwd !== undefined && { cwd: meta.cwd }),
          ...(meta.workspace !== undefined && { workspace: meta.workspace }),
        }
      : undefined,
  };
}

function parseAssistantMessage(rec: AssistantMessageRecord): Message | null {
  const content = extractAssistantContent(rec.content);
  const toolCalls = extractToolCalls(rec.tool_calls);

  if (content === null && toolCalls.length === 0) return null;

  return {
    role: "assistant",
    content: content ?? "",
    ...(rec.timestamp && { timestamp: new Date(rec.timestamp) }),
    ...(toolCalls.length > 0 && { toolCalls }),
  };
}

function extractAssistantContent(content: string | AssistantContent[] | undefined): string | null {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const block of content) {
      if (block.type === "text" && typeof block.text === "string") {
        parts.push(block.text);
      }
    }
    return parts.length > 0 ? parts.join("\n") : null;
  }
  return null;
}

function extractToolCalls(records: ToolCallRecord[] | undefined): ToolCall[] {
  if (!records || !Array.isArray(records)) return [];
  const calls: ToolCall[] = [];
  for (const tc of records) {
    if (!tc || typeof tc.name !== "string") continue;
    calls.push({
      name: tc.name,
      input: tc.arguments ? safeJsonParse(tc.arguments) : undefined,
      output: tc.output,
    });
  }
  return calls;
}

function safeJsonParse(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

// ── Path utilities ───────────────────────────────────────────────

function sessionIdFromPath(filePath: string): string {
  return basename(filePath, ".jsonl");
}

function firstTimestamp(records: JsonlRecord[]): Date | undefined {
  for (const rec of records) {
    const ts = (rec as Record<string, unknown>).timestamp;
    if (typeof ts === "string") {
      const d = new Date(ts);
      if (!Number.isNaN(d.getTime())) return d;
    }
  }
  return undefined;
}
