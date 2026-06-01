/**
 * Roo Code session reader (ADR-0016).
 *
 * Roo Code is a Cline fork that persists each agent task as its own directory
 * under the VS Code extension globalStorage of `RooVeterinaryInc.roo-cline`
 * (with a lowercase fallback). The intended layout — research-needed; verify
 * against an installed Roo Code instance before tightening — is:
 *
 *   <globalStorage>/tasks/<taskId>/
 *     api_conversation_history.json   # array of message-like records
 *     ui_messages.json                # alt/fallback shape
 *     task_metadata.json              # optional sibling, may carry cwd
 *
 * Per ADR-0016 the parser is intentionally permissive
 * (`session-reader-defensive-scaffold`, mx-df3b59): malformed / unrecognised /
 * empty files are skipped silently, multiple casings of role/text/cwd fields
 * are accepted, schema drift across releases is the norm rather than the
 * exception. Path-traversal in session IDs is rejected.
 */

import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Message, Session, SessionReader, SessionSummary } from "../../core/session.ts";
import { estimateTokens } from "../../core/session.ts";
import { resolveVSCodeExtensionStorage } from "../shared/vscode-paths.ts";
import { ROO_EXTENSION_IDS } from "./detect.ts";

const ADAPTER_NAME = "roo-code";
const HISTORY_FILE = "api_conversation_history.json";
const UI_FILE = "ui_messages.json";
const META_FILE = "task_metadata.json";

// ── Raw record shapes (loose, schema-permissive) ───────────────────

interface RawRecord {
  role?: unknown;
  type?: unknown;
  content?: unknown;
  text?: unknown;
  message?: unknown;
  ts?: unknown;
  timestamp?: unknown;
  cwd?: unknown;
  workspace?: unknown;
  workspaceFolder?: unknown;
  [key: string]: unknown;
}

interface ParsedMessage {
  role: Message["role"];
  content: string;
  timestamp?: Date;
  cwd?: string;
}

// ── SessionReader factory ──────────────────────────────────────────

export function createRooCodeSessionReader(
  homeDir?: string,
  opts?: { extensionIds?: string[] },
): SessionReader {
  const home = homeDir ?? homedir();
  const extensionIds = opts?.extensionIds ?? [...ROO_EXTENSION_IDS];
  // De-dupe physically-identical candidate dirs. On case-insensitive
  // filesystems (macOS APFS, Windows NTFS) the two ROO_EXTENSION_IDS casings
  // (`RooVeterinaryInc.roo-cline` vs `rooveterinaryinc.roo-cline`) resolve to
  // the same physical directory, so without this each task dir would be
  // scanned once per casing and listSessions would double-count. Keying on
  // realpathSync collapses the aliases; a no-op on case-sensitive Linux.
  const candidateDirs = () => dedupeByRealpath(resolveVSCodeExtensionStorage(extensionIds, home));

  return {
    hasSessionStorage(): boolean {
      for (const dir of candidateDirs()) {
        if (existsSync(dir)) return true;
      }
      return false;
    },

    async listSessions(project?: string): Promise<SessionSummary[]> {
      const summaries: SessionSummary[] = [];

      for (const dir of candidateDirs()) {
        if (!existsSync(dir)) continue;
        const tasksDir = join(dir, "tasks");
        if (!existsSync(tasksDir)) continue;

        for (const taskId of safeReaddir(tasksDir)) {
          const taskPath = join(tasksDir, taskId);
          if (!isDir(taskPath)) continue;

          const summary = summarizeTask(taskId, taskPath, project);
          if (summary) summaries.push(summary);
        }
      }

      summaries.sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime());
      return summaries;
    },

    async loadSession(id: string): Promise<Session | null> {
      if (!id || /[/\\\0]|\.\./.test(id)) {
        return null;
      }

      for (const dir of candidateDirs()) {
        if (!existsSync(dir)) continue;
        const taskPath = join(dir, "tasks", id);
        if (!isDir(taskPath)) continue;

        const session = parseTaskFull(id, taskPath, dir);
        if (session) return session;
      }
      return null;
    },
  };
}

// ── Candidate-dir de-duplication ────────────────────────────────────

/**
 * Collapse candidate dirs that resolve to the same physical directory.
 *
 * On case-insensitive filesystems (macOS APFS, Windows NTFS) the multiple
 * extension-id casings we probe point at one on-disk directory, so scanning
 * every candidate would visit the same task dirs multiple times. Keying on
 * `realpathSync` de-dupes those aliases. Paths that don't exist yet (no
 * realpath) fall back to the literal string so they stay distinct.
 */
function dedupeByRealpath(dirs: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const dir of dirs) {
    let key: string;
    try {
      key = realpathSync(dir);
    } catch {
      key = dir;
    }
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(dir);
  }
  return out;
}

// ── Filesystem helpers ─────────────────────────────────────────────

function safeReaddir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function dirCreatedAt(path: string): Date | undefined {
  try {
    const stat = statSync(path);
    const t = stat.birthtime.getTime() || stat.mtime.getTime();
    return Number.isFinite(t) && t > 0 ? new Date(t) : undefined;
  } catch {
    return undefined;
  }
}

// ── JSON parsing ───────────────────────────────────────────────────

function readJsonArray(filePath: string): RawRecord[] | null {
  let text: string;
  try {
    text = readFileSync(filePath, "utf-8");
  } catch {
    return null;
  }
  const trimmed = text.trim();
  if (!trimmed) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;

  const records: RawRecord[] = [];
  for (const item of parsed) {
    if (item && typeof item === "object" && !Array.isArray(item)) {
      records.push(item as RawRecord);
    }
  }
  return records.length > 0 ? records : null;
}

function readJsonObject(filePath: string): Record<string, unknown> | null {
  let text: string;
  try {
    text = readFileSync(filePath, "utf-8");
  } catch {
    return null;
  }
  const trimmed = text.trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    return null;
  }
  return null;
}

// ── Record → message coercion ──────────────────────────────────────

/**
 * Coerce ms-epoch number, ISO string, or numeric string into a Date.
 */
function coerceDate(value: unknown): Date | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value <= 0) return undefined;
    return new Date(value);
  }
  if (typeof value === "string") {
    if (!value) return undefined;
    if (/^\d+$/.test(value)) {
      const asNum = Number(value);
      if (Number.isFinite(asNum)) return new Date(asNum);
    }
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? undefined : d;
  }
  return undefined;
}

/**
 * Map a raw message-shape role string onto our four-value union.
 * Cline/Roo "say" / "ask" UI types collapse to user/assistant.
 */
function normalizeRole(raw: unknown): Message["role"] | undefined {
  if (typeof raw !== "string") return undefined;
  const r = raw.toLowerCase();
  if (r === "user" || r === "human" || r === "ask") return "user";
  if (r === "assistant" || r === "ai" || r === "say") return "assistant";
  if (r === "system") return "system";
  if (r === "tool" || r === "tool_use" || r === "tool_result") return "tool";
  return undefined;
}

/**
 * Pull the user-visible text out of a record. Accepts:
 *   string content, { text }, [{ text } | string], { message: ... } (recursed),
 *   top-level `text`.
 */
function extractText(record: RawRecord): string {
  const direct = coerceText(record.content);
  if (direct) return direct;
  if (typeof record.text === "string" && record.text) return record.text;

  const message = record.message;
  if (message && typeof message === "object" && !Array.isArray(message)) {
    const m = message as Record<string, unknown>;
    if (typeof m.text === "string" && m.text) return m.text;
    if (typeof m.content === "string" && m.content) return m.content;
    const nested = coerceText(m.content);
    if (nested) return nested;
  }
  return "";
}

function coerceText(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";

  const parts: string[] = [];
  for (const item of value) {
    if (typeof item === "string") {
      parts.push(item);
      continue;
    }
    if (!item || typeof item !== "object") continue;
    const obj = item as Record<string, unknown>;
    if (typeof obj.text === "string") {
      parts.push(obj.text);
      continue;
    }
    if (typeof obj.value === "string") {
      parts.push(obj.value);
      continue;
    }
    const content = obj.content;
    if (content && typeof content === "object" && !Array.isArray(content)) {
      const c = content as Record<string, unknown>;
      if (typeof c.text === "string") parts.push(c.text);
      else if (typeof c.value === "string") parts.push(c.value);
    }
  }
  return parts.join("");
}

function extractCwd(record: RawRecord): string | undefined {
  if (typeof record.cwd === "string" && record.cwd) return record.cwd;
  if (typeof record.workspace === "string" && record.workspace) return record.workspace;
  if (typeof record.workspaceFolder === "string" && record.workspaceFolder) {
    return record.workspaceFolder;
  }
  const message = record.message;
  if (message && typeof message === "object" && !Array.isArray(message)) {
    const m = message as Record<string, unknown>;
    if (typeof m.cwd === "string" && m.cwd) return m.cwd;
  }
  return undefined;
}

function parseRecord(record: RawRecord): ParsedMessage | null {
  const role = normalizeRole(record.role) ?? normalizeRole(record.type);
  if (!role) return null;

  const content = extractText(record);
  if (!content) return null;

  const timestamp = coerceDate(record.ts) ?? coerceDate(record.timestamp);
  const cwd = extractCwd(record);

  return {
    role,
    content,
    ...(timestamp && { timestamp }),
    ...(cwd && { cwd }),
  };
}

// ── Task-dir loading ───────────────────────────────────────────────

/**
 * Read api_conversation_history.json first, fall back to ui_messages.json.
 * Returns null if neither yields any parseable messages.
 */
function loadTaskRecords(taskPath: string): RawRecord[] | null {
  const apiPath = join(taskPath, HISTORY_FILE);
  if (existsSync(apiPath)) {
    const records = readJsonArray(apiPath);
    if (records && records.length > 0) return records;
  }
  const uiPath = join(taskPath, UI_FILE);
  if (existsSync(uiPath)) {
    const records = readJsonArray(uiPath);
    if (records && records.length > 0) return records;
  }
  return null;
}

function loadTaskMetadataCwd(taskPath: string): string | undefined {
  const metaPath = join(taskPath, META_FILE);
  if (!existsSync(metaPath)) return undefined;
  const obj = readJsonObject(metaPath);
  if (!obj) return undefined;
  if (typeof obj.cwd === "string" && obj.cwd) return obj.cwd;
  if (typeof obj.workspace === "string" && obj.workspace) return obj.workspace;
  if (typeof obj.workspaceFolder === "string" && obj.workspaceFolder) {
    return obj.workspaceFolder;
  }
  return undefined;
}

// ── Summary / full builders ────────────────────────────────────────

function summarizeTask(
  taskId: string,
  taskPath: string,
  projectFilter?: string,
): SessionSummary | null {
  const records = loadTaskRecords(taskPath);
  if (!records) return null;

  const messages: ParsedMessage[] = [];
  let earliest: Date | undefined;
  let latest: Date | undefined;
  let project = loadTaskMetadataCwd(taskPath);
  let totalText = "";

  for (const record of records) {
    const parsed = parseRecord(record);
    if (!parsed) continue;

    messages.push(parsed);
    totalText += parsed.content;

    if (parsed.timestamp) {
      if (!earliest || parsed.timestamp.getTime() < earliest.getTime()) {
        earliest = parsed.timestamp;
      }
      if (!latest || parsed.timestamp.getTime() > latest.getTime()) {
        latest = parsed.timestamp;
      }
    }
    if (!project && parsed.cwd) project = parsed.cwd;
  }

  if (messages.length === 0) return null;

  if (projectFilter !== undefined) {
    if (!project || project !== projectFilter) return null;
  }

  const startedAt = earliest ?? dirCreatedAt(taskPath) ?? new Date(0);

  return {
    id: taskId,
    adapter: ADAPTER_NAME,
    project,
    messageCount: messages.length,
    startedAt,
    endedAt: latest,
    estimatedTokens: estimateTokens(totalText),
  };
}

function parseTaskFull(taskId: string, taskPath: string, storageDir: string): Session | null {
  const records = loadTaskRecords(taskPath);
  if (!records) return null;

  const messages: Message[] = [];
  let earliest: Date | undefined;
  let latest: Date | undefined;
  let project = loadTaskMetadataCwd(taskPath);

  for (const record of records) {
    const parsed = parseRecord(record);
    if (!parsed) continue;

    const msg: Message = {
      role: parsed.role,
      content: parsed.content,
      ...(parsed.timestamp && { timestamp: parsed.timestamp }),
    };
    messages.push(msg);

    if (parsed.timestamp) {
      if (!earliest || parsed.timestamp.getTime() < earliest.getTime()) {
        earliest = parsed.timestamp;
      }
      if (!latest || parsed.timestamp.getTime() > latest.getTime()) {
        latest = parsed.timestamp;
      }
    }
    if (!project && parsed.cwd) project = parsed.cwd;
  }

  if (messages.length === 0) return null;

  const startedAt = earliest ?? dirCreatedAt(taskPath) ?? new Date(0);

  return {
    id: taskId,
    adapter: ADAPTER_NAME,
    project,
    messages,
    startedAt,
    endedAt: latest,
    metadata: { storageDir },
  };
}
