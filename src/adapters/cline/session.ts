/**
 * Cline (Claude Dev) session reader (ADR-0016).
 *
 * Cline ships under the VS Code marketplace ID `saoudrizwan.claude-dev` and
 * stores conversation history as per-task JSON files inside the extension's
 * globalStorage:
 *
 *   <globalStorage>/
 *     tasks/
 *       <taskId>/                       # taskId is a numeric ms timestamp
 *         api_conversation_history.json # raw Anthropic-style role/content turns
 *         ui_messages.json              # ts-stamped UI event log (optional)
 *         task_metadata.json            # optional metadata (workspace, title)
 *
 * `<globalStorage>` resolves across every supported VS Code variant (stable,
 * Insiders, VSCodium, Cursor, Windsurf). We iterate ALL variants — a user may
 * have Cline installed under more than one — rather than just the first hit.
 *
 * The reader is intentionally defensive (ADR-0016): missing files, malformed
 * JSON, and empty conversations are skipped silently rather than thrown.
 *
 * Session id format: bare `<taskId>` (numeric ms epoch). No colon separator —
 * each task lives in its own directory and is globally identifiable.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
  Message,
  Session,
  SessionReader,
  SessionSummary,
  ToolCall,
} from "../../core/session.ts";
import { estimateTokens } from "../../core/session.ts";
import { resolveVSCodeExtensionStorage } from "../shared/vscode-paths.ts";

const ADAPTER_NAME = "cline";
const EXTENSION_IDS = ["saoudrizwan.claude-dev"];

// ── Anthropic-style content blocks ─────────────────────────────────

interface TextBlock {
  type: "text";
  text?: string;
}

interface ToolUseBlock {
  type: "tool_use";
  id?: string;
  name?: string;
  input?: unknown;
}

interface ToolResultBlock {
  type: "tool_result";
  tool_use_id?: string;
  content?: unknown;
}

type ContentBlock = TextBlock | ToolUseBlock | ToolResultBlock | { type?: string };

interface RawTurn {
  role?: string;
  content?: string | ContentBlock[];
  [key: string]: unknown;
}

interface UiEvent {
  ts?: number;
  [key: string]: unknown;
}

interface TaskMetadata {
  cwd?: unknown;
  workspaceFolder?: unknown;
  workspaceRoot?: unknown;
  title?: unknown;
  taskTitle?: unknown;
  [key: string]: unknown;
}

// ── Reader factory ─────────────────────────────────────────────────

export function createClineSessionReader(homeDir?: string): SessionReader {
  const home = homeDir ?? homedir();
  const candidateDirs = () => resolveVSCodeExtensionStorage(EXTENSION_IDS, home);

  return {
    hasSessionStorage(): boolean {
      for (const dir of candidateDirs()) {
        if (existsSync(dir)) return true;
      }
      return false;
    },

    async listSessions(project?: string): Promise<SessionSummary[]> {
      const summaries: SessionSummary[] = [];

      for (const storageDir of candidateDirs()) {
        const tasksDir = join(storageDir, "tasks");
        if (!isDir(tasksDir)) continue;

        let entries: string[];
        try {
          entries = readdirSync(tasksDir);
        } catch {
          continue;
        }

        for (const taskId of entries) {
          if (!isSafeSessionId(taskId)) continue;
          const taskDir = join(tasksDir, taskId);
          if (!isDir(taskDir)) continue;

          const summary = summarizeTask(taskId, taskDir, storageDir);
          if (!summary) continue;
          if (project !== undefined && summary.project !== project) continue;
          summaries.push(summary);
        }
      }

      summaries.sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime());
      return summaries;
    },

    async loadSession(id: string): Promise<Session | null> {
      if (!isSafeSessionId(id)) return null;

      for (const storageDir of candidateDirs()) {
        const taskDir = join(storageDir, "tasks", id);
        if (!isDir(taskDir)) continue;

        const session = buildSession(id, taskDir, storageDir);
        if (session) return session;
      }
      return null;
    },
  };
}

// ── ID validation ──────────────────────────────────────────────────

/**
 * Allow only id-safe characters: letters, digits, `-`, `_`, `.`.
 * Rejects `..`, null bytes, slashes, backslashes, and any colon — Cline
 * taskIds are numeric ms-epoch strings, so the allowlist is intentionally
 * narrow.
 */
function isSafeSessionId(id: string): boolean {
  if (!id || typeof id !== "string") return false;
  if (id.includes("..")) return false;
  if (/[/\\\0]/.test(id)) return false;
  return /^[A-Za-z0-9._-]+$/.test(id);
}

// ── Filesystem helpers ─────────────────────────────────────────────

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function readJsonFile(filePath: string): unknown {
  let text: string;
  try {
    text = readFileSync(filePath, "utf-8");
  } catch {
    return undefined;
  }
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  try {
    return JSON.parse(trimmed);
  } catch {
    return undefined;
  }
}

function fileMtime(filePath: string): Date | undefined {
  try {
    return statSync(filePath).mtime;
  } catch {
    return undefined;
  }
}

// ── Per-task parsing ───────────────────────────────────────────────

interface ParsedTask {
  messages: Message[];
  startedAt: Date;
  endedAt?: Date;
  project?: string;
  title?: string;
}

function parseTask(taskId: string, taskDir: string): ParsedTask | null {
  const apiPath = join(taskDir, "api_conversation_history.json");
  const apiRaw = readJsonFile(apiPath);
  if (!Array.isArray(apiRaw)) return null;

  const messages = turnsToMessages(apiRaw as RawTurn[]);
  if (messages.length === 0) return null;

  // Timing: prefer ui_messages.json (first/last `ts`), then file mtime, then
  // taskId itself (numeric ms epoch string).
  let startedAt: Date | undefined;
  let endedAt: Date | undefined;

  const uiRaw = readJsonFile(join(taskDir, "ui_messages.json"));
  if (Array.isArray(uiRaw)) {
    const events = uiRaw as UiEvent[];
    const timestamps: number[] = [];
    for (const e of events) {
      if (e && typeof e.ts === "number" && Number.isFinite(e.ts) && e.ts > 0) {
        timestamps.push(e.ts);
      }
    }
    if (timestamps.length > 0) {
      startedAt = new Date(Math.min(...timestamps));
      endedAt = new Date(Math.max(...timestamps));
    }
  }

  if (!startedAt) {
    const fromTaskId = taskIdToDate(taskId);
    if (fromTaskId) startedAt = fromTaskId;
  }
  if (!startedAt) {
    startedAt = fileMtime(apiPath) ?? new Date(0);
  }
  if (!endedAt) {
    endedAt = fileMtime(apiPath);
  }

  // Optional metadata.
  let project: string | undefined;
  let title: string | undefined;

  const metaRaw = readJsonFile(join(taskDir, "task_metadata.json"));
  if (metaRaw && typeof metaRaw === "object" && !Array.isArray(metaRaw)) {
    const meta = metaRaw as TaskMetadata;
    project = pickFirstString(meta.cwd, meta.workspaceFolder, meta.workspaceRoot);
    title = pickFirstString(meta.title, meta.taskTitle);
  }

  return { messages, startedAt, endedAt, project, title };
}

function summarizeTask(taskId: string, taskDir: string, storageDir: string): SessionSummary | null {
  const parsed = parseTask(taskId, taskDir);
  if (!parsed) return null;
  // storageDir reserved for future surfacing in summaries; not needed today.
  void storageDir;

  let totalText = "";
  for (const m of parsed.messages) totalText += m.content;

  return {
    id: taskId,
    adapter: ADAPTER_NAME,
    project: parsed.project,
    messageCount: parsed.messages.length,
    startedAt: parsed.startedAt,
    endedAt: parsed.endedAt,
    estimatedTokens: estimateTokens(totalText),
  };
}

function buildSession(taskId: string, taskDir: string, storageDir: string): Session | null {
  const parsed = parseTask(taskId, taskDir);
  if (!parsed) return null;

  const metadata: Record<string, unknown> = {
    taskId,
    storageDir,
  };
  if (parsed.title !== undefined) metadata.title = parsed.title;

  return {
    id: taskId,
    adapter: ADAPTER_NAME,
    project: parsed.project,
    messages: parsed.messages,
    startedAt: parsed.startedAt,
    endedAt: parsed.endedAt,
    metadata,
  };
}

// ── Message construction ───────────────────────────────────────────

/**
 * Convert Anthropic-style turns into the core Message shape.
 *
 * Tool-use/tool-result pairing strategy:
 *   - text blocks concat into the message content
 *   - tool_use blocks attach as ToolCall on the producing message
 *   - tool_result blocks try to attach `output` to the matching tool_use
 *     (by `tool_use_id`); if no pair is found we emit a separate `tool`
 *     role message carrying the result text.
 */
function turnsToMessages(turns: RawTurn[]): Message[] {
  // First pass: collect tool_results keyed by tool_use_id so we can attach
  // their output to the producing tool_use during the build pass.
  const resultsById = new Map<string, string>();
  const orphanResults: Array<{ turnIndex: number; content: string }> = [];

  for (let i = 0; i < turns.length; i++) {
    const turn = turns[i];
    if (!turn || typeof turn !== "object") continue;
    if (!Array.isArray(turn.content)) continue;
    for (const block of turn.content) {
      if (!block || typeof block !== "object") continue;
      const b = block as Record<string, unknown>;
      if (b.type !== "tool_result") continue;
      const idRaw = b.tool_use_id;
      const text = toolResultContentToString(b.content);
      if (typeof idRaw === "string" && idRaw.length > 0) {
        // Last write wins (rare); but typically each id appears once.
        resultsById.set(idRaw, text);
      } else {
        orphanResults.push({ turnIndex: i, content: text });
      }
    }
  }

  const messages: Message[] = [];
  for (let i = 0; i < turns.length; i++) {
    const turn = turns[i];
    if (!turn || typeof turn !== "object") continue;

    const role = mapRole(turn.role);
    const textParts: string[] = [];
    const toolCalls: ToolCall[] = [];

    if (typeof turn.content === "string") {
      if (turn.content.length > 0) textParts.push(turn.content);
    } else if (Array.isArray(turn.content)) {
      for (const block of turn.content) {
        if (!block || typeof block !== "object") continue;
        const b = block as Record<string, unknown>;
        if (b.type === "text") {
          if (typeof b.text === "string" && b.text.length > 0) {
            textParts.push(b.text);
          }
          continue;
        }
        if (b.type === "tool_use") {
          const name = typeof b.name === "string" && b.name.length > 0 ? b.name : "unknown";
          const id = typeof b.id === "string" ? b.id : undefined;
          const tc: ToolCall = { name };
          if (b.input !== undefined) tc.input = b.input;
          if (id && resultsById.has(id)) {
            const out = resultsById.get(id);
            if (out !== undefined && out.length > 0) tc.output = out;
            resultsById.delete(id);
          }
          toolCalls.push(tc);
        }
        // tool_result blocks are pre-processed into resultsById in the
        // first pass; skip here to avoid duplicating into text content.
      }
    }

    const content = textParts.join("");
    if (content || toolCalls.length > 0) {
      const msg: Message = {
        role,
        content,
      };
      if (toolCalls.length > 0) msg.toolCalls = toolCalls;
      messages.push(msg);
    }

    // Surface orphan tool_results that originated in THIS turn as separate
    // tool-role messages, immediately after the producing turn.
    for (const orphan of orphanResults) {
      if (orphan.turnIndex !== i) continue;
      if (!orphan.content) continue;
      messages.push({ role: "tool", content: orphan.content });
    }
  }

  // Any tool_use_ids whose results we never paired into a tool_use can also
  // be surfaced — but keep this strict: only emit if we never matched. The
  // common case (assistant emits tool_use, next user turn carries tool_result)
  // is already handled by the keyed map above.
  for (const [, output] of resultsById) {
    if (!output) continue;
    messages.push({ role: "tool", content: output });
  }

  return messages;
}

function mapRole(role: unknown): Message["role"] {
  if (typeof role !== "string") return "system";
  const r = role.toLowerCase();
  if (r === "user" || r === "human") return "user";
  if (r === "assistant" || r === "ai" || r === "bot") return "assistant";
  if (r === "tool" || r === "function") return "tool";
  return "system";
}

/**
 * tool_result `content` may be a string, an array of `{type:"text",text}`
 * blocks, or undefined. Reduce to a single string for storage as
 * ToolCall.output (a string field on the core schema).
 */
function toolResultContentToString(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (typeof block === "string") {
      parts.push(block);
      continue;
    }
    if (block && typeof block === "object") {
      const b = block as Record<string, unknown>;
      if (b.type === "text" && typeof b.text === "string") parts.push(b.text);
    }
  }
  return parts.join("");
}

// ── Misc helpers ───────────────────────────────────────────────────

function pickFirstString(...candidates: unknown[]): string | undefined {
  for (const c of candidates) {
    if (typeof c === "string" && c.length > 0) return c;
  }
  return undefined;
}

function taskIdToDate(taskId: string): Date | undefined {
  if (!/^\d+$/.test(taskId)) return undefined;
  const n = Number(taskId);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return new Date(n);
}
