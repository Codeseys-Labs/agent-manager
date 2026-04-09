import { afterEach, describe, expect, test } from "bun:test";
import {
  createClaudeCodeSessionReader,
  decodeProjectPath,
  encodeProjectPath,
} from "@/adapters/claude-code/session.ts";
import { type TestDir, createTestDir } from "../../helpers/tmp.ts";

// ── Helper: build JSONL content ────────────────────────────────

function jsonl(...records: Record<string, unknown>[]): string {
  return `${records.map((r) => JSON.stringify(r)).join("\n")}\n`;
}

function userRecord(
  content: string,
  opts: { timestamp?: string; cwd?: string; sessionId?: string } = {},
): Record<string, unknown> {
  return {
    type: "user",
    message: { role: "user", content },
    timestamp: opts.timestamp ?? "2026-04-08T10:00:00.000Z",
    cwd: opts.cwd ?? "/Users/test/my-project",
    sessionId: opts.sessionId ?? "test-session-001",
    uuid: `u-${Math.random().toString(36).slice(2)}`,
  };
}

function assistantTextRecord(
  text: string,
  opts: { timestamp?: string } = {},
): Record<string, unknown> {
  return {
    type: "assistant",
    message: {
      role: "assistant",
      content: [{ type: "text", text }],
    },
    timestamp: opts.timestamp ?? "2026-04-08T10:00:05.000Z",
    uuid: `a-${Math.random().toString(36).slice(2)}`,
  };
}

function assistantToolUseRecord(
  name: string,
  input: unknown,
  opts: { timestamp?: string } = {},
): Record<string, unknown> {
  return {
    type: "assistant",
    message: {
      role: "assistant",
      content: [
        { type: "tool_use", name, input, id: `tool-${Math.random().toString(36).slice(2)}` },
      ],
    },
    timestamp: opts.timestamp ?? "2026-04-08T10:00:10.000Z",
    uuid: `at-${Math.random().toString(36).slice(2)}`,
  };
}

function assistantThinkingRecord(opts: { timestamp?: string } = {}): Record<string, unknown> {
  return {
    type: "assistant",
    message: {
      role: "assistant",
      content: [{ type: "thinking", thinking: "Let me think about this..." }],
    },
    timestamp: opts.timestamp ?? "2026-04-08T10:00:03.000Z",
    uuid: `at-${Math.random().toString(36).slice(2)}`,
  };
}

function systemRecord(subtype: string, opts: { timestamp?: string } = {}): Record<string, unknown> {
  return {
    type: "system",
    subtype,
    timestamp: opts.timestamp ?? "2026-04-08T10:00:01.000Z",
    uuid: `s-${Math.random().toString(36).slice(2)}`,
  };
}

function permissionModeRecord(): Record<string, unknown> {
  return {
    type: "permission-mode",
    permissionMode: "plan",
    sessionId: "test-session-001",
  };
}

// ── Path Encoding ──────────────────────────────────────────────

describe("encodeProjectPath()", () => {
  test("encodes absolute path", () => {
    expect(encodeProjectPath("/Users/foo/myapp")).toBe("Users-foo-myapp");
  });

  test("handles nested paths", () => {
    expect(encodeProjectPath("/Users/foo/bar/baz")).toBe("Users-foo-bar-baz");
  });

  test("handles root-level path", () => {
    expect(encodeProjectPath("/tmp")).toBe("tmp");
  });
});

describe("decodeProjectPath()", () => {
  test("decodes to absolute path", () => {
    expect(decodeProjectPath("Users-foo-myapp")).toBe("/Users/foo/myapp");
  });
});

// ── hasSessionStorage ──────────────────────────────────────────

describe("hasSessionStorage()", () => {
  let dir: TestDir;

  afterEach(async () => {
    if (dir) await dir.cleanup();
  });

  test("returns true when ~/.claude/projects/ exists", async () => {
    dir = await createTestDir("am-cc-session-");
    await dir.write(".claude/projects/.keep", "");
    const reader = createClaudeCodeSessionReader(dir.path);
    expect(reader.hasSessionStorage()).toBe(true);
  });

  test("returns false when directory does not exist", async () => {
    dir = await createTestDir("am-cc-session-");
    const reader = createClaudeCodeSessionReader(dir.path);
    expect(reader.hasSessionStorage()).toBe(false);
  });
});

// ── listSessions ───────────────────────────────────────────────

describe("listSessions()", () => {
  let dir: TestDir;

  afterEach(async () => {
    if (dir) await dir.cleanup();
  });

  test("lists sessions from JSONL files", async () => {
    dir = await createTestDir("am-cc-session-");
    const content = jsonl(
      permissionModeRecord(),
      userRecord("Hello", { timestamp: "2026-04-08T10:00:00.000Z" }),
      assistantTextRecord("Hi there!", { timestamp: "2026-04-08T10:00:05.000Z" }),
      userRecord("Fix the bug", { timestamp: "2026-04-08T10:01:00.000Z" }),
      assistantTextRecord("Done!", { timestamp: "2026-04-08T10:01:05.000Z" }),
    );
    await dir.write(".claude/projects/Users-test-my-project/session-001.jsonl", content);

    const reader = createClaudeCodeSessionReader(dir.path);
    const sessions = await reader.listSessions();
    expect(sessions).toHaveLength(1);
    expect(sessions[0].id).toBe("session-001");
    expect(sessions[0].adapter).toBe("claude-code");
    expect(sessions[0].messageCount).toBe(4);
    expect(sessions[0].startedAt).toEqual(new Date("2026-04-08T10:00:00.000Z"));
    expect(sessions[0].endedAt).toEqual(new Date("2026-04-08T10:01:05.000Z"));
    expect(sessions[0].estimatedTokens).toBeGreaterThan(0);
  });

  test("lists sessions filtered by project", async () => {
    dir = await createTestDir("am-cc-session-");

    // Two projects
    await dir.write(
      ".claude/projects/Users-test-project-a/s1.jsonl",
      jsonl(userRecord("Hello", { cwd: "/Users/test/project-a" }), assistantTextRecord("Hi")),
    );
    await dir.write(
      ".claude/projects/Users-test-project-b/s2.jsonl",
      jsonl(userRecord("Hello", { cwd: "/Users/test/project-b" }), assistantTextRecord("Hi")),
    );

    const reader = createClaudeCodeSessionReader(dir.path);

    const allSessions = await reader.listSessions();
    expect(allSessions).toHaveLength(2);

    const filtered = await reader.listSessions("/Users/test/project-a");
    expect(filtered).toHaveLength(1);
    expect(filtered[0].project).toBe("/Users/test/project-a");
  });

  test("returns empty for nonexistent storage", async () => {
    dir = await createTestDir("am-cc-session-");
    const reader = createClaudeCodeSessionReader(dir.path);
    const sessions = await reader.listSessions();
    expect(sessions).toHaveLength(0);
  });

  test("skips empty JSONL files", async () => {
    dir = await createTestDir("am-cc-session-");
    await dir.write(".claude/projects/Users-test-empty/empty.jsonl", "");

    const reader = createClaudeCodeSessionReader(dir.path);
    const sessions = await reader.listSessions();
    expect(sessions).toHaveLength(0);
  });

  test("skips JSONL files with only metadata records", async () => {
    dir = await createTestDir("am-cc-session-");
    await dir.write(".claude/projects/Users-test-meta/meta.jsonl", jsonl(permissionModeRecord()));

    const reader = createClaudeCodeSessionReader(dir.path);
    const sessions = await reader.listSessions();
    expect(sessions).toHaveLength(0);
  });

  test("sorts sessions by startedAt descending", async () => {
    dir = await createTestDir("am-cc-session-");

    await dir.write(
      ".claude/projects/Users-test-proj/older.jsonl",
      jsonl(
        userRecord("Old", { timestamp: "2026-04-01T10:00:00.000Z" }),
        assistantTextRecord("Reply", { timestamp: "2026-04-01T10:00:05.000Z" }),
      ),
    );
    await dir.write(
      ".claude/projects/Users-test-proj/newer.jsonl",
      jsonl(
        userRecord("New", { timestamp: "2026-04-08T10:00:00.000Z" }),
        assistantTextRecord("Reply", { timestamp: "2026-04-08T10:00:05.000Z" }),
      ),
    );

    const reader = createClaudeCodeSessionReader(dir.path);
    const sessions = await reader.listSessions();
    expect(sessions).toHaveLength(2);
    expect(sessions[0].id).toBe("newer");
    expect(sessions[1].id).toBe("older");
  });
});

// ── loadSession ────────────────────────────────────────────────

describe("loadSession()", () => {
  let dir: TestDir;

  afterEach(async () => {
    if (dir) await dir.cleanup();
  });

  test("loads and parses user messages", async () => {
    dir = await createTestDir("am-cc-session-");
    await dir.write(
      ".claude/projects/Users-test-proj/abc-123.jsonl",
      jsonl(
        userRecord("Hello world", { timestamp: "2026-04-08T10:00:00.000Z" }),
        assistantTextRecord("Hi!", { timestamp: "2026-04-08T10:00:05.000Z" }),
      ),
    );

    const reader = createClaudeCodeSessionReader(dir.path);
    const session = await reader.loadSession("abc-123");
    expect(session).not.toBeNull();
    expect(session?.id).toBe("abc-123");
    expect(session?.adapter).toBe("claude-code");
    expect(session?.messages).toHaveLength(2);
    expect(session?.messages[0].role).toBe("user");
    expect(session?.messages[0].content).toBe("Hello world");
    expect(session?.messages[1].role).toBe("assistant");
    expect(session?.messages[1].content).toBe("Hi!");
  });

  test("parses assistant tool_use blocks", async () => {
    dir = await createTestDir("am-cc-session-");
    await dir.write(
      ".claude/projects/Users-test-proj/tools-session.jsonl",
      jsonl(userRecord("Read the file"), assistantToolUseRecord("Read", { path: "src/main.ts" })),
    );

    const reader = createClaudeCodeSessionReader(dir.path);
    const session = await reader.loadSession("tools-session");
    expect(session).not.toBeNull();
    expect(session?.messages).toHaveLength(2);

    const assistantMsg = session?.messages[1];
    expect(assistantMsg.role).toBe("assistant");
    expect(assistantMsg.toolCalls).toHaveLength(1);
    expect(assistantMsg.toolCalls?.[0].name).toBe("Read");
    expect(assistantMsg.toolCalls?.[0].input).toEqual({ path: "src/main.ts" });
  });

  test("skips thinking-only assistant records", async () => {
    dir = await createTestDir("am-cc-session-");
    await dir.write(
      ".claude/projects/Users-test-proj/thinking.jsonl",
      jsonl(
        userRecord("Think about this"),
        assistantThinkingRecord(),
        assistantTextRecord("Here's my answer"),
      ),
    );

    const reader = createClaudeCodeSessionReader(dir.path);
    const session = await reader.loadSession("thinking");
    expect(session).not.toBeNull();
    // Thinking-only record is skipped, so we get user + text assistant
    expect(session?.messages).toHaveLength(2);
    expect(session?.messages[0].role).toBe("user");
    expect(session?.messages[1].role).toBe("assistant");
    expect(session?.messages[1].content).toBe("Here's my answer");
  });

  test("includes system records", async () => {
    dir = await createTestDir("am-cc-session-");
    await dir.write(
      ".claude/projects/Users-test-proj/with-system.jsonl",
      jsonl(systemRecord("stop_hook_summary"), userRecord("Hello"), assistantTextRecord("Hi")),
    );

    const reader = createClaudeCodeSessionReader(dir.path);
    const session = await reader.loadSession("with-system");
    expect(session).not.toBeNull();
    expect(session?.messages).toHaveLength(3);
    expect(session?.messages[0].role).toBe("system");
    expect(session?.messages[0].content).toBe("[stop_hook_summary]");
  });

  test("extracts metadata from special records", async () => {
    dir = await createTestDir("am-cc-session-");
    await dir.write(
      ".claude/projects/Users-test-proj/meta-session.jsonl",
      jsonl(
        permissionModeRecord(),
        { type: "agent-name", agentName: "my-agent", timestamp: "2026-04-08T10:00:00.000Z" },
        { type: "custom-title", title: "Fix auth bug", timestamp: "2026-04-08T10:00:00.000Z" },
        userRecord("Hello", { sessionId: "meta-session" }),
        assistantTextRecord("Hi", {}),
      ),
    );

    const reader = createClaudeCodeSessionReader(dir.path);
    const session = await reader.loadSession("meta-session");
    expect(session).not.toBeNull();
    expect(session?.metadata?.permissionMode).toBe("plan");
    expect(session?.metadata?.agentName).toBe("my-agent");
    expect(session?.metadata?.title).toBe("Fix auth bug");
  });

  test("extracts project from cwd field", async () => {
    dir = await createTestDir("am-cc-session-");
    await dir.write(
      ".claude/projects/Users-test-proj/cwd-session.jsonl",
      jsonl(userRecord("Hello", { cwd: "/Users/test/actual-project" }), assistantTextRecord("Hi")),
    );

    const reader = createClaudeCodeSessionReader(dir.path);
    const session = await reader.loadSession("cwd-session");
    expect(session).not.toBeNull();
    expect(session?.project).toBe("/Users/test/actual-project");
  });

  test("returns null for nonexistent session", async () => {
    dir = await createTestDir("am-cc-session-");
    await dir.write(".claude/projects/Users-test-proj/.keep", "");

    const reader = createClaudeCodeSessionReader(dir.path);
    const session = await reader.loadSession("nonexistent");
    expect(session).toBeNull();
  });

  test("rejects path traversal with ../", async () => {
    dir = await createTestDir("am-cc-session-");
    await dir.write(".claude/projects/Users-test-proj/.keep", "");

    const reader = createClaudeCodeSessionReader(dir.path);
    expect(await reader.loadSession("../../etc/passwd")).toBeNull();
    expect(await reader.loadSession("../sibling/file.jsonl")).toBeNull();
    expect(await reader.loadSession("..")).toBeNull();
  });

  test("rejects path traversal with null bytes", async () => {
    dir = await createTestDir("am-cc-session-");
    await dir.write(".claude/projects/Users-test-proj/.keep", "");

    const reader = createClaudeCodeSessionReader(dir.path);
    expect(await reader.loadSession("foo\0bar")).toBeNull();
    expect(await reader.loadSession("\0")).toBeNull();
  });

  test("rejects path traversal with slashes", async () => {
    dir = await createTestDir("am-cc-session-");
    await dir.write(".claude/projects/Users-test-proj/.keep", "");

    const reader = createClaudeCodeSessionReader(dir.path);
    expect(await reader.loadSession("foo/bar")).toBeNull();
    expect(await reader.loadSession("foo\\bar")).toBeNull();
  });

  test("allows session IDs with dots that are not traversal", async () => {
    dir = await createTestDir("am-cc-session-");
    await dir.write(
      ".claude/projects/Users-test-proj/session.2024.01.01.jsonl",
      jsonl(userRecord("Hello"), assistantTextRecord("Hi")),
    );

    const reader = createClaudeCodeSessionReader(dir.path);
    const session = await reader.loadSession("session.2024.01.01");
    expect(session).not.toBeNull();
    expect(session?.id).toBe("session.2024.01.01");
  });

  test("handles malformed JSONL lines gracefully", async () => {
    dir = await createTestDir("am-cc-session-");
    const content = `${JSON.stringify(userRecord("Hello"))}\nthis is not json\n${JSON.stringify(assistantTextRecord("Hi"))}\n`;
    await dir.write(".claude/projects/Users-test-proj/malformed.jsonl", content);

    const reader = createClaudeCodeSessionReader(dir.path);
    const session = await reader.loadSession("malformed");
    expect(session).not.toBeNull();
    // Malformed line is skipped, valid messages parsed
    expect(session?.messages).toHaveLength(2);
  });

  test("accepts id with .jsonl extension", async () => {
    dir = await createTestDir("am-cc-session-");
    await dir.write(
      ".claude/projects/Users-test-proj/ext-test.jsonl",
      jsonl(userRecord("Hello"), assistantTextRecord("Hi")),
    );

    const reader = createClaudeCodeSessionReader(dir.path);
    const session = await reader.loadSession("ext-test.jsonl");
    expect(session).not.toBeNull();
    expect(session?.id).toBe("ext-test");
  });

  test("sets timestamps from records", async () => {
    dir = await createTestDir("am-cc-session-");
    await dir.write(
      ".claude/projects/Users-test-proj/ts-session.jsonl",
      jsonl(
        userRecord("Start", { timestamp: "2026-04-08T10:00:00.000Z" }),
        assistantTextRecord("End", { timestamp: "2026-04-08T10:05:00.000Z" }),
      ),
    );

    const reader = createClaudeCodeSessionReader(dir.path);
    const session = await reader.loadSession("ts-session");
    expect(session).not.toBeNull();
    expect(session?.startedAt).toEqual(new Date("2026-04-08T10:00:00.000Z"));
    expect(session?.endedAt).toEqual(new Date("2026-04-08T10:05:00.000Z"));
    expect(session?.messages[0].timestamp).toEqual(new Date("2026-04-08T10:00:00.000Z"));
  });

  test("parses user messages with array content (multimodal/tool results)", async () => {
    dir = await createTestDir("am-cc-session-");
    await dir.write(
      ".claude/projects/Users-test-proj/array-user.jsonl",
      jsonl(
        {
          type: "user",
          message: {
            role: "user",
            content: [
              { type: "text", text: "Here is my question" },
              { type: "tool_result", tool_use_id: "t1", content: "tool output" },
              { type: "text", text: "And some more context" },
            ],
          },
          timestamp: "2026-04-08T10:00:00.000Z",
          cwd: "/Users/test/my-project",
        },
        assistantTextRecord("Got it!"),
      ),
    );

    const reader = createClaudeCodeSessionReader(dir.path);
    const session = await reader.loadSession("array-user");
    expect(session).not.toBeNull();
    expect(session?.messages[0].role).toBe("user");
    expect(session?.messages[0].content).toBe("Here is my question\nAnd some more context");
  });

  test("handles assistant record with mixed text and tool_use blocks", async () => {
    dir = await createTestDir("am-cc-session-");
    await dir.write(
      ".claude/projects/Users-test-proj/mixed.jsonl",
      jsonl(userRecord("Do something"), {
        type: "assistant",
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "Let me help you." },
            { type: "tool_use", name: "Edit", input: { file: "a.ts" }, id: "t1" },
          ],
        },
        timestamp: "2026-04-08T10:00:05.000Z",
        uuid: "mix-1",
      }),
    );

    const reader = createClaudeCodeSessionReader(dir.path);
    const session = await reader.loadSession("mixed");
    expect(session).not.toBeNull();
    const msg = session?.messages[1];
    expect(msg.content).toBe("Let me help you.");
    expect(msg.toolCalls).toHaveLength(1);
    expect(msg.toolCalls?.[0].name).toBe("Edit");
  });
});
