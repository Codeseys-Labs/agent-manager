/**
 * Claude Code session reader.
 *
 * Reads JSONL session files from ~/.claude/projects/<encoded-path>/*.jsonl
 * and converts them to the unified Session/Message types.
 *
 * Path encoding: project path with leading `/` stripped, then `/` → `-`
 * Example: /Users/foo/myapp → Users-foo-myapp
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import type {
  Message,
  Session,
  SessionReader,
  SessionSummary,
  ToolCall,
} from "../../core/session.ts";
import { estimateTokens } from "../../core/session.ts";

const ADAPTER_NAME = "claude-code";

// ── JSONL Record Types ─────────────────────────────────────────

interface ContentBlock {
  type: string;
  text?: string;
  name?: string;
  input?: unknown;
  id?: string;
  content?: unknown;
  tool_use_id?: string;
}

interface JRecord {
  type: string;
  timestamp?: string;
  sessionId?: string;
  cwd?: string;
  message?: {
    role?: string;
    content?: string | ContentBlock[];
  };
  [key: string]: unknown;
}

// ── Helpers ────────────────────────────────────────────────────

/** Encode a project path the way Claude Code does: strip leading /, replace / with - */
export function encodeProjectPath(projectPath: string): string {
  return projectPath.replace(/^\//, "").replace(/\//g, "-");
}

/** Decode an encoded project dir name back to a path. */
export function decodeProjectPath(encoded: string): string {
  // The encoding is lossy (- could be a real hyphen or a /), so we prefix with /
  // and return the best guess. This is used for display, not for fs operations.
  return `/${encoded.replace(/-/g, "/")}`;
}

function projectsDir(homeDir?: string): string {
  return join(homeDir ?? homedir(), ".claude", "projects");
}

// ── Session Reader ─────────────────────────────────────────────

export function createClaudeCodeSessionReader(homeDir?: string): SessionReader {
  const home = homeDir ?? homedir();

  return {
    hasSessionStorage(): boolean {
      return existsSync(projectsDir(home));
    },

    async listSessions(project?: string): Promise<SessionSummary[]> {
      const baseDir = projectsDir(home);
      if (!existsSync(baseDir)) return [];

      const summaries: SessionSummary[] = [];
      let projectDirs: string[];

      if (project) {
        // Filter to a specific project
        const encoded = encodeProjectPath(project);
        const dir = join(baseDir, encoded);
        projectDirs = existsSync(dir) ? [encoded] : [];
      } else {
        // All projects
        try {
          projectDirs = readdirSync(baseDir).filter((name) => {
            const stat = statSync(join(baseDir, name));
            return stat.isDirectory();
          });
        } catch {
          return [];
        }
      }

      for (const projDir of projectDirs) {
        const fullDir = join(baseDir, projDir);
        let files: string[];
        try {
          files = readdirSync(fullDir).filter((f) => f.endsWith(".jsonl"));
        } catch {
          continue;
        }

        for (const file of files) {
          const filePath = join(fullDir, file);
          const summary = summarizeSession(filePath, projDir);
          if (summary) summaries.push(summary);
        }
      }

      // Sort by startedAt descending (most recent first)
      summaries.sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime());

      return summaries;
    },

    async loadSession(id: string): Promise<Session | null> {
      const baseDir = projectsDir(home);
      if (!existsSync(baseDir)) return null;

      // Sanitize session ID to prevent path traversal
      const safeId = id.replace(/\.jsonl$/, "");
      if (/[/\\]|\.\./.test(safeId)) {
        return null;
      }

      // id is the JSONL filename (UUID), search across all project dirs
      const fileName = `${safeId}.jsonl`;

      let projectDirs: string[];
      try {
        projectDirs = readdirSync(baseDir).filter((name) => {
          try {
            return statSync(join(baseDir, name)).isDirectory();
          } catch {
            return false;
          }
        });
      } catch {
        return null;
      }

      for (const projDir of projectDirs) {
        const filePath = join(baseDir, projDir, fileName);
        if (existsSync(filePath)) {
          return parseSessionFile(filePath, projDir);
        }
      }

      return null;
    },
  };
}

// ── JSONL Parsing ──────────────────────────────────────────────

/** Parse a single JSONL line, returning null on failure. */
function parseLine(line: string): JRecord | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

/** Read all valid records from a JSONL file. */
function readRecords(filePath: string): JRecord[] {
  let text: string;
  try {
    text = readFileSync(filePath, "utf-8");
  } catch {
    return [];
  }

  const records: JRecord[] = [];
  for (const line of text.split("\n")) {
    const record = parseLine(line);
    if (record) records.push(record);
  }
  return records;
}

/** Build a lightweight summary from a JSONL file without fully parsing messages. */
function summarizeSession(filePath: string, projectDirName: string): SessionSummary | null {
  const records = readRecords(filePath);
  if (records.length === 0) return null;

  const sessionId = basename(filePath, ".jsonl");

  let messageCount = 0;
  let firstTimestamp: string | undefined;
  let lastTimestamp: string | undefined;
  let totalChars = 0;
  let projectPath: string | undefined;

  for (const record of records) {
    if (record.type === "user" || record.type === "assistant") {
      messageCount++;

      if (record.timestamp) {
        if (!firstTimestamp) firstTimestamp = record.timestamp;
        lastTimestamp = record.timestamp;
      }

      // Estimate content size
      if (record.message?.content) {
        if (typeof record.message.content === "string") {
          totalChars += record.message.content.length;
        } else if (Array.isArray(record.message.content)) {
          for (const block of record.message.content) {
            if (block.text) totalChars += block.text.length;
          }
        }
      }
    }

    // Extract project path from cwd field
    if (record.cwd && !projectPath) {
      projectPath = record.cwd;
    }
  }

  if (messageCount === 0) return null;

  return {
    id: sessionId,
    adapter: ADAPTER_NAME,
    project: projectPath ?? decodeProjectPath(projectDirName),
    messageCount,
    startedAt: firstTimestamp ? new Date(firstTimestamp) : new Date(0),
    endedAt: lastTimestamp ? new Date(lastTimestamp) : undefined,
    estimatedTokens: estimateTokens("x".repeat(totalChars)),
  };
}

/** Parse a JSONL session file into a full Session object. */
function parseSessionFile(filePath: string, projectDirName: string): Session | null {
  const records = readRecords(filePath);
  if (records.length === 0) return null;

  const sessionId = basename(filePath, ".jsonl");
  const messages: Message[] = [];
  let firstTimestamp: Date | undefined;
  let lastTimestamp: Date | undefined;
  let projectPath: string | undefined;
  const metadata: Record<string, unknown> = {};

  for (const record of records) {
    const ts = record.timestamp ? new Date(record.timestamp) : undefined;

    if (ts) {
      if (!firstTimestamp) firstTimestamp = ts;
      lastTimestamp = ts;
    }

    if (record.cwd && !projectPath) {
      projectPath = record.cwd;
    }

    if (record.type === "user") {
      const content = typeof record.message?.content === "string" ? record.message.content : "";
      messages.push({ role: "user", content, timestamp: ts });
    } else if (record.type === "assistant") {
      const msg = parseAssistantRecord(record, ts);
      if (msg) messages.push(msg);
    } else if (record.type === "system") {
      // Include system records as system messages
      const subtype = (record.subtype as string) ?? "system";
      messages.push({
        role: "system",
        content: `[${subtype}]`,
        timestamp: ts,
      });
    }

    // Collect metadata from specific record types
    if (record.type === "permission-mode") {
      metadata.permissionMode = record.permissionMode;
    }
    if (record.type === "agent-name") {
      metadata.agentName = record.agentName ?? record.name;
    }
    if (record.type === "custom-title") {
      metadata.title = record.title;
    }
    if (record.version && !metadata.version) {
      metadata.version = record.version;
    }
    if (record.sessionId && !metadata.sessionId) {
      metadata.sessionId = record.sessionId;
    }
  }

  if (messages.length === 0) return null;

  return {
    id: sessionId,
    adapter: ADAPTER_NAME,
    project: projectPath ?? decodeProjectPath(projectDirName),
    messages,
    startedAt: firstTimestamp ?? new Date(0),
    endedAt: lastTimestamp,
    metadata,
  };
}

/** Parse an assistant record's content blocks into a Message. */
function parseAssistantRecord(record: JRecord, timestamp?: Date): Message | null {
  const content = record.message?.content;
  if (!Array.isArray(content)) return null;

  const textParts: string[] = [];
  const toolCalls: ToolCall[] = [];

  for (const block of content) {
    if (block.type === "text" && block.text) {
      textParts.push(block.text);
    } else if (block.type === "tool_use") {
      toolCalls.push({
        name: block.name ?? "unknown",
        input: block.input,
      });
    } else if (block.type === "tool_result") {
      // Attach tool results to the most recent tool call if possible
      const resultContent =
        typeof block.content === "string" ? block.content : JSON.stringify(block.content);
      if (toolCalls.length > 0) {
        const lastTool = toolCalls[toolCalls.length - 1];
        if (!lastTool.output) {
          lastTool.output = resultContent;
        }
      }
    }
    // Skip "thinking" blocks — internal chain-of-thought, not user-visible
  }

  // Skip records with no meaningful content
  if (textParts.length === 0 && toolCalls.length === 0) return null;

  return {
    role: "assistant",
    content: textParts.join("\n\n"),
    timestamp,
    ...(toolCalls.length > 0 && { toolCalls }),
  };
}
