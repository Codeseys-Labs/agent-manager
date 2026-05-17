import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { createCopilotSessionReader } from "@/adapters/copilot/session.ts";
import { resolveVSCodeExtensionStorage } from "@/adapters/shared/vscode-paths.ts";
import { type TestDir, createTestDir } from "../../helpers/tmp.ts";

/**
 * Resolve the platform-appropriate globalStorage dir under a test home, using
 * the same helper production code uses. We pick the FIRST candidate (stable
 * VS Code, first ID casing) so the fixture lives where the reader will look
 * first. Returned as a path relative to the test dir so we can use TestDir.write.
 */
function copilotStorageRelative(testHome: string): string {
  const candidates = resolveVSCodeExtensionStorage(
    ["GitHub.copilot-chat", "github.copilot-chat"],
    testHome,
  );
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

describe("Copilot Chat session reader", () => {
  let dir: TestDir;

  afterEach(async () => {
    if (dir) await dir.cleanup();
  });

  // ── hasSessionStorage ──────────────────────────────────────────

  test("hasSessionStorage returns false when no globalStorage dir exists", async () => {
    dir = await createTestDir("am-copilot-session-");
    const reader = createCopilotSessionReader(dir.path);
    expect(reader.hasSessionStorage()).toBe(false);
  });

  test("hasSessionStorage returns true when extension globalStorage dir exists", async () => {
    dir = await createTestDir("am-copilot-session-");
    const storage = copilotStorageRelative(dir.path);
    await dir.write(join(storage, ".keep"), "");
    const reader = createCopilotSessionReader(dir.path);
    expect(reader.hasSessionStorage()).toBe(true);
  });

  test("hasSessionStorage finds storage under custom extensionIds opt", async () => {
    dir = await createTestDir("am-copilot-session-");
    const candidates = resolveVSCodeExtensionStorage(["custom.copilot-chat"], dir.path);
    const rel = relative(dir.path, candidates[0]);
    await dir.write(join(rel, ".keep"), "");
    const reader = createCopilotSessionReader(dir.path, {
      extensionIds: ["custom.copilot-chat"],
    });
    expect(reader.hasSessionStorage()).toBe(true);
  });

  // ── listSessions ───────────────────────────────────────────────

  test("listSessions returns empty array when storage dir is empty", async () => {
    dir = await createTestDir("am-copilot-session-");
    const storage = copilotStorageRelative(dir.path);
    await dir.write(join(storage, ".keep"), "");
    const reader = createCopilotSessionReader(dir.path);
    const sessions = await reader.listSessions();
    expect(sessions).toHaveLength(0);
  });

  test("listSessions parses chat session JSON file", async () => {
    dir = await createTestDir("am-copilot-session-");
    const storage = copilotStorageRelative(dir.path);
    await writeJson(dir, join(storage, "sess-001.json"), {
      version: 3,
      sessionId: "sess-001",
      creationDate: 1715000000000,
      requesterUsername: "alice",
      requests: [
        {
          message: { text: "Hello" },
          response: [{ value: "Hi there!" }],
          timestamp: 1715000000123,
        },
      ],
    });

    const reader = createCopilotSessionReader(dir.path);
    const sessions = await reader.listSessions();

    expect(sessions).toHaveLength(1);
    expect(sessions[0].id).toBe("sess-001");
    expect(sessions[0].adapter).toBe("copilot");
    expect(sessions[0].messageCount).toBe(2);
    expect(sessions[0].startedAt).toEqual(new Date(1715000000000));
    expect(sessions[0].endedAt).toEqual(new Date(1715000000123));
    expect(sessions[0].estimatedTokens).toBeGreaterThan(0);
  });

  test("listSessions parses sessions nested under chatSessions/", async () => {
    dir = await createTestDir("am-copilot-session-");
    const storage = copilotStorageRelative(dir.path);
    await writeJson(dir, join(storage, "chatSessions", "nested.json"), {
      sessionId: "nested",
      creationDate: 1715000111000,
      requests: [{ message: "hi", response: "hello" }],
    });

    const reader = createCopilotSessionReader(dir.path);
    const sessions = await reader.listSessions();

    expect(sessions).toHaveLength(1);
    expect(sessions[0].id).toBe("nested");
  });

  test("listSessions sorts by startedAt descending and skips malformed/non-chat files", async () => {
    dir = await createTestDir("am-copilot-session-");
    const storage = copilotStorageRelative(dir.path);

    await writeJson(dir, join(storage, "old.json"), {
      sessionId: "old",
      creationDate: 1715000000000,
      requests: [{ message: "old", response: "ack" }],
    });
    await writeJson(dir, join(storage, "new.json"), {
      sessionId: "new",
      creationDate: 1716000000000,
      requests: [{ message: "new", response: "ack" }],
    });
    // Empty file
    await writeRaw(dir, join(storage, "empty.json"), "");
    // Malformed JSON
    await writeRaw(dir, join(storage, "bad.json"), "{not valid json");
    // Non-chat-session JSON (no requests array)
    await writeJson(dir, join(storage, "settings.json"), {
      sessionId: "config",
      configuration: { foo: "bar" },
    });
    // chatEditingSessions/ dir should be ignored
    await writeJson(dir, join(storage, "chatEditingSessions", "edit-1.json"), {
      sessionId: "edit-1",
      creationDate: 1717000000000,
      requests: [{ message: "edit", response: "ack" }],
    });
    // JSON array at top level — not a chat session object
    await writeRaw(dir, join(storage, "list.json"), "[1, 2, 3]");

    const reader = createCopilotSessionReader(dir.path);
    const sessions = await reader.listSessions();

    expect(sessions).toHaveLength(2);
    expect(sessions[0].id).toBe("new");
    expect(sessions[1].id).toBe("old");
  });

  test("listSessions filters by project when session has cwd metadata", async () => {
    dir = await createTestDir("am-copilot-session-");
    const storage = copilotStorageRelative(dir.path);

    await writeJson(dir, join(storage, "match.json"), {
      sessionId: "match",
      creationDate: 1715000000000,
      cwd: "/home/user/my-project",
      requests: [{ message: "hi", response: "ack" }],
    });
    await writeJson(dir, join(storage, "other.json"), {
      sessionId: "other",
      creationDate: 1715000000001,
      cwd: "/home/user/other-project",
      requests: [{ message: "hi", response: "ack" }],
    });
    await writeJson(dir, join(storage, "no-meta.json"), {
      sessionId: "no-meta",
      creationDate: 1715000000002,
      requests: [{ message: "hi", response: "ack" }],
    });

    const reader = createCopilotSessionReader(dir.path);
    const sessions = await reader.listSessions("/home/user/my-project");

    expect(sessions).toHaveLength(1);
    expect(sessions[0].id).toBe("match");
  });

  // ── loadSession ────────────────────────────────────────────────

  test("loadSession returns null for unknown id", async () => {
    dir = await createTestDir("am-copilot-session-");
    const storage = copilotStorageRelative(dir.path);
    await dir.write(join(storage, ".keep"), "");
    const reader = createCopilotSessionReader(dir.path);
    const session = await reader.loadSession("nonexistent");
    expect(session).toBeNull();
  });

  test("loadSession parses requests and responses into ordered user/assistant messages", async () => {
    dir = await createTestDir("am-copilot-session-");
    const storage = copilotStorageRelative(dir.path);
    await writeJson(dir, join(storage, "full.json"), {
      version: 3,
      sessionId: "full",
      creationDate: 1715000000000,
      lastMessageDate: 1715000005000,
      customTitle: "Refactor auth module",
      requesterUsername: "bob",
      cwd: "/home/user/proj",
      requests: [
        {
          message: { text: "Fix the bug in auth.ts" },
          response: [{ value: "I'll look at auth.ts." }],
          timestamp: 1715000001000,
        },
        {
          message: { text: "Now run the tests" },
          response: [{ value: "Done — all green." }],
          timestamp: 1715000005000,
        },
      ],
    });

    const reader = createCopilotSessionReader(dir.path);
    const session = await reader.loadSession("full");

    expect(session).not.toBeNull();
    expect(session?.id).toBe("full");
    expect(session?.adapter).toBe("copilot");
    expect(session?.project).toBe("/home/user/proj");
    expect(session?.messages).toHaveLength(4);
    expect(session?.messages[0].role).toBe("user");
    expect(session?.messages[0].content).toBe("Fix the bug in auth.ts");
    expect(session?.messages[1].role).toBe("assistant");
    expect(session?.messages[1].content).toBe("I'll look at auth.ts.");
    expect(session?.messages[2].role).toBe("user");
    expect(session?.messages[2].content).toBe("Now run the tests");
    expect(session?.messages[3].role).toBe("assistant");
    expect(session?.messages[3].content).toBe("Done — all green.");

    expect(session?.startedAt).toEqual(new Date(1715000000000));
    expect(session?.endedAt).toEqual(new Date(1715000005000));

    expect(session?.metadata?.customTitle).toBe("Refactor auth module");
    expect(session?.metadata?.requesterUsername).toBe("bob");
    expect(session?.metadata?.version).toBe(3);
    expect(typeof session?.metadata?.storageDir).toBe("string");
  });

  test("loadSession accepts id with .json suffix", async () => {
    dir = await createTestDir("am-copilot-session-");
    const storage = copilotStorageRelative(dir.path);
    await writeJson(dir, join(storage, "with-suffix.json"), {
      sessionId: "with-suffix",
      creationDate: 1715000000000,
      requests: [{ message: "hi", response: "ack" }],
    });

    const reader = createCopilotSessionReader(dir.path);
    const session = await reader.loadSession("with-suffix.json");
    expect(session).not.toBeNull();
    expect(session?.id).toBe("with-suffix");
  });

  test("loadSession rejects path traversal with ../", async () => {
    dir = await createTestDir("am-copilot-session-");
    const storage = copilotStorageRelative(dir.path);
    await dir.write(join(storage, ".keep"), "");
    const reader = createCopilotSessionReader(dir.path);
    expect(await reader.loadSession("../../etc/passwd")).toBeNull();
    expect(await reader.loadSession("..")).toBeNull();
  });

  test("loadSession rejects path traversal with slashes and null bytes", async () => {
    dir = await createTestDir("am-copilot-session-");
    const storage = copilotStorageRelative(dir.path);
    await dir.write(join(storage, ".keep"), "");
    const reader = createCopilotSessionReader(dir.path);
    expect(await reader.loadSession("foo/bar")).toBeNull();
    expect(await reader.loadSession("foo\\bar")).toBeNull();
    expect(await reader.loadSession("foo\0bar")).toBeNull();
  });

  test("loadSession handles alternative response shapes (string, {value}, {content:{value}})", async () => {
    dir = await createTestDir("am-copilot-session-");
    const storage = copilotStorageRelative(dir.path);
    await writeJson(dir, join(storage, "shapes.json"), {
      sessionId: "shapes",
      creationDate: 1715000000000,
      requests: [
        {
          message: "plain string request",
          response: "plain string response",
        },
        {
          message: { text: "nested text request" },
          response: [{ value: "value-shaped response" }],
        },
        {
          message: { parts: [{ text: "parts " }, { text: "joined" }] },
          response: [{ kind: "markdownContent", content: { value: "content.value response" } }],
        },
      ],
    });

    const reader = createCopilotSessionReader(dir.path);
    const session = await reader.loadSession("shapes");

    expect(session).not.toBeNull();
    expect(session?.messages).toHaveLength(6);
    expect(session?.messages[0].content).toBe("plain string request");
    expect(session?.messages[1].content).toBe("plain string response");
    expect(session?.messages[2].content).toBe("nested text request");
    expect(session?.messages[3].content).toBe("value-shaped response");
    expect(session?.messages[4].content).toBe("parts joined");
    expect(session?.messages[5].content).toBe("content.value response");
  });

  test("loadSession accepts alternative id field 'id'", async () => {
    dir = await createTestDir("am-copilot-session-");
    const storage = copilotStorageRelative(dir.path);
    await writeJson(dir, join(storage, "alt.json"), {
      id: "alt-id",
      creationDate: 1715000000000,
      requests: [{ message: "x", response: "y" }],
    });

    const reader = createCopilotSessionReader(dir.path);
    const session = await reader.loadSession("alt-id");
    expect(session).not.toBeNull();
    expect(session?.id).toBe("alt-id");
  });
});
