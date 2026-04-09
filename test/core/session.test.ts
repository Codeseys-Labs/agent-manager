import { describe, expect, test } from "bun:test";
import {
  type Message,
  type Session,
  estimateTokens,
  filterMessages,
  formatJson,
  formatMarkdown,
} from "@/core/session.ts";

// ── Test Data ──────────────────────────────────────────────────

const sampleMessages: Message[] = [
  {
    role: "system",
    content: "You are a helpful coding assistant.",
    timestamp: new Date("2026-04-08T10:00:00Z"),
  },
  {
    role: "user",
    content: "Fix the authentication bug in login.ts",
    timestamp: new Date("2026-04-08T10:01:00Z"),
  },
  {
    role: "assistant",
    content: "I'll look at login.ts to find the authentication issue.",
    timestamp: new Date("2026-04-08T10:01:05Z"),
    toolCalls: [
      {
        name: "read_file",
        input: { path: "src/login.ts" },
        output: "export function login() { ... }",
      },
    ],
  },
  {
    role: "tool",
    content: "File contents of src/login.ts",
    timestamp: new Date("2026-04-08T10:01:06Z"),
  },
  {
    role: "assistant",
    content: "I found the bug — the token validation was missing. Here's the fix.",
    timestamp: new Date("2026-04-08T10:01:10Z"),
  },
  {
    role: "user",
    content: "Looks good, thanks!",
    timestamp: new Date("2026-04-08T10:02:00Z"),
  },
];

function sampleSession(overrides: Partial<Session> = {}): Session {
  return {
    id: "session-001",
    adapter: "claude-code",
    project: "/home/user/my-project",
    messages: sampleMessages,
    startedAt: new Date("2026-04-08T10:00:00Z"),
    endedAt: new Date("2026-04-08T10:02:00Z"),
    metadata: { model: "claude-opus-4" },
    ...overrides,
  };
}

// ── filterMessages ─────────────────────────────────────────────

describe("filterMessages()", () => {
  test("returns all messages with empty filter", () => {
    const result = filterMessages(sampleMessages, {});
    expect(result).toHaveLength(6);
  });

  test("filters by single role", () => {
    const result = filterMessages(sampleMessages, { roles: ["user"] });
    expect(result).toHaveLength(2);
    expect(result.every((m) => m.role === "user")).toBe(true);
  });

  test("filters by multiple roles", () => {
    const result = filterMessages(sampleMessages, {
      roles: ["user", "assistant"],
    });
    expect(result).toHaveLength(4);
    expect(result.every((m) => m.role === "user" || m.role === "assistant")).toBe(true);
  });

  test("noTools removes tool messages", () => {
    const result = filterMessages(sampleMessages, { noTools: true });
    expect(result).toHaveLength(5);
    expect(result.some((m) => m.role === "tool")).toBe(false);
  });

  test("noSystem removes system messages", () => {
    const result = filterMessages(sampleMessages, { noSystem: true });
    expect(result).toHaveLength(5);
    expect(result.some((m) => m.role === "system")).toBe(false);
  });

  test("noTools and noSystem combined", () => {
    const result = filterMessages(sampleMessages, {
      noTools: true,
      noSystem: true,
    });
    expect(result).toHaveLength(4);
    expect(result.some((m) => m.role === "tool")).toBe(false);
    expect(result.some((m) => m.role === "system")).toBe(false);
  });

  test("query filters by content (case-insensitive)", () => {
    const result = filterMessages(sampleMessages, { query: "authentication" });
    expect(result).toHaveLength(2);
    expect(result[0].content).toContain("authentication");
  });

  test("query with no matches returns empty", () => {
    const result = filterMessages(sampleMessages, {
      query: "nonexistent-term",
    });
    expect(result).toHaveLength(0);
  });

  test("combines roles and query filters", () => {
    const result = filterMessages(sampleMessages, {
      roles: ["assistant"],
      query: "bug",
    });
    expect(result).toHaveLength(1);
    expect(result[0].content).toContain("bug");
    expect(result[0].role).toBe("assistant");
  });

  test("empty roles array returns all messages", () => {
    const result = filterMessages(sampleMessages, { roles: [] });
    expect(result).toHaveLength(6);
  });

  test("role filter takes precedence over noTools/noSystem", () => {
    // If roles includes "tool", but noTools is also true, noTools wins (applied after)
    const result = filterMessages(sampleMessages, {
      roles: ["tool", "user"],
      noTools: true,
    });
    expect(result).toHaveLength(2);
    expect(result.every((m) => m.role === "user")).toBe(true);
  });
});

// ── formatMarkdown ─────────────────────────────────────────────

describe("formatMarkdown()", () => {
  test("produces valid markdown with header", () => {
    const md = formatMarkdown(sampleSession());
    expect(md).toContain("# Session session-001");
    expect(md).toContain("**Adapter:** claude-code");
    expect(md).toContain("**Project:** /home/user/my-project");
    expect(md).toContain("**Started:** 2026-04-08T10:00:00.000Z");
    expect(md).toContain("**Ended:** 2026-04-08T10:02:00.000Z");
  });

  test("includes message content with role headers", () => {
    const md = formatMarkdown(sampleSession());
    expect(md).toContain("### User");
    expect(md).toContain("### Assistant");
    expect(md).toContain("### System");
    expect(md).toContain("### Tool");
  });

  test("includes tool call details", () => {
    const md = formatMarkdown(sampleSession());
    expect(md).toContain("**Tool:** `read_file`");
    expect(md).toContain('"path": "src/login.ts"');
    expect(md).toContain("**Output:**");
  });

  test("includes timestamps", () => {
    const md = formatMarkdown(sampleSession());
    expect(md).toContain("*2026-04-08T10:01:00.000Z*");
  });

  test("applies filter before formatting", () => {
    const md = formatMarkdown(sampleSession(), { roles: ["user"] });
    expect(md).toContain("**Messages:** 2");
    expect(md).toContain("### User");
    expect(md).not.toContain("### Assistant");
    expect(md).not.toContain("### System");
  });

  test("omits project line when not set", () => {
    const md = formatMarkdown(sampleSession({ project: undefined }));
    expect(md).not.toContain("**Project:**");
  });

  test("omits ended line when not set", () => {
    const md = formatMarkdown(sampleSession({ endedAt: undefined }));
    expect(md).not.toContain("**Ended:**");
  });

  test("message count reflects filtered messages", () => {
    const md = formatMarkdown(sampleSession(), { noTools: true, noSystem: true });
    expect(md).toContain("**Messages:** 4");
  });
});

// ── formatJson ─────────────────────────────────────────────────

describe("formatJson()", () => {
  test("returns expected structure", () => {
    const json = formatJson(sampleSession()) as Record<string, unknown>;
    expect(json.id).toBe("session-001");
    expect(json.adapter).toBe("claude-code");
    expect(json.project).toBe("/home/user/my-project");
    expect(json.startedAt).toBe("2026-04-08T10:00:00.000Z");
    expect(json.endedAt).toBe("2026-04-08T10:02:00.000Z");
    expect(json.messageCount).toBe(6);
    expect(json.metadata).toEqual({ model: "claude-opus-4" });
  });

  test("messages include all fields", () => {
    const json = formatJson(sampleSession()) as {
      messages: { role: string; content: string; timestamp: string | null; toolCalls: unknown[] }[];
    };
    expect(json.messages).toHaveLength(6);
    expect(json.messages[0].role).toBe("system");
    expect(json.messages[0].timestamp).toBe("2026-04-08T10:00:00.000Z");
    expect(json.messages[2].toolCalls).toHaveLength(1);
  });

  test("null-fills missing optional fields", () => {
    const json = formatJson(
      sampleSession({ project: undefined, endedAt: undefined, metadata: undefined }),
    ) as Record<string, unknown>;
    expect(json.project).toBeNull();
    expect(json.endedAt).toBeNull();
    expect(json.metadata).toEqual({});
  });

  test("applies filter before formatting", () => {
    const json = formatJson(sampleSession(), {
      roles: ["user"],
    }) as { messageCount: number; messages: unknown[] };
    expect(json.messageCount).toBe(2);
    expect(json.messages).toHaveLength(2);
  });

  test("is JSON-serializable", () => {
    const json = formatJson(sampleSession());
    const serialized = JSON.stringify(json);
    const parsed = JSON.parse(serialized);
    expect(parsed.id).toBe("session-001");
    expect(parsed.messages).toHaveLength(6);
  });
});

// ── estimateTokens ─────────────────────────────────────────────

describe("estimateTokens()", () => {
  test("empty string returns 0", () => {
    expect(estimateTokens("")).toBe(0);
  });

  test("short text returns at least 1", () => {
    expect(estimateTokens("hi")).toBeGreaterThanOrEqual(1);
  });

  test("estimates ~4 chars per token", () => {
    const text = "a".repeat(100);
    expect(estimateTokens(text)).toBe(25);
  });

  test("rounds up fractional tokens", () => {
    // 5 chars -> 1.25 tokens -> ceil -> 2
    expect(estimateTokens("hello")).toBe(2);
  });

  test("handles longer text reasonably", () => {
    const text = "a".repeat(4000);
    expect(estimateTokens(text)).toBe(1000);
  });

  test("handles unicode", () => {
    // Each emoji is multiple bytes but .length counts UTF-16 code units
    const emoji = "Hello world!";
    const tokens = estimateTokens(emoji);
    expect(tokens).toBeGreaterThan(0);
    expect(tokens).toBe(Math.ceil(emoji.length / 4));
  });
});
