import { afterEach, describe, expect, test } from "bun:test";
import { createCodexSessionReader } from "@/adapters/codex-cli/session.ts";
import { type TestDir, createTestDir } from "../../helpers/tmp.ts";

/** Build a JSONL string from an array of records. */
function toJsonl(records: unknown[]): string {
  return `${records.map((r) => JSON.stringify(r)).join("\n")}\n`;
}

describe("Codex CLI session reader", () => {
  let dir: TestDir;

  afterEach(async () => {
    if (dir) await dir.cleanup();
  });

  // ── hasSessionStorage ──────────────────────────────────────────

  test("hasSessionStorage returns false when no sessions dir", async () => {
    dir = await createTestDir("am-codex-session-");
    const reader = createCodexSessionReader(dir.path);
    expect(reader.hasSessionStorage()).toBe(false);
  });

  test("hasSessionStorage returns true when sessions dir exists", async () => {
    dir = await createTestDir("am-codex-session-");
    await dir.write(".codex/sessions/.keep", "");
    const reader = createCodexSessionReader(dir.path);
    expect(reader.hasSessionStorage()).toBe(true);
  });

  // ── listSessions ───────────────────────────────────────────────

  test("listSessions returns empty array when no session files", async () => {
    dir = await createTestDir("am-codex-session-");
    await dir.write(".codex/sessions/.keep", "");
    const reader = createCodexSessionReader(dir.path);
    const sessions = await reader.listSessions();
    expect(sessions).toHaveLength(0);
  });

  test("listSessions discovers sessions in YYYY/MM/DD structure", async () => {
    dir = await createTestDir("am-codex-session-");
    const jsonl = toJsonl([
      {
        type: "session_meta",
        session_id: "sess-001",
        started_at: "2026-04-08T10:00:00Z",
        model: "o3",
        cwd: "/home/user/project",
      },
      {
        type: "event_msg",
        role: "user",
        content: "Hello",
        timestamp: "2026-04-08T10:00:01Z",
      },
      {
        type: "response_item",
        role: "assistant",
        content: "Hi there!",
        timestamp: "2026-04-08T10:00:02Z",
      },
    ]);

    await dir.write(".codex/sessions/2026/04/08/sess-001.jsonl", jsonl);

    const reader = createCodexSessionReader(dir.path);
    const sessions = await reader.listSessions();

    expect(sessions).toHaveLength(1);
    expect(sessions[0].id).toBe("sess-001");
    expect(sessions[0].adapter).toBe("codex-cli");
    expect(sessions[0].messageCount).toBe(2);
    expect(sessions[0].project).toBe("/home/user/project");
    expect(sessions[0].startedAt).toEqual(new Date("2026-04-08T10:00:00Z"));
    expect(sessions[0].endedAt).toEqual(new Date("2026-04-08T10:00:02Z"));
    expect(sessions[0].estimatedTokens).toBeGreaterThan(0);
  });

  test("listSessions lists multiple sessions sorted newest first", async () => {
    dir = await createTestDir("am-codex-session-");

    await dir.write(
      ".codex/sessions/2026/04/07/old.jsonl",
      toJsonl([
        {
          type: "session_meta",
          session_id: "old",
          started_at: "2026-04-07T08:00:00Z",
        },
        { type: "event_msg", role: "user", content: "old" },
      ]),
    );

    await dir.write(
      ".codex/sessions/2026/04/08/new.jsonl",
      toJsonl([
        {
          type: "session_meta",
          session_id: "new",
          started_at: "2026-04-08T12:00:00Z",
        },
        { type: "event_msg", role: "user", content: "new" },
      ]),
    );

    const reader = createCodexSessionReader(dir.path);
    const sessions = await reader.listSessions();

    expect(sessions).toHaveLength(2);
    expect(sessions[0].id).toBe("new");
    expect(sessions[1].id).toBe("old");
  });

  test("listSessions filters by project", async () => {
    dir = await createTestDir("am-codex-session-");

    await dir.write(
      ".codex/sessions/2026/04/08/a.jsonl",
      toJsonl([
        {
          type: "session_meta",
          session_id: "match",
          started_at: "2026-04-08T10:00:00Z",
          cwd: "/home/user/my-project",
        },
        { type: "event_msg", role: "user", content: "hello" },
      ]),
    );

    await dir.write(
      ".codex/sessions/2026/04/08/b.jsonl",
      toJsonl([
        {
          type: "session_meta",
          session_id: "no-match",
          started_at: "2026-04-08T11:00:00Z",
          cwd: "/home/user/other-project",
        },
        { type: "event_msg", role: "user", content: "world" },
      ]),
    );

    const reader = createCodexSessionReader(dir.path);
    const sessions = await reader.listSessions("/home/user/my-project");

    expect(sessions).toHaveLength(1);
    expect(sessions[0].id).toBe("match");
  });

  // ── loadSession ────────────────────────────────────────────────

  test("loadSession returns null for unknown ID", async () => {
    dir = await createTestDir("am-codex-session-");
    await dir.write(".codex/sessions/.keep", "");
    const reader = createCodexSessionReader(dir.path);
    const session = await reader.loadSession("nonexistent");
    expect(session).toBeNull();
  });

  test("loadSession rejects path traversal with ../", async () => {
    dir = await createTestDir("am-codex-session-");
    await dir.write(".codex/sessions/.keep", "");
    const reader = createCodexSessionReader(dir.path);
    expect(await reader.loadSession("../../etc/passwd")).toBeNull();
    expect(await reader.loadSession("../sibling/file.jsonl")).toBeNull();
    expect(await reader.loadSession("..")).toBeNull();
  });

  test("loadSession rejects path traversal with null bytes", async () => {
    dir = await createTestDir("am-codex-session-");
    await dir.write(".codex/sessions/.keep", "");
    const reader = createCodexSessionReader(dir.path);
    expect(await reader.loadSession("foo\0bar")).toBeNull();
    expect(await reader.loadSession("\0")).toBeNull();
  });

  test("loadSession rejects path traversal with slashes", async () => {
    dir = await createTestDir("am-codex-session-");
    await dir.write(".codex/sessions/.keep", "");
    const reader = createCodexSessionReader(dir.path);
    expect(await reader.loadSession("foo/bar")).toBeNull();
    expect(await reader.loadSession("foo\\bar")).toBeNull();
  });

  test("loadSession allows session IDs with dots that are not traversal", async () => {
    dir = await createTestDir("am-codex-session-");
    await dir.write(
      ".codex/sessions/2026/04/08/session.2024.01.01.jsonl",
      toJsonl([
        {
          type: "session_meta",
          session_id: "session.2024.01.01",
          started_at: "2026-04-08T10:00:00Z",
        },
        { type: "event_msg", role: "user", content: "hello" },
      ]),
    );
    const reader = createCodexSessionReader(dir.path);
    const session = await reader.loadSession("session.2024.01.01");
    expect(session).not.toBeNull();
    expect(session?.id).toBe("session.2024.01.01");
  });

  test("loadSession parses full session with all message types", async () => {
    dir = await createTestDir("am-codex-session-");

    const jsonl = toJsonl([
      {
        type: "session_meta",
        session_id: "full-session",
        started_at: "2026-04-08T10:00:00Z",
        model: "o3",
        cwd: "/home/user/project",
      },
      {
        type: "turn_context",
        content: "You are a helpful assistant.",
        timestamp: "2026-04-08T10:00:00Z",
      },
      {
        type: "event_msg",
        role: "user",
        content: "Fix the bug in auth.ts",
        timestamp: "2026-04-08T10:00:01Z",
      },
      {
        type: "response_item",
        role: "assistant",
        content: "I'll look at auth.ts and fix the bug.",
        timestamp: "2026-04-08T10:00:02Z",
        function_call: {
          name: "read_file",
          arguments: '{"path": "auth.ts"}',
          output: "const auth = ...",
        },
      },
      {
        type: "response_item",
        role: "assistant",
        content: "Done! I fixed the null check.",
        timestamp: "2026-04-08T10:00:05Z",
      },
    ]);

    await dir.write(".codex/sessions/2026/04/08/full-session.jsonl", jsonl);

    const reader = createCodexSessionReader(dir.path);
    const session = await reader.loadSession("full-session");

    expect(session).not.toBeNull();
    expect(session?.id).toBe("full-session");
    expect(session?.adapter).toBe("codex-cli");
    expect(session?.project).toBe("/home/user/project");
    expect(session?.metadata?.model).toBe("o3");

    // system (turn_context) + user + 2 assistant = 4 messages
    expect(session?.messages).toHaveLength(4);

    // turn_context → system message
    expect(session?.messages[0].role).toBe("system");
    expect(session?.messages[0].content).toBe("You are a helpful assistant.");

    // event_msg → user message
    expect(session?.messages[1].role).toBe("user");
    expect(session?.messages[1].content).toBe("Fix the bug in auth.ts");

    // response_item with function_call → assistant with toolCalls
    expect(session?.messages[2].role).toBe("assistant");
    expect(session?.messages[2].toolCalls).toHaveLength(1);
    expect(session?.messages[2].toolCalls?.[0].name).toBe("read_file");
    expect(session?.messages[2].toolCalls?.[0].input).toEqual({
      path: "auth.ts",
    });
    expect(session?.messages[2].toolCalls?.[0].output).toBe("const auth = ...");

    // Final assistant message
    expect(session?.messages[3].role).toBe("assistant");
    expect(session?.messages[3].content).toBe("Done! I fixed the null check.");

    // Timestamps
    expect(session?.startedAt).toEqual(new Date("2026-04-08T10:00:00Z"));
    expect(session?.endedAt).toEqual(new Date("2026-04-08T10:00:05Z"));
  });

  test("loadSession handles response_item with content array", async () => {
    dir = await createTestDir("am-codex-session-");

    const jsonl = toJsonl([
      {
        type: "session_meta",
        session_id: "content-array",
        started_at: "2026-04-08T10:00:00Z",
      },
      {
        type: "response_item",
        role: "assistant",
        content: [
          { type: "text", text: "Part one." },
          { type: "text", text: "Part two." },
        ],
        timestamp: "2026-04-08T10:00:01Z",
      },
    ]);

    await dir.write(".codex/sessions/2026/04/08/content-array.jsonl", jsonl);

    const reader = createCodexSessionReader(dir.path);
    const session = await reader.loadSession("content-array");

    expect(session).not.toBeNull();
    expect(session?.messages).toHaveLength(1);
    expect(session?.messages[0].content).toBe("Part one.\nPart two.");
  });

  test("loadSession handles tool_calls array", async () => {
    dir = await createTestDir("am-codex-session-");

    const jsonl = toJsonl([
      {
        type: "session_meta",
        session_id: "multi-tool",
        started_at: "2026-04-08T10:00:00Z",
      },
      {
        type: "response_item",
        role: "assistant",
        content: "Running tools...",
        tool_calls: [
          { name: "read_file", arguments: '{"path": "a.ts"}' },
          {
            name: "write_file",
            arguments: '{"path": "b.ts", "content": "x"}',
            output: "written",
          },
        ],
      },
    ]);

    await dir.write(".codex/sessions/2026/04/08/multi-tool.jsonl", jsonl);

    const reader = createCodexSessionReader(dir.path);
    const session = await reader.loadSession("multi-tool");

    expect(session?.messages[0].toolCalls).toHaveLength(2);
    expect(session?.messages[0].toolCalls?.[0].name).toBe("read_file");
    expect(session?.messages[0].toolCalls?.[1].name).toBe("write_file");
    expect(session?.messages[0].toolCalls?.[1].output).toBe("written");
  });

  // ── Defensive parsing ──────────────────────────────────────────

  test("skips malformed JSONL lines without crashing", async () => {
    dir = await createTestDir("am-codex-session-");

    const content = [
      JSON.stringify({
        type: "session_meta",
        session_id: "robust",
        started_at: "2026-04-08T10:00:00Z",
      }),
      "this is not json",
      '{"incomplete json',
      "",
      JSON.stringify({
        type: "event_msg",
        role: "user",
        content: "still works",
      }),
    ].join("\n");

    await dir.write(".codex/sessions/2026/04/08/robust.jsonl", content);

    const reader = createCodexSessionReader(dir.path);
    const session = await reader.loadSession("robust");

    expect(session).not.toBeNull();
    expect(session?.id).toBe("robust");
    expect(session?.messages).toHaveLength(1);
    expect(session?.messages[0].content).toBe("still works");
  });

  test("handles empty session file gracefully", async () => {
    dir = await createTestDir("am-codex-session-");
    await dir.write(".codex/sessions/2026/04/08/empty.jsonl", "");

    const reader = createCodexSessionReader(dir.path);
    const sessions = await reader.listSessions();
    expect(sessions).toHaveLength(0);
  });

  test("derives session ID from filename when no session_meta", async () => {
    dir = await createTestDir("am-codex-session-");

    const jsonl = toJsonl([{ type: "event_msg", role: "user", content: "no meta" }]);

    await dir.write(".codex/sessions/2026/04/08/derived-id.jsonl", jsonl);

    const reader = createCodexSessionReader(dir.path);
    const sessions = await reader.listSessions();

    expect(sessions).toHaveLength(1);
    expect(sessions[0].id).toBe("derived-id");
  });

  test("derives date from path when no started_at in meta", async () => {
    dir = await createTestDir("am-codex-session-");

    const jsonl = toJsonl([
      { type: "session_meta", session_id: "no-date" },
      { type: "event_msg", role: "user", content: "hello" },
    ]);

    await dir.write(".codex/sessions/2026/03/15/no-date.jsonl", jsonl);

    const reader = createCodexSessionReader(dir.path);
    const sessions = await reader.listSessions();

    expect(sessions).toHaveLength(1);
    expect(sessions[0].startedAt.getFullYear()).toBe(2026);
    expect(sessions[0].startedAt.getMonth()).toBe(2); // 0-indexed: March = 2
    expect(sessions[0].startedAt.getDate()).toBe(15);
  });

  test("skips records without a type field", async () => {
    dir = await createTestDir("am-codex-session-");

    const content = [
      JSON.stringify({
        type: "session_meta",
        session_id: "typed",
        started_at: "2026-04-08T10:00:00Z",
      }),
      JSON.stringify({ no_type: true, data: "ignored" }),
      JSON.stringify({
        type: "event_msg",
        role: "user",
        content: "kept",
      }),
    ].join("\n");

    await dir.write(".codex/sessions/2026/04/08/typed.jsonl", content);

    const reader = createCodexSessionReader(dir.path);
    const session = await reader.loadSession("typed");

    expect(session?.messages).toHaveLength(1);
    expect(session?.messages[0].content).toBe("kept");
  });
});
