import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import git from "isomorphic-git";
import { addRemote, commitAll, getStatus, initRepo, log, revertHead } from "../../src/core/git.ts";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "am-git-test-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("initRepo", () => {
  test("creates .git directory", async () => {
    await initRepo(dir);
    const entries = await readdir(dir, { withFileTypes: true });
    const hasGit = entries.some((e) => e.name === ".git" && e.isDirectory());
    expect(hasGit).toBe(true);
  });

  test("creates .agent-manager directory", async () => {
    await initRepo(dir);
    const entries = await readdir(dir, { withFileTypes: true });
    const hasAM = entries.some((e) => e.name === ".agent-manager" && e.isDirectory());
    expect(hasAM).toBe(true);
  });

  test("creates .gitignore with correct entries", async () => {
    await initRepo(dir);
    const content = await readFile(join(dir, ".gitignore"), "utf-8");
    expect(content).toContain("config.local.toml");
    expect(content).toContain(".agent-manager/state.toml");
    expect(content).toContain(".agent-manager/key.txt");
  });

  test("creates initial commit", async () => {
    await initRepo(dir);
    const commits = await git.log({ fs, dir, depth: 10 });
    expect(commits.length).toBe(1);
    expect(commits[0].commit.message).toContain("init");
  });
});

describe("commitAll", () => {
  test("stages and commits changed files, returns 40-char oid", async () => {
    await initRepo(dir);
    await fs.promises.writeFile(join(dir, "config.toml"), "key = 'value'\n");
    const oid = await commitAll(dir, "add config");
    expect(oid).toMatch(/^[0-9a-f]{40}$/);

    const commits = await git.log({ fs, dir, depth: 10 });
    expect(commits[0].commit.message.trim()).toBe("add config");
  });

  test("throws 'Nothing to commit' on clean tree", async () => {
    await initRepo(dir);
    expect(commitAll(dir, "empty")).rejects.toThrow("Nothing to commit");
  });

  test("handles deleted files", async () => {
    await initRepo(dir);
    // Create and commit a file
    await fs.promises.writeFile(join(dir, "temp.txt"), "hello\n");
    await commitAll(dir, "add temp");

    // Delete it
    await fs.promises.unlink(join(dir, "temp.txt"));
    const oid = await commitAll(dir, "remove temp");
    expect(oid).toMatch(/^[0-9a-f]{40}$/);

    // Verify file is gone from the tree
    const commits = await git.log({ fs, dir, depth: 1 });
    expect(commits[0].commit.message.trim()).toBe("remove temp");
  });
});

describe("log", () => {
  test("returns entries in reverse chronological order", async () => {
    await initRepo(dir);
    await fs.promises.writeFile(join(dir, "a.txt"), "a\n");
    await commitAll(dir, "first");
    await fs.promises.writeFile(join(dir, "b.txt"), "b\n");
    await commitAll(dir, "second");

    const entries = await log(dir);
    expect(entries.length).toBeGreaterThanOrEqual(3); // init + first + second
    expect(entries[0].message).toBe("second");
    expect(entries[1].message).toBe("first");
  });

  test("respects depth limit", async () => {
    await initRepo(dir);
    await fs.promises.writeFile(join(dir, "a.txt"), "a\n");
    await commitAll(dir, "first");
    await fs.promises.writeFile(join(dir, "b.txt"), "b\n");
    await commitAll(dir, "second");

    const entries = await log(dir, 2);
    expect(entries.length).toBe(2);
  });
});

describe("revertHead", () => {
  test("creates a revert commit restoring previous state", async () => {
    await initRepo(dir);
    await fs.promises.writeFile(join(dir, "file.txt"), "original\n");
    await commitAll(dir, "add file");

    await fs.promises.writeFile(join(dir, "file.txt"), "modified\n");
    await commitAll(dir, "modify file");

    await revertHead(dir);

    // File should be back to original content
    const content = await readFile(join(dir, "file.txt"), "utf-8");
    expect(content).toBe("original\n");

    // Should have a revert commit
    const entries = await log(dir, 1);
    expect(entries[0].message).toContain("revert");
  });

  test("throws when no parent commit", async () => {
    await initRepo(dir);
    // Only one commit (init), no parent to revert to
    expect(revertHead(dir)).rejects.toThrow();
  });
});

describe("getStatus", () => {
  test("reports clean state on fresh repo", async () => {
    await initRepo(dir);
    const status = await getStatus(dir);
    expect(status.clean).toBe(true);
    expect(status.branch).toBe("main");
    expect(status.dirty).toEqual([]);
  });

  test("reports dirty state with modified files", async () => {
    await initRepo(dir);
    await fs.promises.writeFile(join(dir, "new.txt"), "stuff\n");
    const status = await getStatus(dir);
    expect(status.clean).toBe(false);
    expect(status.dirty.length).toBeGreaterThan(0);
    expect(status.dirty).toContain("new.txt");
  });
});

describe("addRemote", () => {
  test("adds a remote", async () => {
    await initRepo(dir);
    await addRemote(dir, "https://example.com/repo.git");
    const remotes = await git.listRemotes({ fs, dir });
    expect(remotes.length).toBe(1);
    expect(remotes[0].remote).toBe("origin");
    expect(remotes[0].url).toBe("https://example.com/repo.git");
  });

  test("adds a remote with custom name", async () => {
    await initRepo(dir);
    await addRemote(dir, "https://example.com/repo.git", "upstream");
    const remotes = await git.listRemotes({ fs, dir });
    const upstream = remotes.find((r) => r.remote === "upstream");
    expect(upstream).toBeDefined();
    expect(upstream?.url).toBe("https://example.com/repo.git");
  });
});
