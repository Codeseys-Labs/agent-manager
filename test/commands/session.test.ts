import { describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import type { Session, SessionFilter, SessionSummary } from "../../src/core/session";
import { estimateTokens, filterMessages, formatJson, formatMarkdown } from "../../src/core/session";

// ── Mock Session Data ────────────────────────────────────────────

const mockSessions: Session[] = [
  {
    id: "session-001",
    adapter: "claude-code",
    project: "/home/user/project-a",
    messages: [
      { role: "user", content: "Fix the login bug", timestamp: new Date("2026-04-01T10:00:00Z") },
      {
        role: "assistant",
        content: "I'll look at the auth module",
        timestamp: new Date("2026-04-01T10:00:05Z"),
      },
      {
        role: "assistant",
        content: "Found the issue in session handling",
        timestamp: new Date("2026-04-01T10:01:00Z"),
        toolCalls: [{ name: "Read", input: { path: "auth.ts" }, output: "file contents" }],
      },
      { role: "tool", content: "file contents", timestamp: new Date("2026-04-01T10:01:01Z") },
      { role: "system", content: "Context loaded", timestamp: new Date("2026-04-01T09:59:00Z") },
    ],
    startedAt: new Date("2026-04-01T10:00:00Z"),
    endedAt: new Date("2026-04-01T10:05:00Z"),
  },
  {
    id: "session-002",
    adapter: "claude-code",
    project: "/home/user/project-b",
    messages: [
      {
        role: "user",
        content: "Add dark mode support",
        timestamp: new Date("2026-04-02T14:00:00Z"),
      },
      {
        role: "assistant",
        content: "I'll update the theme configuration",
        timestamp: new Date("2026-04-02T14:00:10Z"),
      },
    ],
    startedAt: new Date("2026-04-02T14:00:00Z"),
  },
];

const mockSummaries: SessionSummary[] = mockSessions.map((s) => ({
  id: s.id,
  adapter: s.adapter,
  project: s.project,
  messageCount: s.messages.length,
  startedAt: s.startedAt,
  endedAt: s.endedAt,
  estimatedTokens: s.messages.reduce((sum, m) => sum + estimateTokens(m.content), 0),
}));

// ── Tests ────────────────────────────────────────────────────────

describe("am session", () => {
  describe("session list logic", () => {
    test("summaries sorted by date descending", () => {
      const sorted = [...mockSummaries].sort(
        (a, b) => b.startedAt.getTime() - a.startedAt.getTime(),
      );
      expect(sorted[0].id).toBe("session-002");
      expect(sorted[1].id).toBe("session-001");
    });

    test("summaries sorted by tokens descending", () => {
      const sorted = [...mockSummaries].sort(
        (a, b) => (b.estimatedTokens ?? 0) - (a.estimatedTokens ?? 0),
      );
      // session-001 has more messages/content
      expect(sorted[0].id).toBe("session-001");
    });

    test("summary contains expected fields", () => {
      const s = mockSummaries[0];
      expect(s.id).toBe("session-001");
      expect(s.adapter).toBe("claude-code");
      expect(s.project).toBe("/home/user/project-a");
      expect(s.messageCount).toBe(5);
      expect(s.startedAt).toBeInstanceOf(Date);
      expect(s.estimatedTokens).toBeGreaterThan(0);
    });

    test("JSON serialization of summaries", () => {
      const serialized = mockSummaries.map((s) => ({
        ...s,
        startedAt: s.startedAt.toISOString(),
        endedAt: s.endedAt?.toISOString() ?? null,
      }));
      expect(serialized[0].startedAt).toBe("2026-04-01T10:00:00.000Z");
      expect(serialized[1].endedAt).toBeNull();
    });
  });

  describe("session export logic", () => {
    test("formatMarkdown renders session header", () => {
      const md = formatMarkdown(mockSessions[0]);
      expect(md).toContain("# Session session-001");
      expect(md).toContain("**Adapter:** claude-code");
      expect(md).toContain("**Project:** /home/user/project-a");
      expect(md).toContain("**Started:** 2026-04-01T10:00:00.000Z");
      expect(md).toContain("**Ended:** 2026-04-01T10:05:00.000Z");
    });

    test("formatMarkdown includes all messages", () => {
      const md = formatMarkdown(mockSessions[0]);
      expect(md).toContain("Fix the login bug");
      expect(md).toContain("I'll look at the auth module");
      expect(md).toContain("Found the issue in session handling");
      expect(md).toContain("Context loaded");
    });

    test("formatMarkdown renders tool calls", () => {
      const md = formatMarkdown(mockSessions[0]);
      expect(md).toContain("**Tool:** `Read`");
      expect(md).toContain("file contents");
    });

    test("formatJson produces valid JSON structure", () => {
      const json = formatJson(mockSessions[0]) as any;
      expect(json.id).toBe("session-001");
      expect(json.adapter).toBe("claude-code");
      expect(json.project).toBe("/home/user/project-a");
      expect(json.messageCount).toBe(5);
      expect(json.messages).toBeArray();
      expect(json.messages[0].role).toBe("user");
    });

    test("formatJson with --no-tools filter excludes tool messages", () => {
      const filter: SessionFilter = { noTools: true };
      const json = formatJson(mockSessions[0], filter) as any;
      const roles = json.messages.map((m: any) => m.role);
      expect(roles).not.toContain("tool");
      expect(json.messageCount).toBe(4);
    });

    test("formatJson with --no-system filter excludes system messages", () => {
      const filter: SessionFilter = { noSystem: true };
      const json = formatJson(mockSessions[0], filter) as any;
      const roles = json.messages.map((m: any) => m.role);
      expect(roles).not.toContain("system");
      expect(json.messageCount).toBe(4);
    });

    test("formatMarkdown with role filter", () => {
      const filter: SessionFilter = { roles: ["user"] };
      const md = formatMarkdown(mockSessions[0], filter);
      expect(md).toContain("Fix the login bug");
      expect(md).not.toContain("I'll look at the auth module");
    });

    test("raw format outputs message content", () => {
      // Simulates the raw format logic from the export command
      const messages = mockSessions[0].messages;
      const raw = messages.map((m) => m.content).join("\n");
      expect(raw).toContain("Fix the login bug");
      expect(raw).toContain("I'll look at the auth module");
      expect(raw).toContain("Context loaded");
    });
  });

  describe("session search logic", () => {
    test("filterMessages finds matching messages by query", () => {
      const filter: SessionFilter = { query: "login" };
      const matches = filterMessages(mockSessions[0].messages, filter);
      expect(matches.length).toBe(1);
      expect(matches[0].content).toContain("login");
    });

    test("filterMessages query is case-insensitive", () => {
      const filter: SessionFilter = { query: "LOGIN" };
      const matches = filterMessages(mockSessions[0].messages, filter);
      expect(matches.length).toBe(1);
    });

    test("filterMessages with query and role filter combined", () => {
      const filter: SessionFilter = { query: "auth", roles: ["assistant"] };
      const matches = filterMessages(mockSessions[0].messages, filter);
      expect(matches.length).toBe(1);
      expect(matches[0].role).toBe("assistant");
    });

    test("filterMessages returns empty for unmatched query", () => {
      const filter: SessionFilter = { query: "zzzzz_no_match_zzzzz" };
      const matches = filterMessages(mockSessions[0].messages, filter);
      expect(matches.length).toBe(0);
    });

    test("search snippet extraction logic", () => {
      const query = "dark mode";
      const content = "Add dark mode support";
      const idx = content.toLowerCase().indexOf(query.toLowerCase());
      const start = Math.max(0, idx - 40);
      const end = Math.min(content.length, idx + query.length + 40);
      const snippet =
        (start > 0 ? "..." : "") + content.slice(start, end) + (end < content.length ? "..." : "");
      expect(snippet).toBe("Add dark mode support");
    });

    test("search across multiple sessions finds correct matches", () => {
      const query = "dark mode";
      const filter: SessionFilter = { query };
      const results = mockSessions
        .filter((s) => filterMessages(s.messages, filter).length > 0)
        .map((s) => ({
          sessionId: `${s.adapter}:${s.id}`,
          matchCount: filterMessages(s.messages, filter).length,
        }));
      expect(results.length).toBe(1);
      expect(results[0].sessionId).toBe("claude-code:session-002");
      expect(results[0].matchCount).toBe(1);
    });
  });

  describe("session ID parsing", () => {
    test("parses adapter:session-id format", () => {
      const idStr = "claude-code:session-001";
      const colonIdx = idStr.indexOf(":");
      expect(colonIdx).toBeGreaterThan(0);
      expect(idStr.slice(0, colonIdx)).toBe("claude-code");
      expect(idStr.slice(colonIdx + 1)).toBe("session-001");
    });

    test("rejects ID without colon", () => {
      const idStr = "no-colon-here";
      const colonIdx = idStr.indexOf(":");
      // colonIdx === -1, and -1 < 1 so this is invalid
      expect(colonIdx < 1).toBe(true);
    });

    test("rejects ID starting with colon", () => {
      const idStr = ":session-only";
      const colonIdx = idStr.indexOf(":");
      // colonIdx === 0, and 0 < 1 so this is invalid
      expect(colonIdx < 1).toBe(true);
    });
  });

  describe("command structure", () => {
    test("sessionCommand has list, export, and search subcommands", async () => {
      const { sessionCommand } = await import("../../src/commands/session");
      const { resolveMeta, resolveSubCommands } = await import("../helpers/citty");
      expect((await resolveMeta(sessionCommand))?.name).toBe("session");
      const subs = await resolveSubCommands(sessionCommand);
      expect(subs).toBeDefined();
      expect(subs?.list).toBeDefined();
      expect(subs?.export).toBeDefined();
      expect(subs?.search).toBeDefined();
    });

    test("description disambiguates transcript harvest from live ACP sessions (ADR-0031 M2)", async () => {
      const { sessionCommand } = await import("../../src/commands/session");
      const { resolveMeta } = await import("../helpers/citty");
      const desc = (await resolveMeta(sessionCommand))?.description ?? "";
      // Transcript-centric phrasing + pointer to the live ACP surface.
      expect(desc.toLowerCase()).toContain("transcript");
      expect(desc).toContain("am run session");
    });

    test("session command is registered in CLI", async () => {
      // Verify cli.ts has the session command import.
      // `new URL(...).pathname` yields `/C:/...` on Windows (leading slash
      // before the drive letter), which Bun.file cannot open. fileURLToPath
      // converts the file URL to a valid native path on every platform.
      const cliContent = await Bun.file(
        fileURLToPath(new URL("../../src/cli.ts", import.meta.url)),
      ).text();
      expect(cliContent).toContain("sessionCommand");
      expect(cliContent).toContain("./commands/session");
    });
  });
});
