/**
 * Cursor session reader (ADR-0016).
 *
 * Cursor is a VS Code fork that has shipped two chat-storage schemas:
 *
 *   1. Per-workspace (legacy + still in use): `User/workspaceStorage/<hash>/
 *      state.vscdb` → `ItemTable` keys such as
 *      `workbench.panel.aichat.view.aichat.chatdata` (current),
 *      `aiService.prompts` / `aiService.generations` (older).
 *      Session id: `<workspace-hash>:<tabId>`.
 *
 *   2. Modern globalStorage (Cursor 3.0+): `User/globalStorage/state.vscdb`
 *      → `cursorDiskKV` table with row shapes
 *      `composerData:<composerId>` (header listing bubble ids in order) and
 *      `bubbleId:<composerId>:<bubbleId>` (per-message rows).
 *      Session id: `global:composer-<composerId>` (single colon preserves
 *      the existing `isSafeSessionId` contract).
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

/**
 * SQLite default `SQLITE_MAX_VARIABLE_NUMBER` is 999 and bun:sqlite inherits
 * that limit. Cap `WHERE key IN (...)` lookups at 500 to leave headroom.
 */
const SQLITE_PARAM_CHUNK = 500;

const GLOBAL_PREFIX = "global:composer-";

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

function globalStorageDbPath(userDir: string): string {
  return join(userDir, "globalStorage", "state.vscdb");
}

// ── Loose record shapes (everything optional) ──────────────────────

interface BubbleRecord {
  /** Legacy: "user"/"ai"/etc. Modern: numeric (1=user, 2=assistant). */
  type?: string | number;
  role?: string;
  text?: string;
  /** Modern fallback when `text` is empty. */
  richText?: string;
  content?: unknown;
  timestamp?: number | string;
  /** Modern timing wrapper — `clientStartTime` preferred over `timestamp`. */
  timingInfo?: { clientStartTime?: number; clientEndTime?: number };
  toolCalls?: ToolCallRecord[];
  tool_calls?: ToolCallRecord[];
  /** Modern tool-call evidence (loose shape, undocumented). */
  toolFormerData?: unknown;
  capabilitiesRan?: unknown[];
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

/** Modern globalStorage `composerData:<id>` row shape. */
interface ComposerHeader {
  composerId?: string;
  name?: string;
  createdAt?: number;
  lastUpdatedAt?: number;
  fullConversationHeadersOnly?: Array<{
    bubbleId?: string;
    type?: number | string;
    serverBubbleId?: string;
  }>;
  [key: string]: unknown;
}

// ── Reader factory ─────────────────────────────────────────────────

export function createCursorSessionReader(homeDir?: string): SessionReader {
  const home = homeDir ?? homedir();
  const userDir = cursorUserDir(home);
  const storageDir = workspaceStorageDir(userDir);

  return {
    hasSessionStorage(): boolean {
      return existsSync(storageDir) || existsSync(globalStorageDbPath(userDir));
    },

    async listSessions(project?: string): Promise<SessionSummary[]> {
      const summaries: SessionSummary[] = [];

      // Per-workspace (legacy) sessions.
      if (existsSync(storageDir)) {
        let hashes: string[] = [];
        try {
          hashes = readdirSync(storageDir);
        } catch {
          hashes = [];
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
      }

      // Modern globalStorage composers carry no workspace folder, so when a
      // project filter is provided they cannot match — skip them entirely.
      if (!project) {
        for (const session of readGlobalComposers(userDir)) {
          summaries.push(toSummary(session));
        }
      }

      summaries.sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime());
      return summaries;
    },

    async loadSession(id: string): Promise<Session | null> {
      if (!isSafeSessionId(id)) return null;

      // Modern globalStorage path: `global:composer-<composerId>`.
      if (id.startsWith("global:")) {
        if (!id.startsWith(GLOBAL_PREFIX)) return null;
        const composerId = id.slice(GLOBAL_PREFIX.length);
        if (!composerId) return null;
        return loadGlobalComposer(userDir, composerId);
      }

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
    const ts = bubbleTimestamp(b);

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
  // Modern bubbles use numeric types: 1 = user, 2 = assistant.
  if (typeof b.type === "number") {
    if (b.type === 1) return "user";
    if (b.type === 2) return "assistant";
  }
  const raw = (b.type ?? b.role ?? "").toString().toLowerCase();
  if (raw === "user" || raw === "human") return "user";
  if (raw === "ai" || raw === "assistant" || raw === "bot") return "assistant";
  if (raw === "tool" || raw === "function") return "tool";
  return "system";
}

function extractText(b: BubbleRecord): string | null {
  if (typeof b.text === "string" && b.text.length > 0) return b.text;
  if (typeof b.richText === "string" && b.richText.length > 0) return b.richText;
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

/**
 * Extract a bubble timestamp, preferring the modern `timingInfo.clientStartTime`
 * wrapper before falling back to the legacy top-level `timestamp`.
 */
function bubbleTimestamp(b: BubbleRecord): Date | undefined {
  const timing = b.timingInfo;
  if (timing && typeof timing.clientStartTime === "number") {
    const d = tsToDate(timing.clientStartTime);
    if (d) return d;
  }
  return tsToDate(b.timestamp);
}

function extractToolCalls(b: BubbleRecord): ToolCall[] {
  // Legacy shape — preserve "unknown" fallback for missing names.
  const raw = b.toolCalls ?? b.tool_calls;
  if (Array.isArray(raw)) {
    const calls: ToolCall[] = [];
    for (const r of raw) {
      const tc = toolCallFromRecord(r, true);
      if (tc) calls.push(tc);
    }
    return calls;
  }

  // Modern bubbles: `toolFormerData` is a single tool-call-shaped object.
  if (b.toolFormerData && typeof b.toolFormerData === "object") {
    const tc = toolCallFromRecord(b.toolFormerData, false);
    if (tc) return [tc];
  }

  // Modern bubbles: `capabilitiesRan` is an array of tool-call-shaped objects.
  if (Array.isArray(b.capabilitiesRan)) {
    const calls: ToolCall[] = [];
    for (const r of b.capabilitiesRan) {
      const tc = toolCallFromRecord(r, false);
      if (tc) calls.push(tc);
    }
    return calls;
  }

  return [];
}

function toolCallFromRecord(r: unknown, allowUnknownName: boolean): ToolCall | null {
  if (!r || typeof r !== "object") return null;
  const rec = r as ToolCallRecord & { tool?: unknown; args?: unknown };

  const nameRaw =
    typeof rec.name === "string"
      ? rec.name
      : typeof rec.toolName === "string"
        ? rec.toolName
        : typeof rec.tool === "string"
          ? rec.tool
          : undefined;
  if (!nameRaw && !allowUnknownName) return null;
  const name = nameRaw ?? "unknown";

  const input =
    rec.input !== undefined
      ? rec.input
      : rec.args !== undefined
        ? rec.args
        : maybeParseJson(rec.arguments);

  const output =
    typeof rec.output === "string"
      ? rec.output
      : typeof rec.result === "string"
        ? rec.result
        : rec.output !== undefined
          ? safeStringify(rec.output)
          : rec.result !== undefined
            ? safeStringify(rec.result)
            : undefined;

  return {
    name,
    ...(input !== undefined && { input }),
    ...(output !== undefined && { output }),
  };
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

// ── Modern globalStorage (cursorDiskKV) ────────────────────────────

/**
 * Read every composer header in `globalStorage/state.vscdb` and resolve its
 * bubble messages. Returns full `Session` objects so callers can either keep
 * them or summarise via `toSummary`. Defensive at every boundary: missing DB,
 * missing table, malformed JSON, and missing bubble rows are all skipped.
 */
function readGlobalComposers(userDir: string): Session[] {
  const dbPath = globalStorageDbPath(userDir);
  if (!existsSync(dbPath)) return [];

  let db: Database | null = null;
  try {
    db = new Database(dbPath, { readonly: true });

    let headerRows: DbRow[];
    try {
      const stmt = db.query("SELECT key, value FROM cursorDiskKV WHERE key LIKE 'composerData:%'");
      headerRows = stmt.all() as DbRow[];
    } catch {
      // Table missing on older Cursor installs — silently skip.
      return [];
    }

    const sessions: Session[] = [];
    for (const row of headerRows) {
      const session = composerSessionFromHeader(db, row);
      if (session) sessions.push(session);
    }
    return sessions;
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

function loadGlobalComposer(userDir: string, composerId: string): Session | null {
  const dbPath = globalStorageDbPath(userDir);
  if (!existsSync(dbPath)) return null;

  let db: Database | null = null;
  try {
    db = new Database(dbPath, { readonly: true });
    let row: DbRow | null;
    try {
      const stmt = db.query("SELECT key, value FROM cursorDiskKV WHERE key = ?");
      row = (stmt.get(`composerData:${composerId}`) as DbRow | null) ?? null;
    } catch {
      return null;
    }
    if (!row) return null;
    return composerSessionFromHeader(db, row);
  } catch {
    return null;
  } finally {
    try {
      db?.close();
    } catch {
      // ignore
    }
  }
}

function composerSessionFromHeader(db: Database, row: DbRow): Session | null {
  const text = blobToText(row.value);
  if (!text) return null;
  let header: ComposerHeader;
  try {
    header = JSON.parse(text) as ComposerHeader;
  } catch {
    return null;
  }
  if (!header || typeof header !== "object") return null;

  const composerId =
    typeof header.composerId === "string" ? header.composerId : composerIdFromKey(row.key);
  if (!composerId) return null;

  const headers = Array.isArray(header.fullConversationHeadersOnly)
    ? header.fullConversationHeadersOnly
    : [];
  if (headers.length === 0) return null;

  const bubbles = fetchBubbles(db, composerId, headers);
  const messages = bubblesToMessages(bubbles);
  if (messages.length === 0) return null;

  const startedAt = tsToDate(header.createdAt) ?? messages[0]?.timestamp ?? new Date(0);
  const endedAt = tsToDate(header.lastUpdatedAt) ?? messages[messages.length - 1]?.timestamp;

  const metadata: Record<string, unknown> = { composerId };
  if (typeof header.name === "string") metadata.title = header.name;

  let totalText = "";
  for (const m of messages) totalText += m.content;

  return {
    id: `${GLOBAL_PREFIX}${composerId}`,
    adapter: ADAPTER_NAME,
    project: undefined,
    messages,
    startedAt,
    endedAt,
    metadata,
  };
}

/**
 * Walk `fullConversationHeadersOnly` IN ORDER and resolve each `bubbleId` row
 * from `cursorDiskKV`. Missing bubble rows are skipped. Order is preserved
 * (we don't sort by timestamp — the array is the source of truth).
 */
function fetchBubbles(
  db: Database,
  composerId: string,
  headers: NonNullable<ComposerHeader["fullConversationHeadersOnly"]>,
): BubbleRecord[] {
  const keys: string[] = [];
  for (const h of headers) {
    if (h && typeof h.bubbleId === "string" && h.bubbleId.length > 0) {
      keys.push(`bubbleId:${composerId}:${h.bubbleId}`);
    }
  }
  if (keys.length === 0) return [];

  const valueByKey = new Map<string, string>();
  for (let i = 0; i < keys.length; i += SQLITE_PARAM_CHUNK) {
    const chunk = keys.slice(i, i + SQLITE_PARAM_CHUNK);
    const placeholders = chunk.map(() => "?").join(", ");
    try {
      const stmt = db.query(`SELECT key, value FROM cursorDiskKV WHERE key IN (${placeholders})`);
      const rows = stmt.all(...chunk) as DbRow[];
      for (const r of rows) {
        const text = blobToText(r.value);
        if (text !== null) valueByKey.set(r.key, text);
      }
    } catch {
      // Defensive: ignore chunk failure, return whatever we have.
    }
  }

  const bubbles: BubbleRecord[] = [];
  for (const key of keys) {
    const text = valueByKey.get(key);
    if (text === undefined) continue; // missing row — skip silently
    try {
      const parsed = JSON.parse(text) as BubbleRecord;
      if (parsed && typeof parsed === "object") bubbles.push(parsed);
    } catch {
      // malformed bubble JSON — skip
    }
  }
  return bubbles;
}

function composerIdFromKey(key: string): string | undefined {
  // `composerData:<id>` — recover id when header.composerId is missing.
  const prefix = "composerData:";
  if (key.startsWith(prefix)) return key.slice(prefix.length);
  return undefined;
}

function toSummary(session: Session): SessionSummary {
  let totalText = "";
  for (const m of session.messages) totalText += m.content;
  return {
    id: session.id,
    adapter: session.adapter,
    project: session.project,
    messageCount: session.messages.length,
    startedAt: session.startedAt,
    endedAt: session.endedAt,
    estimatedTokens: estimateTokens(totalText),
  };
}
