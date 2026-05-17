/**
 * Gemini CLI session reader (ADR-0016).
 *
 * Storage path:   ~/.gemini/tmp/<projectHash>/chats/*.jsonl
 *   - <projectHash> is sha256(projectRoot) hex.
 *   - Filenames are `session-<YYYY-MM-DDTHH-MM>-<8char>.jsonl` for main
 *     sessions and `<sessionId>.jsonl` (nested under a parent dir) for
 *     subagent sessions.
 *
 * Record format:  JSONL — one JSON object per line. Mixed record types:
 *   - PartialMetadataRecord  — initial line, has `sessionId`, `projectHash`,
 *                              optional `startTime`, `lastUpdated`, `summary`,
 *                              `directories[]`, `kind`.
 *   - MetadataUpdateRecord   — `{ $set: { ... } }` patches on the metadata.
 *   - MessageRecord          — `{ id, timestamp, content, type, toolCalls?,
 *                              ... }` where type is "user" | "gemini" |
 *                              "info" | "error" | "warning".
 *   - RewindRecord           — `{ $rewindTo: <messageId> }` truncates the
 *                              message stream from that ID onward.
 *
 * Source anchored on the official Gemini CLI sources:
 *   - Storage path & format: docs/cli/session-management.md
 *     https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/session-management.md
 *   - Record schemas:
 *     packages/core/src/services/chatRecordingTypes.ts
 *     packages/core/src/services/chatRecordingService.ts
 *
 * Defensive parsing: malformed lines are skipped, never fatal. Path-traversal
 * guard mirrors codex-cli/session.ts.
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

interface PartialMetadataRecord {
  sessionId: string;
  projectHash?: string;
  startTime?: string;
  lastUpdated?: string;
  summary?: string;
  directories?: string[];
  kind?: "main" | "subagent";
  [key: string]: unknown;
}

interface MetadataUpdateRecord {
  $set: Partial<PartialMetadataRecord> & Record<string, unknown>;
}

interface RewindRecord {
  $rewindTo: string;
}

interface ToolCallRecord {
  id?: string;
  name?: string;
  args?: Record<string, unknown>;
  result?: unknown;
  status?: string;
  timestamp?: string;
  [key: string]: unknown;
}

interface MessageRecord {
  id: string;
  timestamp?: string;
  type?: "user" | "gemini" | "info" | "error" | "warning";
  content?: unknown;
  displayContent?: unknown;
  toolCalls?: ToolCallRecord[];
  model?: string;
  [key: string]: unknown;
}

type JsonlRecord =
  | PartialMetadataRecord
  | MetadataUpdateRecord
  | RewindRecord
  | MessageRecord
  | Record<string, unknown>;

// ── SessionReader implementation ─────────────────────────────────

export function createGeminiSessionReader(homeDir?: string): SessionReader {
  const home = homeDir ?? homedir();
  const tmpRoot = join(home, ".gemini", "tmp");

  return {
    hasSessionStorage(): boolean {
      return existsSync(tmpRoot);
    },

    async listSessions(project?: string): Promise<SessionSummary[]> {
      const files = scanSessionFiles(tmpRoot);
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

      const files = scanSessionFiles(tmpRoot);
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

/**
 * Scan ~/.gemini/tmp/<projectHash>/chats/*.jsonl across all project hashes.
 * Subagent sessions live in nested <parentSessionId>/ dirs and are also
 * collected. Returns absolute file paths.
 */
function scanSessionFiles(tmpRoot: string): string[] {
  const fs = require("node:fs");
  const results: string[] = [];

  if (!existsSync(tmpRoot)) return results;

  let projectDirs: string[];
  try {
    projectDirs = fs.readdirSync(tmpRoot);
  } catch {
    return results;
  }

  for (const projectDir of projectDirs) {
    const chatsDir = join(tmpRoot, projectDir, "chats");
    if (!isDir(chatsDir)) continue;
    collectJsonlFiles(chatsDir, results);
  }

  return results;
}

/**
 * Walk a chats/ directory (and any subagent subdirectories) collecting
 * `*.jsonl` files. Defensive: any unreadable subdir is skipped silently.
 */
function collectJsonlFiles(dir: string, out: string[]): void {
  const fs = require("node:fs");
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return;
  }

  for (const entry of entries) {
    const full = join(dir, entry);
    if (entry.endsWith(".jsonl")) {
      out.push(full);
    } else if (isDir(full)) {
      // Subagent sessions are nested under <parentSessionId>/
      collectJsonlFiles(full, out);
    }
  }
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
      if (parsed && typeof parsed === "object") {
        records.push(parsed as JsonlRecord);
      }
    } catch {
      // Skip malformed lines — defensive parsing per ADR-0016
    }
  }

  return records;
}

// ── Type guards ──────────────────────────────────────────────────

function isRewindRecord(rec: JsonlRecord): rec is RewindRecord {
  return typeof (rec as RewindRecord).$rewindTo === "string";
}

function isMetadataUpdate(rec: JsonlRecord): rec is MetadataUpdateRecord {
  const set = (rec as MetadataUpdateRecord).$set;
  return set !== null && typeof set === "object";
}

function isPartialMetadata(rec: JsonlRecord): rec is PartialMetadataRecord {
  return typeof (rec as PartialMetadataRecord).sessionId === "string";
}

function isMessageRecord(rec: JsonlRecord): rec is MessageRecord {
  // Has an id and either a recognised type or content. Excludes metadata
  // (which carries sessionId) and rewinds (which carry $rewindTo).
  if (typeof (rec as MessageRecord).id !== "string") return false;
  if (isRewindRecord(rec) || isMetadataUpdate(rec) || isPartialMetadata(rec)) {
    return false;
  }
  return true;
}

// ── Metadata + message reduction ─────────────────────────────────

interface ReducedSession {
  metadata: PartialMetadataRecord;
  messages: MessageRecord[];
}

function reduceRecords(records: JsonlRecord[]): ReducedSession {
  const metadata: PartialMetadataRecord = { sessionId: "" };
  // Use a Map keyed by message id so that re-emitted messages overwrite,
  // and rewinds can drop ids in insertion order.
  const messages = new Map<string, MessageRecord>();

  for (const rec of records) {
    if (isPartialMetadata(rec)) {
      Object.assign(metadata, rec);
    } else if (isMetadataUpdate(rec)) {
      Object.assign(metadata, rec.$set);
    } else if (isRewindRecord(rec)) {
      // Truncate from $rewindTo onward (inclusive).
      const target = rec.$rewindTo;
      let found = false;
      const toDelete: string[] = [];
      for (const id of messages.keys()) {
        if (id === target) found = true;
        if (found) toDelete.push(id);
      }
      if (found) {
        for (const id of toDelete) messages.delete(id);
      } else {
        // Per upstream behaviour, an unknown $rewindTo clears the stream.
        messages.clear();
      }
    } else if (isMessageRecord(rec)) {
      messages.set(rec.id, rec);
    }
    // Unknown record shapes are tolerated and skipped.
  }

  return { metadata, messages: Array.from(messages.values()) };
}

// ── Content extraction ───────────────────────────────────────────

interface PartLike {
  text?: unknown;
  [key: string]: unknown;
}

/**
 * Extract a plain-text representation from Gemini's PartListUnion content.
 * Accepts: string, Part object with `text`, or an array of either.
 */
function extractContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const item of content) {
      const piece = extractContent(item);
      if (piece) parts.push(piece);
    }
    return parts.join("\n");
  }
  if (content && typeof content === "object") {
    const part = content as PartLike;
    if (typeof part.text === "string") return part.text;
  }
  return "";
}

function extractToolCalls(rec: MessageRecord): ToolCall[] {
  const calls: ToolCall[] = [];
  if (!Array.isArray(rec.toolCalls)) return calls;

  for (const tc of rec.toolCalls) {
    if (!tc || typeof tc !== "object") continue;
    const name = typeof tc.name === "string" ? tc.name : "";
    if (!name) continue;
    const call: ToolCall = { name };
    if (tc.args && typeof tc.args === "object") {
      call.input = tc.args;
    }
    if (tc.result !== undefined && tc.result !== null) {
      // Result may be a Part / Part[] / string; flatten to a string display.
      const text = extractContent(tc.result);
      if (text) call.output = text;
    }
    calls.push(call);
  }

  return calls;
}

function geminiTypeToRole(type: MessageRecord["type"]): Message["role"] | null {
  switch (type) {
    case "user":
      return "user";
    case "gemini":
      return "assistant";
    case "info":
    case "warning":
    case "error":
      return "system";
    default:
      return null;
  }
}

function recordToMessage(rec: MessageRecord): Message | null {
  const role = geminiTypeToRole(rec.type);
  if (!role) return null;

  const content = extractContent(rec.content);
  const toolCalls = extractToolCalls(rec);

  if (!content && toolCalls.length === 0) return null;

  const message: Message = {
    role,
    content,
  };
  if (rec.timestamp) {
    const ts = new Date(rec.timestamp);
    if (!Number.isNaN(ts.getTime())) message.timestamp = ts;
  }
  if (toolCalls.length > 0) {
    message.toolCalls = toolCalls;
  }
  return message;
}

// ── Summary + full parse ─────────────────────────────────────────

function parseSessionSummary(filePath: string, projectFilter?: string): SessionSummary | null {
  const records = readJsonlLines(filePath);
  if (records.length === 0) return null;

  const { metadata, messages } = reduceRecords(records);
  const id = metadata.sessionId || sessionIdFromPath(filePath);
  const startedAt = parseDate(metadata.startTime) ?? dateFromFilename(filePath);

  const project =
    Array.isArray(metadata.directories) && metadata.directories.length > 0
      ? String(metadata.directories[0])
      : undefined;

  if (projectFilter) {
    if (!project || !project.startsWith(projectFilter)) return null;
  }

  const renderedMessages = messages
    .map((rec) => recordToMessage(rec))
    .filter((m): m is Message => m !== null);

  let endedAt =
    parseDate(metadata.lastUpdated) ??
    (() => {
      for (let i = messages.length - 1; i >= 0; i--) {
        const ts = parseDate(messages[i].timestamp);
        if (ts) return ts;
      }
      return undefined;
    })();
  if (endedAt && endedAt.getTime() < startedAt.getTime()) {
    endedAt = startedAt;
  }

  let totalText = "";
  for (const msg of renderedMessages) totalText += msg.content;

  return {
    id,
    adapter: "gemini-cli",
    project,
    messageCount: renderedMessages.length,
    startedAt,
    endedAt,
    estimatedTokens: estimateTokens(totalText),
  };
}

function parseSessionFull(filePath: string): Session | null {
  const records = readJsonlLines(filePath);
  if (records.length === 0) return null;

  const { metadata, messages } = reduceRecords(records);
  const id = metadata.sessionId || sessionIdFromPath(filePath);
  const startedAt = parseDate(metadata.startTime) ?? dateFromFilename(filePath);

  const project =
    Array.isArray(metadata.directories) && metadata.directories.length > 0
      ? String(metadata.directories[0])
      : undefined;

  const renderedMessages = messages
    .map((rec) => recordToMessage(rec))
    .filter((m): m is Message => m !== null);

  let endedAt =
    parseDate(metadata.lastUpdated) ??
    (() => {
      for (let i = renderedMessages.length - 1; i >= 0; i--) {
        const ts = renderedMessages[i].timestamp;
        if (ts) return ts;
      }
      return undefined;
    })();
  if (endedAt && endedAt.getTime() < startedAt.getTime()) {
    endedAt = startedAt;
  }

  const sessionMeta: Record<string, unknown> = {};
  if (metadata.projectHash) sessionMeta.projectHash = metadata.projectHash;
  if (metadata.kind) sessionMeta.kind = metadata.kind;
  if (metadata.summary) sessionMeta.summary = metadata.summary;
  if (Array.isArray(metadata.directories)) {
    sessionMeta.directories = metadata.directories;
  }

  return {
    id,
    adapter: "gemini-cli",
    project,
    messages: renderedMessages,
    startedAt,
    endedAt,
    metadata: Object.keys(sessionMeta).length > 0 ? sessionMeta : undefined,
  };
}

// ── Path / date utilities ────────────────────────────────────────

function sessionIdFromPath(filePath: string): string {
  // Use both POSIX and Windows separators defensively.
  const basename = filePath.split(/[/\\]/).pop() ?? filePath;
  return basename.replace(/\.jsonl$/, "");
}

function parseDate(value: unknown): Date | undefined {
  if (typeof value !== "string" || !value) return undefined;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return undefined;
  return d;
}

/**
 * Best-effort timestamp extraction from a `session-YYYY-MM-DDTHH-MM-<id>.jsonl`
 * filename. Falls back to the current date if the pattern doesn't match.
 */
function dateFromFilename(filePath: string): Date {
  const basename = filePath.split(/[/\\]/).pop() ?? "";
  const match = basename.match(/session-(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})/);
  if (match) {
    const [, y, mo, d, h, mi] = match;
    const iso = `${y}-${mo}-${d}T${h}:${mi}:00Z`;
    const parsed = new Date(iso);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }
  return new Date();
}
