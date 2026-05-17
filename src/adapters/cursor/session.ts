/**
 * Cursor session reader (ADR-0016).
 *
 * Cursor is a VS Code fork; it stores chat/composer history in a per-workspace
 * SQLite database at `User/workspaceStorage/<hash>/state.vscdb`. The chat blobs
 * live in the `ItemTable` key/value table under keys such as
 * `workbench.panel.aichat.view.aichat.chatdata` (current),
 * `aiService.prompts` / `aiService.generations` (older).
 *
 * Session id format: `<workspace-hash>:<tabId>`.
 *
 * The reader is intentionally defensive — Cursor's schema is undocumented and
 * shifts between releases. Every field is treated as optional and malformed
 * rows are skipped rather than thrown.
 */

import { Database } from "bun:sqlite";
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

const ADAPTER_NAME = "cursor";

/** Keys inside `ItemTable` that may hold chat/composer history. */
const CHAT_KEYS = [
  "workbench.panel.aichat.view.aichat.chatdata",
  "aiService.prompts",
  "aiService.generations",
];

// ── Cross-platform path resolution ─────────────────────────────────

function cursorUserDir(homeDir: string): string {
  if (process.platform === "darwin") {
    return join(homeDir, "Library/Application Support/Cursor/User");
  }
  if (process.platform === "win32") {
    if (process.env.APPDATA) return join(process.env.APPDATA, "Cursor/User");
    return join(homeDir, "AppData/Roaming/Cursor/User");
  }
  return join(homeDir, ".config/Cursor/User");
}

function workspaceStorageDir(userDir: string): string {
  return join(userDir, "workspaceStorage");
}

// ── Loose record shapes (everything optional) ──────────────────────

interface BubbleRecord {
  type?: string;
  role?: string;
  text?: string;
  content?: unknown;
  timestamp?: number | string;
  toolCalls?: ToolCallRecord[];
  tool_calls?: ToolCallRecord[];
  [key: string]: unknown;
}

interface ToolCallRecord {
  name?: string;
  toolName?: string;
  input?: unknown;
  arguments?: unknown;
  output?: unknown;
  result?: unknown;
  [key: string]: unknown;
}

interface TabRecord {
  tabId?: string;
  id?: string;
  chatTitle?: string;
  title?: string;
  createdAt?: number | string;
  lastSendTime?: number | string;
  bubbles?: BubbleRecord[];
  messages?: BubbleRecord[];
  [key: string]: unknown;
}

interface ChatdataRecord {
  tabs?: TabRecord[];
  [key: string]: unknown;
}

// ── Reader factory ─────────────────────────────────────────────────

export function createCursorSessionReader(homeDir?: string): SessionReader {
  const home = homeDir ?? homedir();
  const userDir = cursorUserDir(home);
  const storageDir = workspaceStorageDir(userDir);

  return {
    hasSessionStorage(): boolean {
      return existsSync(storageDir);
    },

    async listSessions(project?: string): Promise<SessionSummary[]> {
      if (!existsSync(storageDir)) return [];

      const summaries: SessionSummary[] = [];
      let hashes: string[];
      try {
        hashes = readdirSync(storageDir);
      } catch {
        return [];
      }

      for (const hash of hashes) {
        const wsDir = join(storageDir, hash);
        if (!isDir(wsDir)) continue;

        const dbPath = join(wsDir, "state.vscdb");
        if (!existsSync(dbPath)) continue;

        const projectPath = readWorkspaceFolder(wsDir);
        if (project && projectPath !== project) continue;

        const tabs = readTabsFromDb(dbPath);
        for (const tab of tabs) {
          const summary = summarizeTab(hash, tab, projectPath);
          if (summary) summaries.push(summary);
        }
      }

      summaries.sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime());
      return summaries;
    },

    async loadSession(id: string): Promise<Session | null> {
      if (!isSafeSessionId(id)) return null;

      const sep = id.indexOf(":");
      if (sep <= 0 || sep === id.length - 1) return null;

      const hash = id.slice(0, sep);
      const tabId = id.slice(sep + 1);

      const wsDir = join(storageDir, hash);
      const dbPath = join(wsDir, "state.vscdb");
      if (!existsSync(dbPath)) return null;

      const projectPath = readWorkspaceFolder(wsDir);
      const tabs = readTabsFromDb(dbPath);

      for (const tab of tabs) {
        const tId = tabIdOf(tab);
        if (tId === tabId) {
          return buildSession(hash, tab, projectPath);
        }
      }
      return null;
    },
  };
}

// ── ID validation ──────────────────────────────────────────────────

/**
 * Allow only id-safe characters in the composite id `<hash>:<tabId>`:
 * letters, digits, `-`, `_`, `.`, and exactly one `:` separator.
 * Rejects `..`, null bytes, slashes, backslashes.
 */
function isSafeSessionId(id: string): boolean {
  if (!id || typeof id !== "string") return false;
  if (id.includes("..")) return false;
  if (/[/\\\0]/.test(id)) return false;
  if (!/^[A-Za-z0-9._:-]+$/.test(id)) return false;
  // Require exactly one colon separator (workspace:tab).
  const colonCount = (id.match(/:/g) ?? []).length;
  if (colonCount !== 1) return false;
  return true;
}

// ── Filesystem helpers ─────────────────────────────────────────────

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function readWorkspaceFolder(wsDir: string): string | undefined {
  const wsJson = join(wsDir, "workspace.json");
  if (!existsSync(wsJson)) return undefined;
  try {
    const raw = readFileSync(wsJson, "utf-8");
    const parsed = JSON.parse(raw) as { folder?: unknown; workspace?: unknown };
    if (typeof parsed.folder === "string") {
      return fileUriToPath(parsed.folder);
    }
    if (typeof parsed.workspace === "string") {
      return fileUriToPath(parsed.workspace);
    }
  } catch {
    // Defensive: ignore malformed workspace.json
  }
  return undefined;
}

function fileUriToPath(uri: string): string {
  if (uri.startsWith("file://")) {
    try {
      return decodeURIComponent(uri.slice("file://".length));
    } catch {
      return uri.slice("file://".length);
    }
  }
  return uri;
}

// ── SQLite reading ─────────────────────────────────────────────────

interface DbRow {
  key: string;
  value: string | Uint8Array;
}

function readTabsFromDb(dbPath: string): TabRecord[] {
  let db: Database | null = null;
  try {
    db = new Database(dbPath, { readonly: true });
    const placeholders = CHAT_KEYS.map(() => "?").join(", ");
    const stmt = db.query(`SELECT key, value FROM ItemTable WHERE key IN (${placeholders})`);
    const rows = stmt.all(...CHAT_KEYS) as DbRow[];

    const tabs: TabRecord[] = [];
    for (const row of rows) {
      const text = blobToText(row.value);
      if (!text) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        continue;
      }
      tabs.push(...extractTabs(parsed));
    }
    return tabs;
  } catch {
    return [];
  } finally {
    try {
      db?.close();
    } catch {
      // ignore
    }
  }
}

function blobToText(value: string | Uint8Array): string | null {
  if (typeof value === "string") return value;
  if (value instanceof Uint8Array) {
    try {
      return new TextDecoder("utf-8").decode(value);
    } catch {
      return null;
    }
  }
  return null;
}

function extractTabs(parsed: unknown): TabRecord[] {
  if (!parsed || typeof parsed !== "object") return [];

  const root = parsed as ChatdataRecord;
  if (Array.isArray(root.tabs)) {
    return root.tabs.filter((t): t is TabRecord => !!t && typeof t === "object");
  }
  // Some older shapes are arrays of tab-like records directly.
  if (Array.isArray(parsed)) {
    return (parsed as unknown[]).filter((t): t is TabRecord => !!t && typeof t === "object");
  }
  return [];
}

// ── Session construction ───────────────────────────────────────────

function tabIdOf(tab: TabRecord): string | undefined {
  if (typeof tab.tabId === "string") return tab.tabId;
  if (typeof tab.id === "string") return tab.id;
  return undefined;
}

function bubblesOf(tab: TabRecord): BubbleRecord[] {
  if (Array.isArray(tab.bubbles)) return tab.bubbles;
  if (Array.isArray(tab.messages)) return tab.messages;
  return [];
}

function tsToDate(ts: number | string | undefined): Date | undefined {
  if (ts === undefined || ts === null) return undefined;
  if (typeof ts === "number") {
    if (!Number.isFinite(ts)) return undefined;
    return new Date(ts);
  }
  if (typeof ts === "string") {
    const d = new Date(ts);
    return Number.isNaN(d.getTime()) ? undefined : d;
  }
  return undefined;
}

function summarizeTab(
  hash: string,
  tab: TabRecord,
  project: string | undefined,
): SessionSummary | null {
  const tabId = tabIdOf(tab);
  if (!tabId) return null;

  const bubbles = bubblesOf(tab);
  const messages = bubblesToMessages(bubbles);
  if (messages.length === 0) return null;

  const startedAt = tsToDate(tab.createdAt) ?? messages[0]?.timestamp ?? new Date(0);
  const endedAt = tsToDate(tab.lastSendTime) ?? messages[messages.length - 1]?.timestamp;

  let totalText = "";
  for (const m of messages) totalText += m.content;

  return {
    id: `${hash}:${tabId}`,
    adapter: ADAPTER_NAME,
    project,
    messageCount: messages.length,
    startedAt,
    endedAt,
    estimatedTokens: estimateTokens(totalText),
  };
}

function buildSession(hash: string, tab: TabRecord, project: string | undefined): Session | null {
  const tabId = tabIdOf(tab);
  if (!tabId) return null;

  const bubbles = bubblesOf(tab);
  const messages = bubblesToMessages(bubbles);
  if (messages.length === 0) return null;

  const startedAt = tsToDate(tab.createdAt) ?? messages[0]?.timestamp ?? new Date(0);
  const endedAt = tsToDate(tab.lastSendTime) ?? messages[messages.length - 1]?.timestamp;

  const metadata: Record<string, unknown> = {};
  if (typeof tab.chatTitle === "string") metadata.title = tab.chatTitle;
  else if (typeof tab.title === "string") metadata.title = tab.title;
  metadata.workspaceHash = hash;

  return {
    id: `${hash}:${tabId}`,
    adapter: ADAPTER_NAME,
    project,
    messages,
    startedAt,
    endedAt,
    metadata,
  };
}

function bubblesToMessages(bubbles: BubbleRecord[]): Message[] {
  const out: Message[] = [];
  for (const b of bubbles) {
    if (!b || typeof b !== "object") continue;

    const role = mapRole(b);
    const content = extractText(b);
    const toolCalls = extractToolCalls(b);
    const ts = tsToDate(b.timestamp);

    if (!content && toolCalls.length === 0) continue;

    const msg: Message = {
      role,
      content: content ?? "",
      ...(ts && { timestamp: ts }),
      ...(toolCalls.length > 0 && { toolCalls }),
    };
    out.push(msg);
  }
  return out;
}

function mapRole(b: BubbleRecord): Message["role"] {
  const raw = (b.type ?? b.role ?? "").toString().toLowerCase();
  if (raw === "user" || raw === "human") return "user";
  if (raw === "ai" || raw === "assistant" || raw === "bot") return "assistant";
  if (raw === "tool" || raw === "function") return "tool";
  return "system";
}

function extractText(b: BubbleRecord): string | null {
  if (typeof b.text === "string" && b.text.length > 0) return b.text;
  if (typeof b.content === "string" && b.content.length > 0) return b.content;
  if (Array.isArray(b.content)) {
    const parts: string[] = [];
    for (const block of b.content) {
      if (!block || typeof block !== "object") continue;
      const blk = block as { type?: string; text?: string };
      if (blk.type === "text" && typeof blk.text === "string") {
        parts.push(blk.text);
      }
    }
    if (parts.length > 0) return parts.join("\n");
  }
  return null;
}

function extractToolCalls(b: BubbleRecord): ToolCall[] {
  const raw = b.toolCalls ?? b.tool_calls;
  if (!Array.isArray(raw)) return [];

  const calls: ToolCall[] = [];
  for (const r of raw) {
    if (!r || typeof r !== "object") continue;
    const name =
      typeof r.name === "string" ? r.name : typeof r.toolName === "string" ? r.toolName : "unknown";
    const input = r.input !== undefined ? r.input : maybeParseJson(r.arguments);
    const output =
      typeof r.output === "string"
        ? r.output
        : typeof r.result === "string"
          ? r.result
          : r.output !== undefined
            ? safeStringify(r.output)
            : r.result !== undefined
              ? safeStringify(r.result)
              : undefined;

    calls.push({
      name,
      ...(input !== undefined && { input }),
      ...(output !== undefined && { output }),
    });
  }
  return calls;
}

function maybeParseJson(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function safeStringify(value: unknown): string | undefined {
  try {
    return JSON.stringify(value);
  } catch {
    return undefined;
  }
}
