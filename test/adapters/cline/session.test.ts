import { afterEach, describe, expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { createClineSessionReader } from "@/adapters/cline/session.ts";
import { resolveVSCodeExtensionStorage } from "@/adapters/shared/vscode-paths.ts";
import { type TestDir, createTestDir } from "../../helpers/tmp.ts";

const EXTENSION_ID = "saoudrizwan.claude-dev";

/** First candidate globalStorage path (stable VS Code) for a fake home. */
function stableGlobalStorageDir(home: string): string {
  return resolveVSCodeExtensionStorage([EXTENSION_ID], home)[0];
}

/** Second candidate globalStorage path (VS Code Insiders) for a fake home. */
function insidersGlobalStorageDir(home: string): string {
  return resolveVSCodeExtensionStorage([EXTENSION_ID], home)[1];
}

interface TaskSeed {
  taskId: string;
  globalStorageDir?: string;
  /** api_conversation_history.json contents. Omit to skip writing the file. */
  apiHistory?: unknown;
  /** Raw (pre-stringified) api_conversation_history.json — for corrupt JSON tests. */
  rawApiHistory?: string;
  /** ui_messages.json contents (timestamped events). */
  uiMessages?: Array<{ ts?: number; [key: string]: unknown }>;
  /** task_metadata.json contents. */
  metadata?: Record<string, unknown>;
}

async function seedTask(home: string, seed: TaskSeed): Promise<string> {
  const storageDir = seed.globalStorageDir ?? stableGlobalStorageDir(home);
  const taskDir = join(storageDir, "tasks", seed.taskId);
  await mkdir(taskDir, { recursive: true });

  const apiPath = join(taskDir, "api_conversation_history.json");
  if (seed.rawApiHistory !== undefined) {
    await Bun.write(apiPath, seed.rawApiHistory);
  } else if (seed.apiHistory !== undefined) {
    await Bun.write(apiPath, JSON.stringify(seed.apiHistory));
  }

  if (seed.uiMessages !== undefined) {
    await Bun.write(join(taskDir, "ui_messages.json"), JSON.stringify(seed.uiMessages));
  }
  if (seed.metadata !== undefined) {
    await Bun.write(join(taskDir, "task_metadata.json"), JSON.stringify(seed.metadata));
  }
  return taskDir;
}

describe("Cline session reader", () => {
  let dir: TestDir;

  afterEach(async () => {
    if (dir) await dir.cleanup();
  });

  // ── hasSessionStorage ────────────────────────────────────────────

  test("hasSessionStorage returns false when no globalStorage exists", async () => {
    dir = await createTestDir("am-cline-session-");
    const reader = createClineSessionReader(dir.path);
    expect(reader.hasSessionStorage()).toBe(false);
  });

  test("hasSessionStorage returns true when stable VS Code globalStorage exists", async () => {
    dir = await createTestDir("am-cline-session-");
    await mkdir(stableGlobalStorageDir(dir.path), { recursive: true });
    const reader = createClineSessionReader(dir.path);
    expect(reader.hasSessionStorage()).toBe(true);
  });

  test("hasSessionStorage returns true when only VS Code Insiders has the extension", async () => {
    dir = await createTestDir("am-cline-session-");
    await mkdir(insidersGlobalStorageDir(dir.path), { recursive: true });
    const reader = createClineSessionReader(dir.path);
    expect(reader.hasSessionStorage()).toBe(true);
  });

  // ── listSessions ─────────────────────────────────────────────────

  test("listSessions returns empty array when tasks dir is missing", async () => {
    dir = await createTestDir("am-cline-session-");
    await mkdir(stableGlobalStorageDir(dir.path), { recursive: true });
    const reader = createClineSessionReader(dir.path);
    expect(await reader.listSessions()).toHaveLength(0);
  });

  test("listSessions discovers tasks across variants and sorts newest first", async () => {
    dir = await createTestDir("am-cline-session-");

    const oldTs = Date.parse("2026-04-01T10:00:00Z");
    const newTs = Date.parse("2026-04-08T12:00:00Z");

    await seedTask(dir.path, {
      taskId: String(oldTs),
      apiHistory: [
        { role: "user", content: "old hello" },
        { role: "assistant", content: "old hi" },
      ],
      uiMessages: [{ ts: oldTs }, { ts: oldTs + 5_000 }],
    });

    await seedTask(dir.path, {
      taskId: String(newTs),
      globalStorageDir: insidersGlobalStorageDir(dir.path),
      apiHistory: [{ role: "user", content: "new hello" }],
      uiMessages: [{ ts: newTs }],
    });

    const reader = createClineSessionReader(dir.path);
    const sessions = await reader.listSessions();

    expect(sessions).toHaveLength(2);
    expect(sessions[0].id).toBe(String(newTs));
    expect(sessions[0].adapter).toBe("cline");
    expect(sessions[0].messageCount).toBe(1);
    expect(sessions[1].id).toBe(String(oldTs));
    expect(sessions[1].messageCount).toBe(2);
    expect(sessions[1].estimatedTokens).toBeGreaterThan(0);
    expect(sessions[1].startedAt).toEqual(new Date(oldTs));
    expect(sessions[1].endedAt).toEqual(new Date(oldTs + 5_000));
  });

  test("listSessions filters by project (task_metadata.cwd)", async () => {
    dir = await createTestDir("am-cline-session-");

    await seedTask(dir.path, {
      taskId: "1700000001000",
      apiHistory: [{ role: "user", content: "match" }],
      metadata: { cwd: "/home/user/match-proj" },
    });
    await seedTask(dir.path, {
      taskId: "1700000002000",
      apiHistory: [{ role: "user", content: "miss" }],
      metadata: { cwd: "/home/user/other-proj" },
    });
    await seedTask(dir.path, {
      taskId: "1700000003000",
      apiHistory: [{ role: "user", content: "no project" }],
    });

    const reader = createClineSessionReader(dir.path);
    const sessions = await reader.listSessions("/home/user/match-proj");

    expect(sessions).toHaveLength(1);
    expect(sessions[0].id).toBe("1700000001000");
    expect(sessions[0].project).toBe("/home/user/match-proj");
  });

  // ── loadSession ──────────────────────────────────────────────────

  test("loadSession returns null for unknown id", async () => {
    dir = await createTestDir("am-cline-session-");
    await mkdir(stableGlobalStorageDir(dir.path), { recursive: true });
    const reader = createClineSessionReader(dir.path);
    expect(await reader.loadSession("1700000000000")).toBeNull();
  });

  test("loadSession rejects path traversal payloads", async () => {
    dir = await createTestDir("am-cline-session-");
    await mkdir(stableGlobalStorageDir(dir.path), { recursive: true });
    const reader = createClineSessionReader(dir.path);

    expect(await reader.loadSession("..")).toBeNull();
    expect(await reader.loadSession("../etc/passwd")).toBeNull();
    expect(await reader.loadSession("foo/bar")).toBeNull();
    expect(await reader.loadSession("foo\\bar")).toBeNull();
    expect(await reader.loadSession("foo\0bar")).toBeNull();
    expect(await reader.loadSession("a:b")).toBeNull();
    expect(await reader.loadSession("")).toBeNull();
  });

  test("loadSession parses Anthropic-style content blocks with text + tool_use + tool_result", async () => {
    dir = await createTestDir("am-cline-session-");

    const taskId = "1700000010000";
    const startedTs = Date.parse("2026-04-08T10:00:00Z");
    const endedTs = Date.parse("2026-04-08T10:05:00Z");

    await seedTask(dir.path, {
      taskId,
      apiHistory: [
        { role: "user", content: "Find the bug" },
        {
          role: "assistant",
          content: [
            { type: "text", text: "Looking at " },
            { type: "text", text: "auth.ts" },
            {
              type: "tool_use",
              id: "tu_1",
              name: "read_file",
              input: { path: "src/auth.ts" },
            },
          ],
        },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "tu_1",
              content: "file contents",
            },
          ],
        },
      ],
      uiMessages: [{ ts: startedTs }, { ts: endedTs }],
      metadata: { cwd: "/home/user/proj", title: "Bug fix" },
    });

    const reader = createClineSessionReader(dir.path);
    const session = await reader.loadSession(taskId);

    expect(session).not.toBeNull();
    expect(session?.id).toBe(taskId);
    expect(session?.adapter).toBe("cline");
    expect(session?.project).toBe("/home/user/proj");
    expect(session?.startedAt).toEqual(new Date(startedTs));
    expect(session?.endedAt).toEqual(new Date(endedTs));
    expect(session?.metadata?.taskId).toBe(taskId);
    expect(session?.metadata?.title).toBe("Bug fix");
    expect(typeof session?.metadata?.storageDir).toBe("string");

    // First message is the user "Find the bug" turn.
    expect(session?.messages[0]).toEqual({
      role: "user",
      content: "Find the bug",
    });

    // Second message is the assistant turn with concatenated text and one
    // tool_use whose output got attached from the matched tool_result.
    const assistant = session?.messages[1];
    expect(assistant?.role).toBe("assistant");
    expect(assistant?.content).toBe("Looking at auth.ts");
    expect(assistant?.toolCalls).toHaveLength(1);
    expect(assistant?.toolCalls?.[0]).toEqual({
      name: "read_file",
      input: { path: "src/auth.ts" },
      output: "file contents",
    });

    // The tool_result-only user turn produces no separate message — it was
    // consumed by the tool_use pairing.
    expect(session?.messages.length).toBe(2);
  });

  test("loadSession surfaces orphan tool_result as a tool-role message", async () => {
    dir = await createTestDir("am-cline-session-");

    await seedTask(dir.path, {
      taskId: "1700000011000",
      apiHistory: [
        { role: "user", content: "go" },
        {
          role: "user",
          content: [
            {
              // No tool_use_id → orphan; surfaced as standalone tool message.
              type: "tool_result",
              content: [{ type: "text", text: "orphan output" }],
            },
          ],
        },
      ],
    });

    const reader = createClineSessionReader(dir.path);
    const session = await reader.loadSession("1700000011000");
    expect(session).not.toBeNull();
    const tool = session?.messages.find((m) => m.role === "tool");
    expect(tool?.content).toBe("orphan output");
  });

  test("loadSession assigns 'unknown' tool name when name is missing", async () => {
    dir = await createTestDir("am-cline-session-");

    await seedTask(dir.path, {
      taskId: "1700000012000",
      apiHistory: [
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "x", input: { foo: 1 } }],
        },
      ],
    });

    const reader = createClineSessionReader(dir.path);
    const session = await reader.loadSession("1700000012000");
    expect(session?.messages[0].toolCalls?.[0].name).toBe("unknown");
  });

  // ── Defensive parsing ────────────────────────────────────────────

  test("listSessions skips tasks missing api_conversation_history.json", async () => {
    dir = await createTestDir("am-cline-session-");

    const taskDirNoApi = join(stableGlobalStorageDir(dir.path), "tasks", "1700000020000");
    await mkdir(taskDirNoApi, { recursive: true });
    await Bun.write(
      join(taskDirNoApi, "ui_messages.json"),
      JSON.stringify([{ ts: 1700000020000 }]),
    );

    await seedTask(dir.path, {
      taskId: "1700000021000",
      apiHistory: [{ role: "user", content: "ok" }],
    });

    const reader = createClineSessionReader(dir.path);
    const sessions = await reader.listSessions();
    expect(sessions).toHaveLength(1);
    expect(sessions[0].id).toBe("1700000021000");
  });

  test("listSessions skips tasks with malformed api_conversation_history.json", async () => {
    dir = await createTestDir("am-cline-session-");

    await seedTask(dir.path, {
      taskId: "1700000030000",
      rawApiHistory: "{not valid json",
    });
    await seedTask(dir.path, {
      taskId: "1700000031000",
      apiHistory: [{ role: "user", content: "still works" }],
    });

    const reader = createClineSessionReader(dir.path);
    const sessions = await reader.listSessions();
    expect(sessions).toHaveLength(1);
    expect(sessions[0].id).toBe("1700000031000");
  });

  test("listSessions skips tasks whose conversation produces zero messages", async () => {
    dir = await createTestDir("am-cline-session-");

    await seedTask(dir.path, {
      taskId: "1700000040000",
      apiHistory: [
        // Both turns have empty content → no messages produced.
        { role: "user", content: "" },
        { role: "assistant", content: [] },
      ],
    });
    await seedTask(dir.path, {
      taskId: "1700000041000",
      apiHistory: [{ role: "user", content: "real" }],
    });

    const reader = createClineSessionReader(dir.path);
    const sessions = await reader.listSessions();
    expect(sessions).toHaveLength(1);
    expect(sessions[0].id).toBe("1700000041000");
  });

  test("listSessions skips entries with unsafe ids in tasks dir", async () => {
    dir = await createTestDir("am-cline-session-");

    // Manually create a directory with a path-traversal-ish name and a valid
    // payload — the reader should skip it before reading.
    const tasksRoot = join(stableGlobalStorageDir(dir.path), "tasks");
    await mkdir(join(tasksRoot, "..safe"), { recursive: true });
    await Bun.write(
      join(tasksRoot, "..safe", "api_conversation_history.json"),
      JSON.stringify([{ role: "user", content: "should be skipped" }]),
    );

    await seedTask(dir.path, {
      taskId: "1700000050000",
      apiHistory: [{ role: "user", content: "ok" }],
    });

    const reader = createClineSessionReader(dir.path);
    const sessions = await reader.listSessions();
    expect(sessions).toHaveLength(1);
    expect(sessions[0].id).toBe("1700000050000");
  });

  test("falls back to numeric taskId for startedAt when ui_messages.json is missing", async () => {
    dir = await createTestDir("am-cline-session-");

    const taskId = "1700000060000";
    await seedTask(dir.path, {
      taskId,
      apiHistory: [{ role: "user", content: "no ui events" }],
    });

    const reader = createClineSessionReader(dir.path);
    const sessions = await reader.listSessions();
    expect(sessions).toHaveLength(1);
    expect(sessions[0].startedAt).toEqual(new Date(Number(taskId)));
  });
});
