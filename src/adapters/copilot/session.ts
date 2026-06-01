/**
 * GitHub Copilot Chat session reader (ADR-0016).
 *
 * Reads chat session JSON files from the VS Code extension globalStorage of
 * the `GitHub.copilot-chat` extension across every supported VS Code variant
 * (VS Code stable, Insiders, VSCodium, Cursor, Windsurf, ...).
 *
 * Layout is unstable across versions — historically observed:
 *   - <globalStorage>/<sessionId>.json
 *   - <globalStorage>/chatSessions/<sessionId>.json
 *   - <globalStorage>/chatEditingSessions/...   (skipped, not chat sessions)
 *   - <globalStorage>/interactiveSessions.json   (legacy aggregate, optional)
 *
 * Per ADR-0016 we parse defensively: malformed / non-session JSON files are
 * skipped silently. Schema fields have churned, so the parser accepts every
 * casing/shape we have seen in the wild.
 */

import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import type { Message, Session, SessionReader, SessionSummary } from "../../core/session.ts";
import { estimateTokens } from "../../core/session.ts";
import { resolveVSCodeExtensionStorage } from "../shared/vscode-paths.ts";

const ADAPTER_NAME = "copilot";
const DEFAULT_EXTENSION_IDS = ["GitHub.copilot-chat", "github.copilot-chat"];

// ── Raw session JSON shapes (loose, schema-permissive) ──────────────

interface RawRequest {
  message?: unknown;
  request?: unknown;
  response?: unknown;
  result?: unknown;
  timestamp?: number | string;
  [key: string]: unknown;
}

interface RawSession {
  version?: number;
  sessionId?: string;
  id?: string;
  guid?: string;
  creationDate?: number | string;
  lastMessageDate?: number | string;
  startTimestamp?: number | string;
  requesterUsername?: string;
  requests?: RawRequest[];
  customTitle?: string;
  cwd?: string;
  workspaceFolder?: string;
  workspaceUri?: string;
  [key: string]: unknown;
}

// ── SessionReader factory ───────────────────────────────────────────

export function createCopilotSessionReader(
  homeDir?: string,
  opts?: { extensionIds?: string[] },
): SessionReader {
  const home = homeDir ?? homedir();
  const extensionIds = opts?.extensionIds ?? DEFAULT_EXTENSION_IDS;
  // De-dupe physically-identical candidate dirs. resolveVSCodeExtensionStorage
  // emits one path per (VS Code variant × extension-id casing). On
  // case-insensitive filesystems (macOS APFS, Windows NTFS) the multiple
  // ID casings collapse onto the SAME physical directory, so without this the
  // reader would scan each session file once per casing and double-count
  // results. Keying on realpathSync collapses those aliases to one entry while
  // remaining a no-op on case-sensitive Linux.
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
        for (const file of scanSessionFiles(dir)) {
          const summary = summarizeSession(file, project);
          if (summary) summaries.push(summary);
        }
      }

      summaries.sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime());
      return summaries;
    },

    async loadSession(id: string): Promise<Session | null> {
      const safeId = id.replace(/\.json$/, "");
      if (/[/\\\0]|\.\./.test(safeId)) {
        return null;
      }

      for (const dir of candidateDirs()) {
        if (!existsSync(dir)) continue;
        for (const file of scanSessionFiles(dir)) {
          const session = parseSessionFull(file, dir);
          if (session && session.id === safeId) {
            return session;
          }
        }
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
 * extension-id casings we probe (`GitHub.copilot-chat` vs
 * `github.copilot-chat`) point at one on-disk directory, so scanning every
 * candidate would visit the same session files multiple times. Keying on
 * `realpathSync` de-dupes those aliases. Paths that don't exist yet (no
 * realpath) fall back to the literal string so they stay distinct and the
 * caller's `existsSync` guard still works.
 */
function dedupeByRealpath(dirs: string[]): string[] {
  // On case-INsensitive filesystems (Windows NTFS, macOS APFS/HFS+) two
  // candidate paths that differ only by the casing of the extension-id segment
  // (`GitHub.copilot-chat` vs `github.copilot-chat`) name ONE physical
  // directory. `realpathSync` is supposed to canonicalize them to an identical
  // string, but on Windows it does not reliably case-fold every path segment,
  // so the raw realpath strings can still differ and the Set fails to collapse
  // the alias — making listSessions scan the same files twice and double-count.
  // Case-folding the dedup key on case-insensitive platforms makes the collapse
  // deterministic. It is a no-op on case-sensitive Linux, where the two casings
  // are genuinely distinct directories.
  const caseInsensitiveFs = process.platform === "win32" || process.platform === "darwin";
  const seen = new Set<string>();
  const out: string[] = [];
  for (const dir of dirs) {
    let key: string;
    try {
      key = realpathSync(dir);
    } catch {
      key = dir;
    }
    if (caseInsensitiveFs) key = key.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(dir);
  }
  return out;
}

// ── File scanning ───────────────────────────────────────────────────

/**
 * Recursively collect `*.json` files under the extension storage dir.
 * Skips `chatEditingSessions/` (those are edit-state, not chat sessions).
 */
function scanSessionFiles(rootDir: string): string[] {
  const results: string[] = [];

  const walk = (dir: string) => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry === "chatEditingSessions") continue;
      const full = join(dir, entry);
      let stat: ReturnType<typeof statSync>;
      try {
        stat = statSync(full);
      } catch {
        continue;
      }
      if (stat.isDirectory()) {
        walk(full);
      } else if (stat.isFile() && entry.endsWith(".json")) {
        results.push(full);
      }
    }
  };

  walk(rootDir);
  return results;
}

// ── JSON parsing ────────────────────────────────────────────────────

function readSessionJson(filePath: string): RawSession | null {
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
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }
  return parsed as RawSession;
}

/** Coerce ms-epoch number, ISO string, or numeric string into a Date. */
function coerceDate(value: number | string | undefined): Date | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value <= 0) return undefined;
    return new Date(value);
  }
  if (typeof value === "string") {
    if (!value) return undefined;
    // Numeric strings → ms epoch
    const asNum = Number(value);
    if (Number.isFinite(asNum) && /^\d+$/.test(value)) {
      return new Date(asNum);
    }
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? undefined : d;
  }
  return undefined;
}

function pickId(raw: RawSession, filePath: string): string {
  const id = raw.sessionId ?? raw.id ?? raw.guid;
  if (typeof id === "string" && id.length > 0) return id;
  return basename(filePath, ".json");
}

function pickStart(raw: RawSession): Date | undefined {
  return (
    coerceDate(raw.creationDate) ??
    coerceDate(raw.startTimestamp) ??
    coerceDate(raw.lastMessageDate)
  );
}

function pickProject(raw: RawSession): string | undefined {
  if (typeof raw.cwd === "string" && raw.cwd) return raw.cwd;
  if (typeof raw.workspaceFolder === "string" && raw.workspaceFolder) {
    return raw.workspaceFolder;
  }
  if (typeof raw.workspaceUri === "string" && raw.workspaceUri) {
    return raw.workspaceUri;
  }
  return undefined;
}

/**
 * Extract the user-visible text from a request's message field.
 * Accepts: string, { text }, { parts: [{ text } | string] }, { request }.
 */
function extractRequestText(request: RawRequest): string {
  if (typeof request.message === "string") return request.message;
  if (typeof request.request === "string") return request.request;

  const message = request.message;
  if (message && typeof message === "object") {
    const m = message as Record<string, unknown>;
    if (typeof m.text === "string") return m.text;
    if (Array.isArray(m.parts)) {
      const parts: string[] = [];
      for (const part of m.parts) {
        if (typeof part === "string") {
          parts.push(part);
        } else if (part && typeof part === "object") {
          const p = part as Record<string, unknown>;
          if (typeof p.text === "string") parts.push(p.text);
        }
      }
      if (parts.length > 0) return parts.join("");
    }
  }
  return "";
}

/**
 * Extract assistant text from a request's response field.
 * Accepts: string, [string], [{ value }], [{ kind, content: { value } }].
 */
function extractResponseText(request: RawRequest): string {
  const response = request.response;
  if (typeof response === "string") return response;
  if (!Array.isArray(response)) return "";

  const parts: string[] = [];
  for (const item of response) {
    if (typeof item === "string") {
      parts.push(item);
      continue;
    }
    if (!item || typeof item !== "object") continue;
    const obj = item as Record<string, unknown>;
    if (typeof obj.value === "string") {
      parts.push(obj.value);
      continue;
    }
    const content = obj.content;
    if (content && typeof content === "object") {
      const c = content as Record<string, unknown>;
      if (typeof c.value === "string") parts.push(c.value);
    }
  }
  return parts.join("");
}

/**
 * A record looks like a chat session if it has at least one of the
 * recognised id/timestamp fields AND a `requests` array. Anything that
 * obviously isn't a chat session (interactiveSessions index files, edit
 * metadata, ...) is filtered out.
 */
function looksLikeChatSession(raw: RawSession): boolean {
  if (!Array.isArray(raw.requests)) return false;
  const hasId = typeof (raw.sessionId ?? raw.id ?? raw.guid) === "string";
  const hasDate =
    raw.creationDate !== undefined ||
    raw.lastMessageDate !== undefined ||
    raw.startTimestamp !== undefined;
  return hasId || hasDate;
}

// ── Summary / full session builders ─────────────────────────────────

function summarizeSession(filePath: string, projectFilter?: string): SessionSummary | null {
  const raw = readSessionJson(filePath);
  if (!raw) return null;
  if (!looksLikeChatSession(raw)) return null;

  const project = pickProject(raw);
  if (projectFilter !== undefined) {
    if (!project || project !== projectFilter) return null;
  }

  const id = pickId(raw, filePath);
  const startedAt = pickStart(raw) ?? new Date(0);
  const requests = raw.requests ?? [];

  let messageCount = 0;
  let totalText = "";
  let lastTimestamp: Date | undefined;

  for (const req of requests) {
    const userText = extractRequestText(req);
    const assistantText = extractResponseText(req);
    if (userText) {
      messageCount++;
      totalText += userText;
    }
    if (assistantText) {
      messageCount++;
      totalText += assistantText;
    }
    const ts = coerceDate(req.timestamp);
    if (ts) lastTimestamp = ts;
  }

  if (messageCount === 0) return null;

  return {
    id,
    adapter: ADAPTER_NAME,
    project,
    messageCount,
    startedAt,
    endedAt: lastTimestamp ?? coerceDate(raw.lastMessageDate),
    estimatedTokens: estimateTokens(totalText),
  };
}

function parseSessionFull(filePath: string, storageDir: string): Session | null {
  const raw = readSessionJson(filePath);
  if (!raw) return null;
  if (!looksLikeChatSession(raw)) return null;

  const id = pickId(raw, filePath);
  const startedAt = pickStart(raw) ?? new Date(0);
  const project = pickProject(raw);
  const messages: Message[] = [];
  let endedAt: Date | undefined;

  for (const req of raw.requests ?? []) {
    const ts = coerceDate(req.timestamp);

    const userText = extractRequestText(req);
    if (userText) {
      messages.push({
        role: "user",
        content: userText,
        ...(ts && { timestamp: ts }),
      });
    }

    const assistantText = extractResponseText(req);
    if (assistantText) {
      messages.push({
        role: "assistant",
        content: assistantText,
        ...(ts && { timestamp: ts }),
      });
    }

    if (ts) endedAt = ts;
  }

  if (messages.length === 0) return null;

  if (!endedAt) {
    endedAt = coerceDate(raw.lastMessageDate);
  }

  const metadata: Record<string, unknown> = {
    storageDir,
  };
  if (raw.customTitle !== undefined) metadata.customTitle = raw.customTitle;
  if (raw.requesterUsername !== undefined) {
    metadata.requesterUsername = raw.requesterUsername;
  }
  if (raw.version !== undefined) metadata.version = raw.version;

  return {
    id,
    adapter: ADAPTER_NAME,
    project,
    messages,
    startedAt,
    endedAt,
    metadata,
  };
}
