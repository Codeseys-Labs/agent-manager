import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { createRooCodeSessionReader } from "@/adapters/roo-code/session.ts";
import { resolveVSCodeExtensionStorage } from "@/adapters/shared/vscode-paths.ts";
import { type TestDir, createTestDir } from "../../helpers/tmp.ts";

/**
 * Resolve the platform-appropriate globalStorage dir under a test home, using
 * the same helper production code uses. We pick the FIRST candidate (stable
 * VS Code, mixed-case ID) so the fixture lives where the reader will look
 * first. Returned as a path relative to the test dir so we can use TestDir.write.
 */
function rooStorageRelative(
  testHome: string,
  ids: string[] = ["RooVeterinaryInc.roo-cline", "rooveterinaryinc.roo-cline"],
): string {
  const candidates = resolveVSCodeExtensionStorage(ids, testHome);
  return relative(testHome, candidates[0]);
}

async function writeJson(testDir: TestDir, relPath: string, value: unknown): Promise<void> {
  const full = join(testDir.path, relPath);
  await mkdir(dirname(full), { recursive: true });
  await writeFile(full, JSON.stringify(value), "utf-8");
}

async function writeRaw(testDir: TestDir, relPath: string, content: string): Promise<void> {
  const full = join(testDir.path, relPath);
  await mkdir(dirname(full), { recursive: true });
  await writeFile(full, content, "utf-8");
}

describe("Roo Code session reader", () => {
  let dir: TestDir;

  afterEach(async () => {
    if (dir) await dir.cleanup();
  });

  // ── hasSessionStorage ──────────────────────────────────────────

  test("hasSessionStorage returns false when no globalStorage exists", async () => {
    dir = await createTestDir("am-roo-session-");
    const reader = createRooCodeSessionReader(dir.path);
    expect(reader.hasSessionStorage()).toBe(false);
  });

  test("hasSessionStorage returns true when extension globalStorage exists (mixed case)", async () => {
    dir = await createTestDir("am-roo-session-");
    const storage = rooStorageRelative(dir.path, ["RooVeterinaryInc.roo-cline"]);
    await dir.write(join(storage, ".keep"), "");
    const reader = createRooCodeSessionReader(dir.path);
    expect(reader.hasSessionStorage()).toBe(true);
  });

  test("hasSessionStorage returns true when extension globalStorage exists (lowercase)", async () => {
    dir = await createTestDir("am-roo-session-");
    const storage = rooStorageRelative(dir.path, ["rooveterinaryinc.roo-cline"]);
    await dir.write(join(storage, ".keep"), "");
    const reader = createRooCodeSessionReader(dir.path);
    expect(reader.hasSessionStorage()).toBe(true);
  });

  test("hasSessionStorage honors custom extensionIds opt", async () => {
    dir = await createTestDir("am-roo-session-");
    const storage = rooStorageRelative(dir.path, ["custom.roo-fork"]);
    await dir.write(join(storage, ".keep"), "");
    const reader = createRooCodeSessionReader(dir.path, {
      extensionIds: ["custom.roo-fork"],
    });
    expect(reader.hasSessionStorage()).toBe(true);
  });

  // ── listSessions ───────────────────────────────────────────────

  test("listSessions returns empty when tasks/ is empty", async () => {
    dir = await createTestDir("am-roo-session-");
    const storage = rooStorageRelative(dir.path);
    await dir.write(join(storage, "tasks", ".keep"), "");
    const reader = createRooCodeSessionReader(dir.path);
    const sessions = await reader.listSessions();
    expect(sessions).toHaveLength(0);
  });

  test("listSessions returns empty when no tasks/ subdir exists", async () => {
    dir = await createTestDir("am-roo-session-");
    const storage = rooStorageRelative(dir.path);
    await dir.write(join(storage, "settings", "mcp_settings.json"), "{}");
    const reader = createRooCodeSessionReader(dir.path);
    const sessions = await reader.listSessions();
    expect(sessions).toHaveLength(0);
  });

  test("listSessions parses one task with api_conversation_history.json", async () => {
    dir = await createTestDir("am-roo-session-");
    const storage = rooStorageRelative(dir.path);
    await writeJson(dir, join(storage, "tasks", "task-001", "api_conversation_history.json"), [
      { role: "user", content: "Hello", ts: 1715000000000 },
      { role: "assistant", content: "Hi there!", ts: 1715000000123 },
    ]);

    const reader = createRooCodeSessionReader(dir.path);
    const sessions = await reader.listSessions();

    expect(sessions).toHaveLength(1);
    expect(sessions[0].id).toBe("task-001");
    expect(sessions[0].adapter).toBe("roo-code");
    expect(sessions[0].messageCount).toBe(2);
    expect(sessions[0].startedAt).toEqual(new Date(1715000000000));
    expect(sessions[0].endedAt).toEqual(new Date(1715000000123));
    expect(sessions[0].estimatedTokens).toBeGreaterThan(0);
  });

  test("listSessions falls back to ui_messages.json when api file is missing", async () => {
    dir = await createTestDir("am-roo-session-");
    const storage = rooStorageRelative(dir.path);
    await writeJson(dir, join(storage, "tasks", "task-ui", "ui_messages.json"), [
      { type: "say", text: "from ui side", ts: 1715000111000 },
      { type: "ask", text: "user question", ts: 1715000222000 },
    ]);

    const reader = createRooCodeSessionReader(dir.path);
    const sessions = await reader.listSessions();

    expect(sessions).toHaveLength(1);
    expect(sessions[0].id).toBe("task-ui");
    expect(sessions[0].messageCount).toBe(2);
  });

  test("listSessions skips malformed/empty/non-array files silently", async () => {
    dir = await createTestDir("am-roo-session-");
    const storage = rooStorageRelative(dir.path);

    // Good task
    await writeJson(dir, join(storage, "tasks", "good", "api_conversation_history.json"), [
      { role: "user", content: "ok", ts: 1715000000000 },
      { role: "assistant", content: "ack", ts: 1715000000100 },
    ]);
    // Truncated JSON
    await writeRaw(
      dir,
      join(storage, "tasks", "truncated", "api_conversation_history.json"),
      "[{not valid",
    );
    // Empty file
    await writeRaw(dir, join(storage, "tasks", "empty", "api_conversation_history.json"), "");
    // Object instead of array
    await writeRaw(
      dir,
      join(storage, "tasks", "object", "api_conversation_history.json"),
      '{"version":1}',
    );
    // Array but only primitives, no objects
    await writeRaw(
      dir,
      join(storage, "tasks", "primitives", "api_conversation_history.json"),
      "[1, 2, 3]",
    );
    // Both files missing
    await dir.write(join(storage, "tasks", "no-files", ".keep"), "");

    const reader = createRooCodeSessionReader(dir.path);
    const sessions = await reader.listSessions();

    expect(sessions).toHaveLength(1);
    expect(sessions[0].id).toBe("good");
  });

  test("listSessions sorts by startedAt descending", async () => {
    dir = await createTestDir("am-roo-session-");
    const storage = rooStorageRelative(dir.path);

    await writeJson(dir, join(storage, "tasks", "old", "api_conversation_history.json"), [
      { role: "user", content: "old", ts: 1715000000000 },
    ]);
    await writeJson(dir, join(storage, "tasks", "new", "api_conversation_history.json"), [
      { role: "user", content: "new", ts: 1716000000000 },
    ]);
    await writeJson(dir, join(storage, "tasks", "middle", "api_conversation_history.json"), [
      { role: "user", content: "mid", ts: 1715500000000 },
    ]);

    const reader = createRooCodeSessionReader(dir.path);
    const sessions = await reader.listSessions();

    expect(sessions.map((s) => s.id)).toEqual(["new", "middle", "old"]);
  });

  test("listSessions filters by project from record-level cwd", async () => {
    dir = await createTestDir("am-roo-session-");
    const storage = rooStorageRelative(dir.path);

    await writeJson(dir, join(storage, "tasks", "match", "api_conversation_history.json"), [
      { role: "user", content: "hi", ts: 1715000000000, cwd: "/home/user/my-project" },
      { role: "assistant", content: "ack", ts: 1715000000100 },
    ]);
    await writeJson(dir, join(storage, "tasks", "other", "api_conversation_history.json"), [
      { role: "user", content: "hi", ts: 1715000000001, cwd: "/home/user/other-project" },
    ]);
    await writeJson(dir, join(storage, "tasks", "no-meta", "api_conversation_history.json"), [
      { role: "user", content: "hi", ts: 1715000000002 },
    ]);

    const reader = createRooCodeSessionReader(dir.path);
    const sessions = await reader.listSessions("/home/user/my-project");

    expect(sessions).toHaveLength(1);
    expect(sessions[0].id).toBe("match");
    expect(sessions[0].project).toBe("/home/user/my-project");
  });

  test("listSessions filters by project from sibling task_metadata.json", async () => {
    dir = await createTestDir("am-roo-session-");
    const storage = rooStorageRelative(dir.path);

    await writeJson(dir, join(storage, "tasks", "meta", "api_conversation_history.json"), [
      { role: "user", content: "hi", ts: 1715000000000 },
    ]);
    await writeJson(dir, join(storage, "tasks", "meta", "task_metadata.json"), {
      cwd: "/home/user/proj",
    });

    const reader = createRooCodeSessionReader(dir.path);
    const sessions = await reader.listSessions("/home/user/proj");

    expect(sessions).toHaveLength(1);
    expect(sessions[0].project).toBe("/home/user/proj");
  });

  // ── loadSession ────────────────────────────────────────────────

  test("loadSession returns null for unknown id", async () => {
    dir = await createTestDir("am-roo-session-");
    const storage = rooStorageRelative(dir.path);
    await dir.write(join(storage, "tasks", ".keep"), "");
    const reader = createRooCodeSessionReader(dir.path);
    const session = await reader.loadSession("nonexistent");
    expect(session).toBeNull();
  });

  test("loadSession parses ordered user/assistant messages", async () => {
    dir = await createTestDir("am-roo-session-");
    const storage = rooStorageRelative(dir.path);

    await writeJson(dir, join(storage, "tasks", "full", "api_conversation_history.json"), [
      { role: "user", content: "Fix the bug", ts: 1715000001000 },
      { role: "assistant", content: "Looking at it.", ts: 1715000002000 },
      { role: "user", content: "Run tests.", ts: 1715000003000 },
      { role: "assistant", content: "All green.", ts: 1715000004000 },
    ]);

    const reader = createRooCodeSessionReader(dir.path);
    const session = await reader.loadSession("full");

    expect(session).not.toBeNull();
    expect(session?.id).toBe("full");
    expect(session?.adapter).toBe("roo-code");
    expect(session?.messages).toHaveLength(4);
    expect(session?.messages[0].role).toBe("user");
    expect(session?.messages[0].content).toBe("Fix the bug");
    expect(session?.messages[1].role).toBe("assistant");
    expect(session?.messages[1].content).toBe("Looking at it.");
    expect(session?.messages[2].role).toBe("user");
    expect(session?.messages[3].role).toBe("assistant");
    expect(session?.startedAt).toEqual(new Date(1715000001000));
    expect(session?.endedAt).toEqual(new Date(1715000004000));
  });

  test("loadSession populates metadata.storageDir", async () => {
    dir = await createTestDir("am-roo-session-");
    const storage = rooStorageRelative(dir.path);

    await writeJson(dir, join(storage, "tasks", "meta-test", "api_conversation_history.json"), [
      { role: "user", content: "x", ts: 1715000000000 },
    ]);

    const reader = createRooCodeSessionReader(dir.path);
    const session = await reader.loadSession("meta-test");

    expect(session).not.toBeNull();
    expect(typeof session?.metadata?.storageDir).toBe("string");
    expect((session?.metadata?.storageDir as string).endsWith("RooVeterinaryInc.roo-cline")).toBe(
      true,
    );
  });

  test("loadSession rejects path traversal: ..", async () => {
    dir = await createTestDir("am-roo-session-");
    const storage = rooStorageRelative(dir.path);
    await dir.write(join(storage, "tasks", ".keep"), "");
    const reader = createRooCodeSessionReader(dir.path);
    expect(await reader.loadSession("..")).toBeNull();
  });

  test("loadSession rejects path traversal: ../etc/passwd", async () => {
    dir = await createTestDir("am-roo-session-");
    const storage = rooStorageRelative(dir.path);
    await dir.write(join(storage, "tasks", ".keep"), "");
    const reader = createRooCodeSessionReader(dir.path);
    expect(await reader.loadSession("../../etc/passwd")).toBeNull();
  });

  test("loadSession rejects path traversal with slashes and null bytes", async () => {
    dir = await createTestDir("am-roo-session-");
    const storage = rooStorageRelative(dir.path);
    await dir.write(join(storage, "tasks", ".keep"), "");
    const reader = createRooCodeSessionReader(dir.path);
    expect(await reader.loadSession("foo/bar")).toBeNull();
    expect(await reader.loadSession("foo\\bar")).toBeNull();
    expect(await reader.loadSession("foo\0bar")).toBeNull();
  });

  test("loadSession returns null for empty id", async () => {
    dir = await createTestDir("am-roo-session-");
    const storage = rooStorageRelative(dir.path);
    await dir.write(join(storage, "tasks", ".keep"), "");
    const reader = createRooCodeSessionReader(dir.path);
    expect(await reader.loadSession("")).toBeNull();
  });

  test("loadSession handles alternative content shapes (string, {text}, [{text}], message.text)", async () => {
    dir = await createTestDir("am-roo-session-");
    const storage = rooStorageRelative(dir.path);

    await writeJson(dir, join(storage, "tasks", "shapes", "api_conversation_history.json"), [
      { role: "user", content: "plain string" },
      { role: "assistant", content: [{ text: "array " }, { text: "text" }] },
      { role: "user", message: { text: "nested message" } },
      { type: "say", content: "type field instead of role" },
    ]);

    const reader = createRooCodeSessionReader(dir.path);
    const session = await reader.loadSession("shapes");

    expect(session).not.toBeNull();
    expect(session?.messages).toHaveLength(4);
    expect(session?.messages[0].content).toBe("plain string");
    expect(session?.messages[1].content).toBe("array text");
    expect(session?.messages[2].content).toBe("nested message");
    expect(session?.messages[3].role).toBe("assistant");
    expect(session?.messages[3].content).toBe("type field instead of role");
  });
});
