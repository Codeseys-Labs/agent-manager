/**
 * M5.3-lite resolveConflicts tests (2026-05-03-E).
 *
 * Pins:
 *   - No sidecar → { resolvedFiles: [], sidecarCleared: false }
 *   - Sidecar present + keep-local for all files → commits, sidecar cleared
 *   - take-remote overwrites workdir with the remote blob (from
 *     refs/remotes/origin/<branch>)
 *   - edit delegates to io.openEditor then commits
 *   - skip leaves sidecar in place (non-destructive)
 *   - Mix of keep-local + skip: commits only the kept files; sidecar stays
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import git from "isomorphic-git";
import { commitAll, initRepo } from "../../src/core/git";
import type { ResolveChoice, ResolveIo } from "../../src/wiki/resolve";
import { resolveConflicts } from "../../src/wiki/resolve";
import { writeConflictSidecar } from "../../src/wiki/sync";

// Helper: make an IO that picks the same choice for every file + collects info lines.
function makeScriptedIo(choices: Record<string, ResolveChoice>): ResolveIo & {
  infoLines: string[];
  editorCalls: string[];
} {
  const infoLines: string[] = [];
  const editorCalls: string[] = [];
  return {
    async pickChoice(file) {
      const c = choices[file] ?? "skip";
      return c;
    },
    async openEditor(abs) {
      editorCalls.push(abs);
    },
    info(msg) {
      infoLines.push(msg);
    },
    infoLines,
    editorCalls,
  };
}

describe("resolveConflicts — M5.3-lite", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "am-wiki-resolve-"));
    await initRepo(dir);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("returns early when no sidecar present", async () => {
    const io = makeScriptedIo({});
    const res = await resolveConflicts(dir, io);
    expect(res.resolvedFiles).toEqual([]);
    expect(res.sidecarCleared).toBe(false);
  });

  test("keep-local for all files → commits resolution + clears sidecar", async () => {
    await writeFile(join(dir, "a.md"), "local A");
    await commitAll(dir, "baseline");
    await writeFile(join(dir, "a.md"), "local A — edited");

    await writeConflictSidecar(dir, {
      timestamp: "2026-05-03T00:00:00Z",
      remote: "origin",
      branch: "main",
      conflictedFiles: ["a.md"],
    });

    const io = makeScriptedIo({ "a.md": "keep-local" });
    const res = await resolveConflicts(dir, io);

    expect(res.resolvedFiles).toEqual([{ file: "a.md", choice: "keep-local" }]);
    expect(res.sidecarCleared).toBe(true);
    expect(res.commitOid).toBeDefined();

    // Commit message is the conventional one.
    const log = await git.log({ fs, dir, depth: 1 });
    expect(log[0].commit.message).toContain("resolve merge conflict (manual)");

    // Sidecar gone from disk.
    expect(fs.existsSync(join(dir, "wiki-conflict.json"))).toBe(false);
  });

  test("edit invokes io.openEditor with absolute path, then commits", async () => {
    await writeFile(join(dir, "x.md"), "original");
    await commitAll(dir, "baseline");
    await writeFile(join(dir, "x.md"), "halfway-edit");

    await writeConflictSidecar(dir, {
      timestamp: "2026-05-03T00:00:00Z",
      remote: "origin",
      conflictedFiles: ["x.md"],
    });

    const io = makeScriptedIo({ "x.md": "edit" });
    const res = await resolveConflicts(dir, io);
    expect(io.editorCalls).toHaveLength(1);
    expect(io.editorCalls[0]).toBe(join(dir, "x.md"));
    expect(res.sidecarCleared).toBe(true);
  });

  test("skip leaves sidecar in place (non-destructive)", async () => {
    await writeFile(join(dir, "y.md"), "anything");
    await commitAll(dir, "baseline");
    await writeFile(join(dir, "y.md"), "dirty");

    await writeConflictSidecar(dir, {
      timestamp: "2026-05-03T00:00:00Z",
      remote: "origin",
      conflictedFiles: ["y.md"],
    });

    const io = makeScriptedIo({ "y.md": "skip" });
    const res = await resolveConflicts(dir, io);
    expect(res.resolvedFiles).toEqual([{ file: "y.md", choice: "skip" }]);
    expect(res.sidecarCleared).toBe(false);
    // Sidecar stays on disk for a later `am wiki resolve`.
    expect(fs.existsSync(join(dir, "wiki-conflict.json"))).toBe(true);
  });

  test("mixed keep-local + skip: commits kept files but keeps sidecar", async () => {
    await writeFile(join(dir, "a.md"), "a");
    await writeFile(join(dir, "b.md"), "b");
    await commitAll(dir, "baseline");
    await writeFile(join(dir, "a.md"), "a-local");
    await writeFile(join(dir, "b.md"), "b-local");

    await writeConflictSidecar(dir, {
      timestamp: "2026-05-03T00:00:00Z",
      remote: "origin",
      conflictedFiles: ["a.md", "b.md"],
    });

    const io = makeScriptedIo({ "a.md": "keep-local", "b.md": "skip" });
    const res = await resolveConflicts(dir, io);

    // 'a' got handled; 'b' got skipped → sidecar must remain.
    expect(res.sidecarCleared).toBe(false);
    expect(fs.existsSync(join(dir, "wiki-conflict.json"))).toBe(true);
    // And a commit must have landed for the file that was handled.
    expect(res.commitOid).toBeDefined();
  });

  test("take-remote overwrites workdir with remote blob from FETCH_HEAD", async () => {
    // Set up a fake remote by building a commit in the SAME repo on a
    // different branch, then writing the FETCH_HEAD ref to point at it —
    // mirrors what isomorphic-git's fetch would leave behind without
    // needing a network transport (which the test infra doesn't support).
    await writeFile(join(dir, "page.md"), "LOCAL version");
    await commitAll(dir, "baseline with local");
    const localOid = (await git.log({ fs, dir, depth: 1 }))[0].oid;

    // Create the "remote" commit by writing a different blob + tree + commit.
    const remoteBlob = await git.writeBlob({
      fs,
      dir,
      blob: new TextEncoder().encode("REMOTE version"),
    });
    const remoteTree = await git.writeTree({
      fs,
      dir,
      tree: [{ mode: "100644", path: "page.md", oid: remoteBlob, type: "blob" }],
    });
    const remoteCommit = await git.writeCommit({
      fs,
      dir,
      commit: {
        tree: remoteTree,
        parent: [localOid],
        author: { name: "t", email: "t@t", timestamp: 1, timezoneOffset: 0 },
        committer: { name: "t", email: "t@t", timestamp: 1, timezoneOffset: 0 },
        message: "remote edit",
      },
    });
    // Write FETCH_HEAD manually (what git fetch would do).
    await fs.promises.writeFile(
      join(dir, ".git", "FETCH_HEAD"),
      `${remoteCommit}\t\tbranch 'main' of https://fake.example\n`,
      "utf-8",
    );

    await writeConflictSidecar(dir, {
      timestamp: "2026-05-03T00:00:00Z",
      remote: "origin",
      branch: "main",
      conflictedFiles: ["page.md"],
    });

    const io = makeScriptedIo({ "page.md": "take-remote" });
    const res = await resolveConflicts(dir, io);

    expect(res.resolvedFiles).toEqual([{ file: "page.md", choice: "take-remote" }]);
    expect(res.sidecarCleared).toBe(true);
    // Workdir now contains the REMOTE version.
    expect(await Bun.file(join(dir, "page.md")).text()).toBe("REMOTE version");
  });

  test("REV-M53-1: path-traversal filepath rejected", async () => {
    await writeConflictSidecar(dir, {
      timestamp: "2026-05-03T00:00:00Z",
      remote: "origin",
      conflictedFiles: ["../../etc/evil"],
    });
    const io = makeScriptedIo({ "../../etc/evil": "take-remote" });
    await expect(resolveConflicts(dir, io)).rejects.toThrow(/traversal/i);
  });

  test("REV-M53-1: traversal check also fires for edit (defense-in-depth)", async () => {
    await writeConflictSidecar(dir, {
      timestamp: "2026-05-03T00:00:00Z",
      remote: "origin",
      conflictedFiles: ["../../evil"],
    });
    const io = makeScriptedIo({ "../../evil": "edit" });
    await expect(resolveConflicts(dir, io)).rejects.toThrow(/traversal/i);
  });

  test("keep-local for a clean file (no changes) does NOT fail — nothing-to-commit swallowed", async () => {
    // File in workdir matches HEAD exactly; the user picks keep-local.
    // stageWikiFiles + commitAll would throw "Nothing to commit" without
    // the swallow we added. Verify the whole flow still returns success.
    await writeFile(join(dir, "clean.md"), "same");
    await commitAll(dir, "baseline");
    // NOT editing clean.md → workdir matches HEAD.

    await writeConflictSidecar(dir, {
      timestamp: "2026-05-03T00:00:00Z",
      remote: "origin",
      conflictedFiles: ["clean.md"],
    });

    const io = makeScriptedIo({ "clean.md": "keep-local" });
    const res = await resolveConflicts(dir, io);

    expect(res.resolvedFiles).toEqual([{ file: "clean.md", choice: "keep-local" }]);
    // Sidecar still cleared (nothing to resolve).
    expect(res.sidecarCleared).toBe(true);
    // commitOid may be undefined (nothing-to-commit swallowed). That's OK.
  });
});
