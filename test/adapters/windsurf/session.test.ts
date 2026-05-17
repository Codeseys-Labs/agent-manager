import { afterEach, describe, expect, test } from "bun:test";
import { createWindsurfSessionReader } from "@/adapters/windsurf/session.ts";
import { type TestDir, createTestDir } from "../../helpers/tmp.ts";

const CONV_DIR = ".codeium/windsurf/cascade/conversations";

/** Build a JSONL string from an array of records. */
function toJsonl(records: unknown[]): string {
  return `${records.map((r) => JSON.stringify(r)).join("\n")}\n`;
}

describe("Windsurf session reader", () => {
  let dir: TestDir;

  afterEach(async () => {
    if (dir) await dir.cleanup();
  });

  // ── hasSessionStorage ──────────────────────────────────────────

  test("hasSessionStorage returns false when no conversations dir", async () => {
    dir = await createTestDir("am-windsurf-session-");
    const reader = createWindsurfSessionReader(dir.path);
    expect(reader.hasSessionStorage()).toBe(false);
  });

  test("hasSessionStorage returns true when conversations dir exists", async () => {
    dir = await createTestDir("am-windsurf-session-");
    await dir.write(`${CONV_DIR}/.keep`, "");
    const reader = createWindsurfSessionReader(dir.path);
    expect(reader.hasSessionStorage()).toBe(true);
  });

  // ── listSessions ───────────────────────────────────────────────

  test("listSessions returns empty array when no conversation files", async () => {
    dir = await createTestDir("am-windsurf-session-");
    await dir.write(`${CONV_DIR}/.keep`, "");
    const reader = createWindsurfSessionReader(dir.path);
    const sessions = await reader.listSessions();
    expect(sessions).toHaveLength(0);
  });

  test("listSessions returns empty array when storage is missing", async () => {
    dir = await createTestDir("am-windsurf-session-");
    const reader = createWindsurfSessionReader(dir.path);
    const sessions = await reader.listSessions();
    expect(sessions).toHaveLength(0);
  });

  test("listSessions discovers a conversation file", async () => {
    dir = await createTestDir("am-windsurf-session-");
    const jsonl = toJsonl([
      {
        type: "conversation_meta",
        conversation_id: "conv-001",
        started_at: "2026-04-08T10:00:00Z",
        model: "claude-sonnet-4-6",
        cwd: "/home/user/project",
      },
      {
        type: "user_message",
        content: "Hello",
        timestamp: "2026-04-08T10:00:01Z",
      },
      {
        type: "assistant_message",
        content: "Hi there!",
        timestamp: "2026-04-08T10:00:02Z",
      },
    ]);

    await dir.write(`${CONV_DIR}/conv-001.jsonl`, jsonl);

    const reader = createWindsurfSessionReader(dir.path);
    const sessions = await reader.listSessions();

    expect(sessions).toHaveLength(1);
    expect(sessions[0].id).toBe("conv-001");
    expect(sessions[0].adapter).toBe("windsurf");
    expect(sessions[0].messageCount).toBe(2);
    expect(sessions[0].project).toBe("/home/user/project");
    expect(sessions[0].startedAt).toEqual(new Date("2026-04-08T10:00:00Z"));
    expect(sessions[0].endedAt).toEqual(new Date("2026-04-08T10:00:02Z"));
    expect(sessions[0].estimatedTokens).toBeGreaterThan(0);
  });

  test("listSessions lists multiple sessions sorted newest first", async () => {
    dir = await createTestDir("am-windsurf-session-");

    await dir.write(
      `${CONV_DIR}/old.jsonl`,
      toJsonl([
        {
          type: "conversation_meta",
          conversation_id: "old",
          started_at: "2026-04-07T08:00:00Z",
        },
        { type: "user_message", content: "old" },
      ]),
    );

    await dir.write(
      `${CONV_DIR}/new.jsonl`,
      toJsonl([
        {
          type: "conversation_meta",
          conversation_id: "new",
          started_at: "2026-04-08T12:00:00Z",
        },
        { type: "user_message", content: "new" },
      ]),
    );

    const reader = createWindsurfSessionReader(dir.path);
    const sessions = await reader.listSessions();

    expect(sessions).toHaveLength(2);
    expect(sessions[0].id).toBe("new");
    expect(sessions[1].id).toBe("old");
  });

  test("listSessions filters by project (cwd)", async () => {
    dir = await createTestDir("am-windsurf-session-");

    await dir.write(
      `${CONV_DIR}/match.jsonl`,
      toJsonl([
        {
          type: "conversation_meta",
          conversation_id: "match",
          started_at: "2026-04-08T10:00:00Z",
          cwd: "/home/user/my-project",
        },
        { type: "user_message", content: "hello" },
      ]),
    );

    await dir.write(
      `${CONV_DIR}/no-match.jsonl`,
      toJsonl([
        {
          type: "conversation_meta",
          conversation_id: "no-match",
          started_at: "2026-04-08T11:00:00Z",
          cwd: "/home/user/other-project",
        },
        { type: "user_message", content: "world" },
      ]),
    );

    const reader = createWindsurfSessionReader(dir.path);
    const sessions = await reader.listSessions("/home/user/my-project");

    expect(sessions).toHaveLength(1);
    expect(sessions[0].id).toBe("match");
  });

  test("listSessions filters by project (workspace fallback)", async () => {
    dir = await createTestDir("am-windsurf-session-");

    await dir.write(
      `${CONV_DIR}/ws.jsonl`,
      toJsonl([
        {
          type: "conversation_meta",
          conversation_id: "ws",
          started_at: "2026-04-08T10:00:00Z",
          workspace: "/home/user/my-project",
        },
        { type: "user_message", content: "hello" },
      ]),
    );

    const reader = createWindsurfSessionReader(dir.path);
    const sessions = await reader.listSessions("/home/user/my-project");
    expect(sessions).toHaveLength(1);
    expect(sessions[0].id).toBe("ws");
    expect(sessions[0].project).toBe("/home/user/my-project");
  });

  // ── loadSession ────────────────────────────────────────────────

  test("loadSession returns null for unknown ID", async () => {
    dir = await createTestDir("am-windsurf-session-");
    await dir.write(`${CONV_DIR}/.keep`, "");
    const reader = createWindsurfSessionReader(dir.path);
    const session = await reader.loadSession("nonexistent");
    expect(session).toBeNull();
  });

  test("loadSession rejects path traversal with ../", async () => {
    dir = await createTestDir("am-windsurf-session-");
    await dir.write(`${CONV_DIR}/.keep`, "");
    const reader = createWindsurfSessionReader(dir.path);
    expect(await reader.loadSession("../../etc/passwd")).toBeNull();
    expect(await reader.loadSession("../sibling/file.jsonl")).toBeNull();
    expect(await reader.loadSession("..")).toBeNull();
  });

  test("loadSession rejects path traversal with null bytes", async () => {
    dir = await createTestDir("am-windsurf-session-");
    await dir.write(`${CONV_DIR}/.keep`, "");
    const reader = createWindsurfSessionReader(dir.path);
    expect(await reader.loadSession("foo\0bar")).toBeNull();
    expect(await reader.loadSession("\0")).toBeNull();
  });

  test("loadSession rejects path traversal with slashes", async () => {
    dir = await createTestDir("am-windsurf-session-");
    await dir.write(`${CONV_DIR}/.keep`, "");
    const reader = createWindsurfSessionReader(dir.path);
    expect(await reader.loadSession("foo/bar")).toBeNull();
    expect(await reader.loadSession("foo\\bar")).toBeNull();
  });

  test("loadSession allows IDs with embedded dots that are not traversal", async () => {
    dir = await createTestDir("am-windsurf-session-");
    await dir.write(
      `${CONV_DIR}/conv.2024.01.01.jsonl`,
      toJsonl([
        {
          type: "conversation_meta",
          conversation_id: "conv.2024.01.01",
          started_at: "2026-04-08T10:00:00Z",
        },
        { type: "user_message", content: "hello" },
      ]),
    );
    const reader = createWindsurfSessionReader(dir.path);
    const session = await reader.loadSession("conv.2024.01.01");
    expect(session).not.toBeNull();
    expect(session?.id).toBe("conv.2024.01.01");
  });

  test("loadSession parses full session with all message types", async () => {
    dir = await createTestDir("am-windsurf-session-");

    const jsonl = toJsonl([
      {
        type: "conversation_meta",
        conversation_id: "full-session",
        started_at: "2026-04-08T10:00:00Z",
        model: "claude-sonnet-4-6",
        cwd: "/home/user/project",
      },
      {
        type: "system_message",
        content: "You are Cascade.",
        timestamp: "2026-04-08T10:00:00Z",
      },
      {
        type: "user_message",
        content: "Fix the bug in auth.ts",
        timestamp: "2026-04-08T10:00:01Z",
      },
      {
        type: "assistant_message",
        content: "I'll look at auth.ts and fix the bug.",
        timestamp: "2026-04-08T10:00:02Z",
        tool_calls: [
          {
            name: "read_file",
            arguments: '{"path": "auth.ts"}',
            output: "const auth = ...",
          },
        ],
      },
      {
        type: "assistant_message",
        content: "Done! I fixed the null check.",
        timestamp: "2026-04-08T10:00:05Z",
      },
    ]);

    await dir.write(`${CONV_DIR}/full-session.jsonl`, jsonl);

    const reader = createWindsurfSessionReader(dir.path);
    const session = await reader.loadSession("full-session");

    expect(session).not.toBeNull();
    expect(session?.id).toBe("full-session");
    expect(session?.adapter).toBe("windsurf");
    expect(session?.project).toBe("/home/user/project");
    expect(session?.metadata?.model).toBe("claude-sonnet-4-6");

    expect(session?.messages).toHaveLength(4);

    expect(session?.messages[0].role).toBe("system");
    expect(session?.messages[0].content).toBe("You are Cascade.");

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

    // Timestamps preserved on every message that had one
    expect(session?.messages[1].timestamp).toEqual(new Date("2026-04-08T10:00:01Z"));
    expect(session?.messages[3].timestamp).toEqual(new Date("2026-04-08T10:00:05Z"));
  });

  test("loadSession handles assistant content array", async () => {
    dir = await createTestDir("am-windsurf-session-");

    const jsonl = toJsonl([
      {
        type: "conversation_meta",
        conversation_id: "content-array",
        started_at: "2026-04-08T10:00:00Z",
      },
      {
        type: "assistant_message",
        content: [
          { type: "text", text: "Part one." },
          { type: "text", text: "Part two." },
        ],
        timestamp: "2026-04-08T10:00:01Z",
      },
    ]);

    await dir.write(`${CONV_DIR}/content-array.jsonl`, jsonl);

    const reader = createWindsurfSessionReader(dir.path);
    const session = await reader.loadSession("content-array");

    expect(session).not.toBeNull();
    expect(session?.messages).toHaveLength(1);
    expect(session?.messages[0].content).toBe("Part one.\nPart two.");
  });

  test("loadSession attaches standalone tool_call records to prior assistant message", async () => {
    dir = await createTestDir("am-windsurf-session-");

    const jsonl = toJsonl([
      {
        type: "conversation_meta",
        conversation_id: "standalone-tool",
        started_at: "2026-04-08T10:00:00Z",
      },
      {
        type: "assistant_message",
        content: "Running tools...",
        timestamp: "2026-04-08T10:00:01Z",
      },
      {
        type: "tool_call",
        name: "write_file",
        arguments: '{"path": "b.ts"}',
        output: "written",
        timestamp: "2026-04-08T10:00:02Z",
      },
    ]);

    await dir.write(`${CONV_DIR}/standalone-tool.jsonl`, jsonl);

    const reader = createWindsurfSessionReader(dir.path);
    const session = await reader.loadSession("standalone-tool");

    expect(session?.messages).toHaveLength(1);
    expect(session?.messages[0].toolCalls).toHaveLength(1);
    expect(session?.messages[0].toolCalls?.[0].name).toBe("write_file");
    expect(session?.messages[0].toolCalls?.[0].output).toBe("written");
  });

  // ── Defensive parsing ──────────────────────────────────────────

  test("skips malformed JSONL lines without crashing", async () => {
    dir = await createTestDir("am-windsurf-session-");

    const content = [
      JSON.stringify({
        type: "conversation_meta",
        conversation_id: "robust",
        started_at: "2026-04-08T10:00:00Z",
      }),
      "this is not json",
      '{"incomplete json',
      "",
      JSON.stringify({
        type: "user_message",
        content: "still works",
      }),
    ].join("\n");

    await dir.write(`${CONV_DIR}/robust.jsonl`, content);

    const reader = createWindsurfSessionReader(dir.path);
    const session = await reader.loadSession("robust");

    expect(session).not.toBeNull();
    expect(session?.id).toBe("robust");
    expect(session?.messages).toHaveLength(1);
    expect(session?.messages[0].content).toBe("still works");
  });

  test("handles empty conversation file gracefully", async () => {
    dir = await createTestDir("am-windsurf-session-");
    await dir.write(`${CONV_DIR}/empty.jsonl`, "");

    const reader = createWindsurfSessionReader(dir.path);
    const sessions = await reader.listSessions();
    expect(sessions).toHaveLength(0);
  });

  test("derives session ID from filename when no conversation_meta", async () => {
    dir = await createTestDir("am-windsurf-session-");

    const jsonl = toJsonl([{ type: "user_message", content: "no meta" }]);

    await dir.write(`${CONV_DIR}/derived-id.jsonl`, jsonl);

    const reader = createWindsurfSessionReader(dir.path);
    const sessions = await reader.listSessions();

    expect(sessions).toHaveLength(1);
    expect(sessions[0].id).toBe("derived-id");
  });

  test("skips records without a type field", async () => {
    dir = await createTestDir("am-windsurf-session-");

    const content = [
      JSON.stringify({
        type: "conversation_meta",
        conversation_id: "typed",
        started_at: "2026-04-08T10:00:00Z",
      }),
      JSON.stringify({ no_type: true, data: "ignored" }),
      JSON.stringify({
        type: "user_message",
        content: "kept",
      }),
    ].join("\n");

    await dir.write(`${CONV_DIR}/typed.jsonl`, content);

    const reader = createWindsurfSessionReader(dir.path);
    const session = await reader.loadSession("typed");

    expect(session?.messages).toHaveLength(1);
    expect(session?.messages[0].content).toBe("kept");
  });

  test("ignores non-jsonl files in conversations directory", async () => {
    dir = await createTestDir("am-windsurf-session-");
    await dir.write(`${CONV_DIR}/notes.md`, "# scratch");
    await dir.write(
      `${CONV_DIR}/real.jsonl`,
      toJsonl([
        {
          type: "conversation_meta",
          conversation_id: "real",
          started_at: "2026-04-08T10:00:00Z",
        },
        { type: "user_message", content: "hi" },
      ]),
    );

    const reader = createWindsurfSessionReader(dir.path);
    const sessions = await reader.listSessions();
    expect(sessions).toHaveLength(1);
    expect(sessions[0].id).toBe("real");
  });
});
