import { afterEach, describe, expect, test } from "bun:test";
import { createGeminiSessionReader } from "@/adapters/gemini-cli/session.ts";
import { type TestDir, createTestDir } from "../../helpers/tmp.ts";

/** Build a JSONL string from an array of records. */
function toJsonl(records: unknown[]): string {
  return `${records.map((r) => JSON.stringify(r)).join("\n")}\n`;
}

/** Place a session file under a given project hash dir. */
function chatPath(projectHash: string, filename: string): string {
  return `.gemini/tmp/${projectHash}/chats/${filename}`;
}

describe("Gemini CLI session reader", () => {
  let dir: TestDir;

  afterEach(async () => {
    if (dir) await dir.cleanup();
  });

  // ── hasSessionStorage ──────────────────────────────────────────

  test("hasSessionStorage returns false when no tmp dir", async () => {
    dir = await createTestDir("am-gemini-session-");
    const reader = createGeminiSessionReader(dir.path);
    expect(reader.hasSessionStorage()).toBe(false);
  });

  test("hasSessionStorage returns true when tmp dir exists", async () => {
    dir = await createTestDir("am-gemini-session-");
    await dir.write(".gemini/tmp/.keep", "");
    const reader = createGeminiSessionReader(dir.path);
    expect(reader.hasSessionStorage()).toBe(true);
  });

  // ── listSessions ───────────────────────────────────────────────

  test("listSessions returns empty array when no session files", async () => {
    dir = await createTestDir("am-gemini-session-");
    await dir.write(".gemini/tmp/.keep", "");
    const reader = createGeminiSessionReader(dir.path);
    const sessions = await reader.listSessions();
    expect(sessions).toHaveLength(0);
  });

  test("listSessions discovers a session and populates summary fields", async () => {
    dir = await createTestDir("am-gemini-session-");
    const jsonl = toJsonl([
      {
        sessionId: "sess-001",
        projectHash: "abc123",
        startTime: "2026-04-08T10:00:00Z",
        lastUpdated: "2026-04-08T10:00:02Z",
        kind: "main",
        directories: ["/home/user/project"],
      },
      {
        id: "m1",
        type: "user",
        timestamp: "2026-04-08T10:00:01Z",
        content: "Hello",
      },
      {
        id: "m2",
        type: "gemini",
        timestamp: "2026-04-08T10:00:02Z",
        content: "Hi there!",
      },
    ]);

    await dir.write(chatPath("abc123", "session-2026-04-08T10-00-sess0001.jsonl"), jsonl);

    const reader = createGeminiSessionReader(dir.path);
    const sessions = await reader.listSessions();

    expect(sessions).toHaveLength(1);
    expect(sessions[0].id).toBe("sess-001");
    expect(sessions[0].adapter).toBe("gemini-cli");
    expect(sessions[0].messageCount).toBe(2);
    expect(sessions[0].project).toBe("/home/user/project");
    expect(sessions[0].startedAt).toEqual(new Date("2026-04-08T10:00:00Z"));
    expect(sessions[0].endedAt).toEqual(new Date("2026-04-08T10:00:02Z"));
    expect(sessions[0].estimatedTokens).toBeGreaterThan(0);
  });

  test("listSessions lists multiple sessions sorted newest first", async () => {
    dir = await createTestDir("am-gemini-session-");

    await dir.write(
      chatPath("p1", "session-2026-04-07T08-00-old00001.jsonl"),
      toJsonl([
        {
          sessionId: "old",
          projectHash: "p1",
          startTime: "2026-04-07T08:00:00Z",
        },
        { id: "m1", type: "user", content: "old" },
      ]),
    );

    await dir.write(
      chatPath("p2", "session-2026-04-08T12-00-new00001.jsonl"),
      toJsonl([
        {
          sessionId: "new",
          projectHash: "p2",
          startTime: "2026-04-08T12:00:00Z",
        },
        { id: "m1", type: "user", content: "new" },
      ]),
    );

    const reader = createGeminiSessionReader(dir.path);
    const sessions = await reader.listSessions();

    expect(sessions).toHaveLength(2);
    expect(sessions[0].id).toBe("new");
    expect(sessions[1].id).toBe("old");
  });

  test("listSessions filters by project (via directories metadata)", async () => {
    dir = await createTestDir("am-gemini-session-");

    await dir.write(
      chatPath("p1", "session-2026-04-08T10-00-match001.jsonl"),
      toJsonl([
        {
          sessionId: "match",
          projectHash: "p1",
          startTime: "2026-04-08T10:00:00Z",
          directories: ["/home/user/my-project"],
        },
        { id: "m1", type: "user", content: "hello" },
      ]),
    );

    await dir.write(
      chatPath("p2", "session-2026-04-08T11-00-other001.jsonl"),
      toJsonl([
        {
          sessionId: "no-match",
          projectHash: "p2",
          startTime: "2026-04-08T11:00:00Z",
          directories: ["/home/user/other-project"],
        },
        { id: "m1", type: "user", content: "world" },
      ]),
    );

    const reader = createGeminiSessionReader(dir.path);
    const sessions = await reader.listSessions("/home/user/my-project");

    expect(sessions).toHaveLength(1);
    expect(sessions[0].id).toBe("match");
  });

  // ── loadSession ────────────────────────────────────────────────

  test("loadSession returns null for unknown ID", async () => {
    dir = await createTestDir("am-gemini-session-");
    await dir.write(".gemini/tmp/.keep", "");
    const reader = createGeminiSessionReader(dir.path);
    const session = await reader.loadSession("nonexistent");
    expect(session).toBeNull();
  });

  test("loadSession rejects path traversal with ../", async () => {
    dir = await createTestDir("am-gemini-session-");
    await dir.write(".gemini/tmp/.keep", "");
    const reader = createGeminiSessionReader(dir.path);
    expect(await reader.loadSession("../../etc/passwd")).toBeNull();
    expect(await reader.loadSession("../sibling/file.jsonl")).toBeNull();
    expect(await reader.loadSession("..")).toBeNull();
  });

  test("loadSession rejects path traversal with null bytes", async () => {
    dir = await createTestDir("am-gemini-session-");
    await dir.write(".gemini/tmp/.keep", "");
    const reader = createGeminiSessionReader(dir.path);
    expect(await reader.loadSession("foo\0bar")).toBeNull();
    expect(await reader.loadSession("\0")).toBeNull();
  });

  test("loadSession rejects path traversal with slashes", async () => {
    dir = await createTestDir("am-gemini-session-");
    await dir.write(".gemini/tmp/.keep", "");
    const reader = createGeminiSessionReader(dir.path);
    expect(await reader.loadSession("foo/bar")).toBeNull();
    expect(await reader.loadSession("foo\\bar")).toBeNull();
  });

  test("loadSession allows session IDs with dots that are not traversal", async () => {
    dir = await createTestDir("am-gemini-session-");
    await dir.write(
      chatPath("p1", "session.2024.01.01.jsonl"),
      toJsonl([
        {
          sessionId: "session.2024.01.01",
          projectHash: "p1",
          startTime: "2026-04-08T10:00:00Z",
        },
        { id: "m1", type: "user", content: "hello" },
      ]),
    );
    const reader = createGeminiSessionReader(dir.path);
    const session = await reader.loadSession("session.2024.01.01");
    expect(session).not.toBeNull();
    expect(session?.id).toBe("session.2024.01.01");
  });

  test("loadSession parses full session with all message types and tool calls", async () => {
    dir = await createTestDir("am-gemini-session-");

    const jsonl = toJsonl([
      {
        sessionId: "full-session",
        projectHash: "p1",
        startTime: "2026-04-08T10:00:00Z",
        kind: "main",
        directories: ["/home/user/project"],
      },
      {
        id: "info-1",
        type: "info",
        timestamp: "2026-04-08T10:00:00Z",
        content: "Welcome to Gemini CLI.",
      },
      {
        id: "u1",
        type: "user",
        timestamp: "2026-04-08T10:00:01Z",
        content: "Fix the bug in auth.ts",
      },
      {
        id: "g1",
        type: "gemini",
        timestamp: "2026-04-08T10:00:02Z",
        content: "I'll look at auth.ts and fix the bug.",
        toolCalls: [
          {
            id: "tc1",
            name: "read_file",
            args: { path: "auth.ts" },
            result: "const auth = ...",
            status: "success",
            timestamp: "2026-04-08T10:00:02Z",
          },
        ],
      },
      {
        id: "g2",
        type: "gemini",
        timestamp: "2026-04-08T10:00:05Z",
        content: "Done! I fixed the null check.",
      },
      { $set: { lastUpdated: "2026-04-08T10:00:05Z" } },
    ]);

    await dir.write(chatPath("p1", "session-2026-04-08T10-00-full0001.jsonl"), jsonl);

    const reader = createGeminiSessionReader(dir.path);
    const session = await reader.loadSession("full-session");

    expect(session).not.toBeNull();
    expect(session?.id).toBe("full-session");
    expect(session?.adapter).toBe("gemini-cli");
    expect(session?.project).toBe("/home/user/project");
    expect(session?.metadata?.projectHash).toBe("p1");
    expect(session?.metadata?.kind).toBe("main");

    // info → system, user → user, two gemini → assistant
    expect(session?.messages).toHaveLength(4);

    expect(session?.messages[0].role).toBe("system");
    expect(session?.messages[0].content).toBe("Welcome to Gemini CLI.");

    expect(session?.messages[1].role).toBe("user");
    expect(session?.messages[1].content).toBe("Fix the bug in auth.ts");

    expect(session?.messages[2].role).toBe("assistant");
    expect(session?.messages[2].toolCalls).toHaveLength(1);
    expect(session?.messages[2].toolCalls?.[0].name).toBe("read_file");
    expect(session?.messages[2].toolCalls?.[0].input).toEqual({ path: "auth.ts" });
    expect(session?.messages[2].toolCalls?.[0].output).toBe("const auth = ...");

    expect(session?.messages[3].role).toBe("assistant");
    expect(session?.messages[3].content).toBe("Done! I fixed the null check.");

    expect(session?.startedAt).toEqual(new Date("2026-04-08T10:00:00Z"));
    expect(session?.endedAt).toEqual(new Date("2026-04-08T10:00:05Z"));
  });

  test("loadSession handles content as Part array", async () => {
    dir = await createTestDir("am-gemini-session-");

    const jsonl = toJsonl([
      {
        sessionId: "content-array",
        projectHash: "p1",
        startTime: "2026-04-08T10:00:00Z",
      },
      {
        id: "g1",
        type: "gemini",
        timestamp: "2026-04-08T10:00:01Z",
        content: [{ text: "Part one." }, { text: "Part two." }],
      },
    ]);

    await dir.write(chatPath("p1", "session-2026-04-08T10-00-content1.jsonl"), jsonl);

    const reader = createGeminiSessionReader(dir.path);
    const session = await reader.loadSession("content-array");

    expect(session).not.toBeNull();
    expect(session?.messages).toHaveLength(1);
    expect(session?.messages[0].content).toBe("Part one.\nPart two.");
  });

  test("loadSession honors $rewindTo by truncating messages from that id onward", async () => {
    dir = await createTestDir("am-gemini-session-");

    const jsonl = toJsonl([
      {
        sessionId: "rewound",
        projectHash: "p1",
        startTime: "2026-04-08T10:00:00Z",
      },
      { id: "u1", type: "user", content: "first prompt" },
      { id: "g1", type: "gemini", content: "first answer" },
      { id: "u2", type: "user", content: "second prompt — to be rewound" },
      { id: "g2", type: "gemini", content: "second answer — to be rewound" },
      { $rewindTo: "u2" },
      { id: "u3", type: "user", content: "redo" },
      { id: "g3", type: "gemini", content: "fresh answer" },
    ]);

    await dir.write(chatPath("p1", "session-2026-04-08T10-00-rewound01.jsonl"), jsonl);

    const reader = createGeminiSessionReader(dir.path);
    const session = await reader.loadSession("rewound");

    expect(session).not.toBeNull();
    expect(session?.messages.map((m) => m.content)).toEqual([
      "first prompt",
      "first answer",
      "redo",
      "fresh answer",
    ]);
  });

  // ── Defensive parsing ──────────────────────────────────────────

  test("skips malformed JSONL lines without crashing", async () => {
    dir = await createTestDir("am-gemini-session-");

    const content = [
      JSON.stringify({
        sessionId: "robust",
        projectHash: "p1",
        startTime: "2026-04-08T10:00:00Z",
      }),
      "this is not json",
      '{"incomplete json',
      "",
      JSON.stringify({ id: "u1", type: "user", content: "still works" }),
    ].join("\n");

    await dir.write(chatPath("p1", "session-2026-04-08T10-00-robust01.jsonl"), content);

    const reader = createGeminiSessionReader(dir.path);
    const session = await reader.loadSession("robust");

    expect(session).not.toBeNull();
    expect(session?.id).toBe("robust");
    expect(session?.messages).toHaveLength(1);
    expect(session?.messages[0].content).toBe("still works");
  });

  test("handles empty session file gracefully", async () => {
    dir = await createTestDir("am-gemini-session-");
    await dir.write(chatPath("p1", "session-2026-04-08T10-00-empty001.jsonl"), "");

    const reader = createGeminiSessionReader(dir.path);
    const sessions = await reader.listSessions();
    expect(sessions).toHaveLength(0);
  });

  test("derives session ID from filename when metadata absent", async () => {
    dir = await createTestDir("am-gemini-session-");

    const jsonl = toJsonl([{ id: "u1", type: "user", content: "no meta" }]);

    await dir.write(chatPath("p1", "derived-id.jsonl"), jsonl);

    const reader = createGeminiSessionReader(dir.path);
    const sessions = await reader.listSessions();

    expect(sessions).toHaveLength(1);
    expect(sessions[0].id).toBe("derived-id");
  });

  test("skips records without a recognised type or id", async () => {
    dir = await createTestDir("am-gemini-session-");

    const content = [
      JSON.stringify({
        sessionId: "typed",
        projectHash: "p1",
        startTime: "2026-04-08T10:00:00Z",
      }),
      JSON.stringify({ no_type_no_id: true, data: "ignored" }),
      JSON.stringify({ id: "weird1", type: "unknown-type", content: "ignored" }),
      JSON.stringify({ id: "u1", type: "user", content: "kept" }),
    ].join("\n");

    await dir.write(chatPath("p1", "session-2026-04-08T10-00-typed001.jsonl"), content);

    const reader = createGeminiSessionReader(dir.path);
    const session = await reader.loadSession("typed");

    expect(session?.messages).toHaveLength(1);
    expect(session?.messages[0].content).toBe("kept");
  });

  test("subagent sessions nested under parent dir are also discovered", async () => {
    dir = await createTestDir("am-gemini-session-");

    // Parent
    await dir.write(
      chatPath("p1", "session-2026-04-08T10-00-parent01.jsonl"),
      toJsonl([
        {
          sessionId: "parent",
          projectHash: "p1",
          startTime: "2026-04-08T10:00:00Z",
        },
        { id: "u1", type: "user", content: "parent" },
      ]),
    );

    // Subagent (nested under parent's full id)
    await dir.write(
      chatPath("p1", "parent/subagent.jsonl"),
      toJsonl([
        {
          sessionId: "subagent",
          projectHash: "p1",
          startTime: "2026-04-08T10:01:00Z",
          kind: "subagent",
        },
        { id: "u1", type: "user", content: "sub" },
      ]),
    );

    const reader = createGeminiSessionReader(dir.path);
    const sessions = await reader.listSessions();

    expect(sessions.map((s) => s.id).sort()).toEqual(["parent", "subagent"]);
  });
});
