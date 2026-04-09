/**
 * Codex CLI session reader (ADR-0016).
 *
 * Reads JSONL session files from ~/.codex/sessions/YYYY/MM/DD/*.jsonl.
 * Each line is a typed JSON record:
 *   - "session_meta" — session metadata (id, start time, model)
 *   - "event_msg"    — user messages
 *   - "response_item"— assistant responses (text, function calls)
 *   - "turn_context"  — context info (system messages, cwd, etc.)
 *
 * Defensive parsing: malformed lines are skipped, never fatal.
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { estimateTokens } from "../../core/session.ts";
import type {
  Message,
  Session,
  SessionReader,
  SessionSummary,
  ToolCall,
} from "../../core/session.ts";

// ── JSONL record shapes ──────────────────────────────────────────

interface SessionMetaRecord {
  type: "session_meta";
  session_id?: string;
  started_at?: string;
  model?: string;
  cwd?: string;
  [key: string]: unknown;
}

interface EventMsgRecord {
  type: "event_msg";
  role?: string;
  content?: string;
  timestamp?: string;
  [key: string]: unknown;
}

interface ResponseItemRecord {
  type: "response_item";
  role?: string;
  content?: string | ResponseContent[];
  timestamp?: string;
  function_call?: FunctionCallRecord;
  tool_calls?: FunctionCallRecord[];
  [key: string]: unknown;
}

interface ResponseContent {
  type: string;
  text?: string;
  [key: string]: unknown;
}

interface FunctionCallRecord {
  name: string;
  arguments?: string;
  output?: string;
  [key: string]: unknown;
}

interface TurnContextRecord {
  type: "turn_context";
  content?: string;
  timestamp?: string;
  cwd?: string;
  [key: string]: unknown;
}

type JsonlRecord =
  | SessionMetaRecord
  | EventMsgRecord
  | ResponseItemRecord
  | TurnContextRecord
  | { type: string; [key: string]: unknown };

// ── SessionReader implementation ─────────────────────────────────

export function createCodexSessionReader(homeDir?: string): SessionReader {
  const home = homeDir ?? homedir();
  const sessionsDir = join(home, ".codex", "sessions");

  return {
    hasSessionStorage(): boolean {
      return existsSync(sessionsDir);
    },

    async listSessions(project?: string): Promise<SessionSummary[]> {
      const files = scanSessionFiles(sessionsDir);
      const summaries: SessionSummary[] = [];

      for (const file of files) {
        const summary = await parseSessionSummary(file, project);
        if (summary) {
          summaries.push(summary);
        }
      }

      // Sort newest first
      summaries.sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime());
      return summaries;
    },

    async loadSession(id: string): Promise<Session | null> {
      // Sanitize session ID to prevent path traversal
      const safeId = id.replace(/\.jsonl$/, "");
      if (/[/\\\0]|\.\./.test(safeId)) {
        return null;
      }

      const files = scanSessionFiles(sessionsDir);

      for (const file of files) {
        const session = await parseSessionFull(file);
        if (session && session.id === safeId) {
          return session;
        }
      }

      return null;
    },
  };
}

// ── File scanning ────────────────────────────────────────────────

/**
 * Scan ~/.codex/sessions/YYYY/MM/DD/*.jsonl recursively.
 * Returns absolute file paths sorted newest first (by directory structure).
 */
function scanSessionFiles(sessionsDir: string): string[] {
  const fs = require("node:fs");
  const results: string[] = [];

  if (!existsSync(sessionsDir)) return results;

  let years: string[];
  try {
    years = fs.readdirSync(sessionsDir);
  } catch {
    return results;
  }

  // Walk YYYY/MM/DD structure
  for (const year of years.sort().reverse()) {
    const yearDir = join(sessionsDir, year);
    if (!isDir(yearDir)) continue;

    let months: string[];
    try {
      months = fs.readdirSync(yearDir);
    } catch {
      continue;
    }

    for (const month of months.sort().reverse()) {
      const monthDir = join(yearDir, month);
      if (!isDir(monthDir)) continue;

      let days: string[];
      try {
        days = fs.readdirSync(monthDir);
      } catch {
        continue;
      }

      for (const day of days.sort().reverse()) {
        const dayDir = join(monthDir, day);
        if (!isDir(dayDir)) continue;

        let files: string[];
        try {
          files = fs.readdirSync(dayDir);
        } catch {
          continue;
        }

        for (const file of files.sort().reverse()) {
          if (file.endsWith(".jsonl")) {
            results.push(join(dayDir, file));
          }
        }
      }
    }
  }

  return results;
}

function isDir(path: string): boolean {
  try {
    const fs = require("node:fs");
    return fs.statSync(path).isDirectory();
  } catch {
    return false;
  }
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

async function parseSessionSummary(
  filePath: string,
  projectFilter?: string,
): Promise<SessionSummary | null> {
  const records = readJsonlLines(filePath);
  if (records.length === 0) return null;

  const meta = records.find((r) => r.type === "session_meta") as SessionMetaRecord | undefined;

  // Derive session ID from meta or filename
  const id = meta?.session_id ?? sessionIdFromPath(filePath);

  // Derive start time from meta or file path
  const startedAt = meta?.started_at ? new Date(meta.started_at) : dateFromPath(filePath);

  // Filter by project (from cwd in session_meta)
  if (projectFilter && meta?.cwd) {
    if (!meta.cwd.startsWith(projectFilter)) {
      return null;
    }
  }

  // Count messages (event_msg + response_item)
  const messageRecords = records.filter(
    (r) => r.type === "event_msg" || r.type === "response_item",
  );
  const messageCount = messageRecords.length;

  // Find last timestamp for endedAt
  let endedAt: Date | undefined;
  for (let i = records.length - 1; i >= 0; i--) {
    const rec = records[i] as Record<string, unknown>;
    if (rec.timestamp) {
      endedAt = new Date(rec.timestamp as string);
      break;
    }
  }

  // Estimate tokens from all text content
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
    adapter: "codex-cli",
    project: meta?.cwd,
    messageCount,
    startedAt,
    endedAt,
    estimatedTokens: estimateTokens(totalText),
  };
}

// ── Full session parse ───────────────────────────────────────────

async function parseSessionFull(filePath: string): Promise<Session | null> {
  const records = readJsonlLines(filePath);
  if (records.length === 0) return null;

  const meta = records.find((r) => r.type === "session_meta") as SessionMetaRecord | undefined;

  const id = meta?.session_id ?? sessionIdFromPath(filePath);
  const startedAt = meta?.started_at ? new Date(meta.started_at) : dateFromPath(filePath);

  const messages: Message[] = [];
  let endedAt: Date | undefined;

  for (const record of records) {
    switch (record.type) {
      case "event_msg": {
        const rec = record as EventMsgRecord;
        const msg = parseEventMsg(rec);
        if (msg) messages.push(msg);
        if (rec.timestamp) endedAt = new Date(rec.timestamp);
        break;
      }
      case "response_item": {
        const rec = record as ResponseItemRecord;
        const msg = parseResponseItem(rec);
        if (msg) messages.push(msg);
        if (rec.timestamp) endedAt = new Date(rec.timestamp);
        break;
      }
      case "turn_context": {
        const rec = record as TurnContextRecord;
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
      // session_meta and unknown types — skip
    }
  }

  return {
    id,
    adapter: "codex-cli",
    project: meta?.cwd,
    messages,
    startedAt,
    endedAt,
    metadata: meta ? { model: meta.model, cwd: meta.cwd } : undefined,
  };
}

function parseEventMsg(rec: EventMsgRecord): Message | null {
  if (!rec.content && !rec.role) return null;
  return {
    role: (rec.role as Message["role"]) ?? "user",
    content: rec.content ?? "",
    ...(rec.timestamp && { timestamp: new Date(rec.timestamp) }),
  };
}

function parseResponseItem(rec: ResponseItemRecord): Message | null {
  const content = extractResponseContent(rec.content);
  const toolCalls = extractToolCalls(rec);

  if (!content && toolCalls.length === 0) return null;

  return {
    role: (rec.role as Message["role"]) ?? "assistant",
    content: content ?? "",
    ...(rec.timestamp && { timestamp: new Date(rec.timestamp) }),
    ...(toolCalls.length > 0 && { toolCalls }),
  };
}

function extractResponseContent(content: string | ResponseContent[] | undefined): string | null {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const textParts: string[] = [];
    for (const block of content) {
      if (block.type === "text" && block.text) {
        textParts.push(block.text);
      }
    }
    return textParts.length > 0 ? textParts.join("\n") : null;
  }
  return null;
}

function extractToolCalls(rec: ResponseItemRecord): ToolCall[] {
  const calls: ToolCall[] = [];

  if (rec.function_call) {
    calls.push({
      name: rec.function_call.name,
      input: rec.function_call.arguments ? safeJsonParse(rec.function_call.arguments) : undefined,
      output: rec.function_call.output,
    });
  }

  if (rec.tool_calls) {
    for (const tc of rec.tool_calls) {
      calls.push({
        name: tc.name,
        input: tc.arguments ? safeJsonParse(tc.arguments) : undefined,
        output: tc.output,
      });
    }
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

/**
 * Extract a session ID from the file path.
 * e.g. ~/.codex/sessions/2026/04/08/abc123.jsonl → "abc123"
 */
function sessionIdFromPath(filePath: string): string {
  const basename = filePath.split("/").pop() ?? filePath;
  return basename.replace(".jsonl", "");
}

/**
 * Derive a date from the YYYY/MM/DD directory structure.
 * e.g. ~/.codex/sessions/2026/04/08/abc.jsonl → 2026-04-08
 */
function dateFromPath(filePath: string): Date {
  const parts = filePath.split("/");
  // Look for YYYY/MM/DD pattern in the path
  for (let i = 0; i < parts.length - 2; i++) {
    const year = Number.parseInt(parts[i], 10);
    const month = Number.parseInt(parts[i + 1], 10);
    const day = Number.parseInt(parts[i + 2], 10);
    if (year >= 2020 && year <= 2099 && month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      return new Date(year, month - 1, day);
    }
  }
  return new Date();
}
