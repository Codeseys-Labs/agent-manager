import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { createCursorSessionReader } from "@/adapters/cursor/session.ts";
import { type TestDir, createTestDir } from "../../helpers/tmp.ts";

/** Resolve the Cursor User dir relative to a fake home, matching the reader. */
function userDirFor(home: string): string {
  if (process.platform === "darwin") {
    return join(home, "Library/Application Support/Cursor/User");
  }
  if (process.platform === "win32") {
    return join(home, "AppData/Roaming/Cursor/User");
  }
  return join(home, ".config/Cursor/User");
}

interface WorkspaceSeed {
  hash: string;
  /** workspace.json `folder` value (file:// URI). Omit to skip workspace.json. */
  folder?: string;
  /** chatdata blob (object). Omit to skip insert (simulates missing key). */
  chatdata?: unknown;
  /** Skip creating state.vscdb entirely. */
  skipDb?: boolean;
  /** Insert raw (non-JSON) string for chatdata to simulate corruption. */
  rawChatdata?: string;
}

async function seedWorkspace(home: string, ws: WorkspaceSeed): Promise<string> {
  const userDir = userDirFor(home);
  const wsDir = join(userDir, "workspaceStorage", ws.hash);
  await mkdir(wsDir, { recursive: true });

  if (ws.folder !== undefined) {
    await Bun.write(join(wsDir, "workspace.json"), JSON.stringify({ folder: ws.folder }));
  }

  if (ws.skipDb) return wsDir;

  const dbPath = join(wsDir, "state.vscdb");
  const db = new Database(dbPath);
  try {
    db.run("CREATE TABLE IF NOT EXISTS ItemTable (key TEXT PRIMARY KEY, value BLOB)");
    if (ws.rawChatdata !== undefined) {
      db.run(
        "INSERT INTO ItemTable (key, value) VALUES (?, ?)",
        "workbench.panel.aichat.view.aichat.chatdata",
        ws.rawChatdata,
      );
    } else if (ws.chatdata !== undefined) {
      db.run(
        "INSERT INTO ItemTable (key, value) VALUES (?, ?)",
        "workbench.panel.aichat.view.aichat.chatdata",
        JSON.stringify(ws.chatdata),
      );
    }
  } finally {
    db.close();
  }
  return wsDir;
}

describe("Cursor session reader", () => {
  let dir: TestDir;

  afterEach(async () => {
    if (dir) await dir.cleanup();
  });

  // ── hasSessionStorage ────────────────────────────────────────────

  test("hasSessionStorage returns false when User dir absent", async () => {
    dir = await createTestDir("am-cursor-session-");
    const reader = createCursorSessionReader(dir.path);
    expect(reader.hasSessionStorage()).toBe(false);
  });

  test("hasSessionStorage returns true when workspaceStorage exists", async () => {
    dir = await createTestDir("am-cursor-session-");
    await mkdir(join(userDirFor(dir.path), "workspaceStorage"), {
      recursive: true,
    });
    const reader = createCursorSessionReader(dir.path);
    expect(reader.hasSessionStorage()).toBe(true);
  });

  // ── listSessions ─────────────────────────────────────────────────

  test("listSessions returns empty array when no workspaces", async () => {
    dir = await createTestDir("am-cursor-session-");
    await mkdir(join(userDirFor(dir.path), "workspaceStorage"), {
      recursive: true,
    });
    const reader = createCursorSessionReader(dir.path);
    expect(await reader.listSessions()).toHaveLength(0);
  });

  test("listSessions discovers sessions across multiple workspaces and sorts newest first", async () => {
    dir = await createTestDir("am-cursor-session-");

    await seedWorkspace(dir.path, {
      hash: "ws-old",
      folder: "file:///home/user/old-proj",
      chatdata: {
        tabs: [
          {
            tabId: "tab-old",
            chatTitle: "Old chat",
            createdAt: Date.parse("2026-04-01T10:00:00Z"),
            lastSendTime: Date.parse("2026-04-01T10:05:00Z"),
            bubbles: [
              { type: "user", text: "old hello" },
              { type: "ai", text: "old hi" },
            ],
          },
        ],
      },
    });

    await seedWorkspace(dir.path, {
      hash: "ws-new",
      folder: "file:///home/user/new-proj",
      chatdata: {
        tabs: [
          {
            tabId: "tab-new",
            createdAt: Date.parse("2026-04-08T12:00:00Z"),
            bubbles: [{ type: "user", text: "new hello" }],
          },
        ],
      },
    });

    const reader = createCursorSessionReader(dir.path);
    const sessions = await reader.listSessions();

    expect(sessions).toHaveLength(2);
    expect(sessions[0].id).toBe("ws-new:tab-new");
    expect(sessions[0].adapter).toBe("cursor");
    expect(sessions[0].project).toBe("/home/user/new-proj");
    expect(sessions[1].id).toBe("ws-old:tab-old");
    expect(sessions[1].project).toBe("/home/user/old-proj");
    expect(sessions[1].messageCount).toBe(2);
    expect(sessions[1].estimatedTokens).toBeGreaterThan(0);
  });

  test("listSessions filters by project (workspace.json folder)", async () => {
    dir = await createTestDir("am-cursor-session-");

    await seedWorkspace(dir.path, {
      hash: "ws-a",
      folder: "file:///home/user/match-proj",
      chatdata: {
        tabs: [
          {
            tabId: "t1",
            createdAt: Date.parse("2026-04-08T10:00:00Z"),
            bubbles: [{ type: "user", text: "yes" }],
          },
        ],
      },
    });

    await seedWorkspace(dir.path, {
      hash: "ws-b",
      folder: "file:///home/user/other-proj",
      chatdata: {
        tabs: [
          {
            tabId: "t2",
            createdAt: Date.parse("2026-04-08T11:00:00Z"),
            bubbles: [{ type: "user", text: "no" }],
          },
        ],
      },
    });

    const reader = createCursorSessionReader(dir.path);
    const sessions = await reader.listSessions("/home/user/match-proj");

    expect(sessions).toHaveLength(1);
    expect(sessions[0].id).toBe("ws-a:t1");
  });

  // ── loadSession ──────────────────────────────────────────────────

  test("loadSession returns null for unknown id", async () => {
    dir = await createTestDir("am-cursor-session-");
    await mkdir(join(userDirFor(dir.path), "workspaceStorage"), {
      recursive: true,
    });
    const reader = createCursorSessionReader(dir.path);
    expect(await reader.loadSession("nope:nope")).toBeNull();
  });

  test("loadSession rejects path traversal payloads", async () => {
    dir = await createTestDir("am-cursor-session-");
    await mkdir(join(userDirFor(dir.path), "workspaceStorage"), {
      recursive: true,
    });
    const reader = createCursorSessionReader(dir.path);

    expect(await reader.loadSession("..:tab")).toBeNull();
    expect(await reader.loadSession("hash:..")).toBeNull();
    expect(await reader.loadSession("../etc:passwd")).toBeNull();
    expect(await reader.loadSession("foo\0bar:tab")).toBeNull();
    expect(await reader.loadSession("hash:tab\0")).toBeNull();
    expect(await reader.loadSession("foo/bar:tab")).toBeNull();
    expect(await reader.loadSession("hash:tab/x")).toBeNull();
    expect(await reader.loadSession("foo\\bar:tab")).toBeNull();
    // Missing colon separator entirely
    expect(await reader.loadSession("nocolon")).toBeNull();
    // Multiple colons
    expect(await reader.loadSession("a:b:c")).toBeNull();
    // Empty halves
    expect(await reader.loadSession(":tab")).toBeNull();
    expect(await reader.loadSession("hash:")).toBeNull();
  });

  test("loadSession parses a full session with timestamps and project", async () => {
    dir = await createTestDir("am-cursor-session-");

    const created = Date.parse("2026-04-08T10:00:00Z");
    const last = Date.parse("2026-04-08T10:05:00Z");

    await seedWorkspace(dir.path, {
      hash: "ws1",
      folder: "file:///home/user/proj",
      chatdata: {
        tabs: [
          {
            tabId: "tabA",
            chatTitle: "Bug fix",
            createdAt: created,
            lastSendTime: last,
            bubbles: [
              {
                type: "user",
                text: "Find the bug",
                timestamp: Date.parse("2026-04-08T10:00:01Z"),
              },
              {
                type: "ai",
                text: "Looking at auth.ts",
                timestamp: Date.parse("2026-04-08T10:00:02Z"),
              },
            ],
          },
        ],
      },
    });

    const reader = createCursorSessionReader(dir.path);
    const session = await reader.loadSession("ws1:tabA");

    expect(session).not.toBeNull();
    expect(session?.id).toBe("ws1:tabA");
    expect(session?.adapter).toBe("cursor");
    expect(session?.project).toBe("/home/user/proj");
    expect(session?.startedAt).toEqual(new Date(created));
    expect(session?.endedAt).toEqual(new Date(last));
    expect(session?.metadata?.title).toBe("Bug fix");
    expect(session?.metadata?.workspaceHash).toBe("ws1");
    expect(session?.messages).toHaveLength(2);
    expect(session?.messages[0].role).toBe("user");
    expect(session?.messages[0].content).toBe("Find the bug");
    expect(session?.messages[1].role).toBe("assistant");
    expect(session?.messages[1].content).toBe("Looking at auth.ts");
  });

  test("loadSession maps tool calls into Message.toolCalls", async () => {
    dir = await createTestDir("am-cursor-session-");

    await seedWorkspace(dir.path, {
      hash: "wsT",
      folder: "file:///home/user/proj",
      chatdata: {
        tabs: [
          {
            tabId: "tabT",
            createdAt: Date.parse("2026-04-08T10:00:00Z"),
            bubbles: [
              {
                type: "ai",
                text: "Running tools",
                toolCalls: [
                  {
                    name: "read_file",
                    input: { path: "src/x.ts" },
                    output: "contents",
                  },
                  {
                    name: "write_file",
                    arguments: '{"path":"src/y.ts","content":"x"}',
                  },
                ],
              },
            ],
          },
        ],
      },
    });

    const reader = createCursorSessionReader(dir.path);
    const session = await reader.loadSession("wsT:tabT");

    expect(session?.messages).toHaveLength(1);
    const msg = session?.messages[0];
    expect(msg?.role).toBe("assistant");
    expect(msg?.toolCalls).toHaveLength(2);
    expect(msg?.toolCalls?.[0]).toEqual({
      name: "read_file",
      input: { path: "src/x.ts" },
      output: "contents",
    });
    expect(msg?.toolCalls?.[1].name).toBe("write_file");
    expect(msg?.toolCalls?.[1].input).toEqual({
      path: "src/y.ts",
      content: "x",
    });
  });

  // ── Defensive parsing ────────────────────────────────────────────

  test("skips tabs missing bubbles entirely", async () => {
    dir = await createTestDir("am-cursor-session-");

    await seedWorkspace(dir.path, {
      hash: "wsEmpty",
      folder: "file:///home/user/proj",
      chatdata: {
        tabs: [
          { tabId: "no-bubbles", createdAt: 1234 },
          {
            tabId: "has-bubbles",
            createdAt: Date.parse("2026-04-08T10:00:00Z"),
            bubbles: [{ type: "user", text: "hi" }],
          },
        ],
      },
    });

    const reader = createCursorSessionReader(dir.path);
    const sessions = await reader.listSessions();
    expect(sessions).toHaveLength(1);
    expect(sessions[0].id).toBe("wsEmpty:has-bubbles");
  });

  test("skips workspace whose chatdata blob is unparseable JSON", async () => {
    dir = await createTestDir("am-cursor-session-");

    await seedWorkspace(dir.path, {
      hash: "wsBad",
      folder: "file:///home/user/bad",
      rawChatdata: "{not valid json",
    });

    await seedWorkspace(dir.path, {
      hash: "wsGood",
      folder: "file:///home/user/good",
      chatdata: {
        tabs: [
          {
            tabId: "g1",
            createdAt: Date.parse("2026-04-08T10:00:00Z"),
            bubbles: [{ type: "user", text: "still works" }],
          },
        ],
      },
    });

    const reader = createCursorSessionReader(dir.path);
    const sessions = await reader.listSessions();
    expect(sessions).toHaveLength(1);
    expect(sessions[0].id).toBe("wsGood:g1");
  });

  test("skips workspace dir lacking state.vscdb but lists others", async () => {
    dir = await createTestDir("am-cursor-session-");

    await seedWorkspace(dir.path, {
      hash: "wsNoDb",
      folder: "file:///home/user/empty",
      skipDb: true,
    });

    await seedWorkspace(dir.path, {
      hash: "wsHasDb",
      folder: "file:///home/user/full",
      chatdata: {
        tabs: [
          {
            tabId: "h1",
            createdAt: Date.parse("2026-04-08T10:00:00Z"),
            bubbles: [{ type: "user", text: "hi" }],
          },
        ],
      },
    });

    const reader = createCursorSessionReader(dir.path);
    const sessions = await reader.listSessions();
    expect(sessions).toHaveLength(1);
    expect(sessions[0].id).toBe("wsHasDb:h1");
  });

  test("supports older `aiService.prompts` key when chatdata absent", async () => {
    dir = await createTestDir("am-cursor-session-");

    const userDir = userDirFor(dir.path);
    const wsDir = join(userDir, "workspaceStorage", "wsLegacy");
    await mkdir(wsDir, { recursive: true });
    await Bun.write(
      join(wsDir, "workspace.json"),
      JSON.stringify({ folder: "file:///home/user/legacy" }),
    );

    const dbPath = join(wsDir, "state.vscdb");
    const db = new Database(dbPath);
    try {
      db.run("CREATE TABLE IF NOT EXISTS ItemTable (key TEXT PRIMARY KEY, value BLOB)");
      db.run(
        "INSERT INTO ItemTable (key, value) VALUES (?, ?)",
        "aiService.prompts",
        JSON.stringify({
          tabs: [
            {
              tabId: "legacy-tab",
              createdAt: Date.parse("2026-04-01T08:00:00Z"),
              bubbles: [{ type: "user", text: "legacy hello" }],
            },
          ],
        }),
      );
    } finally {
      db.close();
    }

    const reader = createCursorSessionReader(dir.path);
    const sessions = await reader.listSessions();

    expect(sessions).toHaveLength(1);
    expect(sessions[0].id).toBe("wsLegacy:legacy-tab");
    expect(sessions[0].project).toBe("/home/user/legacy");
  });

  test("session without workspace.json still loads, project is undefined", async () => {
    dir = await createTestDir("am-cursor-session-");

    await seedWorkspace(dir.path, {
      hash: "wsAnon",
      // no folder
      chatdata: {
        tabs: [
          {
            tabId: "anon",
            createdAt: Date.parse("2026-04-08T10:00:00Z"),
            bubbles: [{ type: "user", text: "no project" }],
          },
        ],
      },
    });

    const reader = createCursorSessionReader(dir.path);
    const sessions = await reader.listSessions();
    expect(sessions).toHaveLength(1);
    expect(sessions[0].project).toBeUndefined();

    const loaded = await reader.loadSession("wsAnon:anon");
    expect(loaded).not.toBeNull();
    expect(loaded?.project).toBeUndefined();
  });
});
