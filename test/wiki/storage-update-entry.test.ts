/**
 * R-BUG5 regression — updateEntry must not destroy the source-of-truth `.md`
 * when the rewrite fails.
 *
 * `updateEntry(id, updates)` historically did `deletePage(id)` BEFORE
 * `writePage(...)` "in case the type changed". If writePage threw (ENOSPC,
 * EACCES, or the wikilink/NER pass failing before the atomic rename), the old
 * page was already gone and never restored — a silent data-loss bug.
 *
 * The fix writes the new page FIRST and only prunes the stale file when the
 * page actually moved subdirs (a type change) AND the write succeeded. These
 * tests exercise both the happy type-change path (stale file pruned) and the
 * failure path (original page survives an exploding writePage).
 *
 * No mock.module: we force writePage to throw with a real filesystem obstacle
 * (a regular file sitting where the `entities/` subdir must be created), so
 * there is no cross-file mock leak to clean up.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import { join } from "node:path";
import { getEntry, getWikiDir, readPage, updateEntry, writePage } from "../../src/wiki/storage";
import { type TestDir, createTestDir } from "../helpers/tmp";

const PAGE_SUBDIRS = {
  entity: "entities",
  concept: "concepts",
  summary: "summaries",
} as const;

describe("R-BUG5 updateEntry write-before-delete", () => {
  let tmp: TestDir;
  let prevConfigDir: string | undefined;

  beforeEach(async () => {
    tmp = await createTestDir("am-bug5-updateentry-");
    // Route getWikiDir() → <tmp>/wiki/global (no project config in the worktree
    // root, so resolveWikiDir falls back to the global store).
    prevConfigDir = process.env.AM_CONFIG_DIR;
    process.env.AM_CONFIG_DIR = tmp.path;
  });

  afterEach(async () => {
    if (prevConfigDir === undefined) Reflect.deleteProperty(process.env, "AM_CONFIG_DIR");
    else process.env.AM_CONFIG_DIR = prevConfigDir;
    await tmp.cleanup();
  });

  function makeConceptPage(slug: string, content: string) {
    const now = new Date().toISOString();
    return {
      slug,
      title: content.split("\n")[0].slice(0, 100),
      type: "concept" as const,
      content,
      tags: ["topic"],
      sources: [],
      backlinks: [],
      created: now,
      updated: now,
    };
  }

  test("happy path: type change moves the page and prunes the stale subdir file", async () => {
    const wikiDir = getWikiDir();
    // Seed a page on disk as a `concept` so updateEntry sees a genuine
    // type change (concept → entity, since entryToPage always emits "entity").
    await writePage(makeConceptPage("topic-1", "Original concept body"), wikiDir);
    expect(await readPage("topic-1", wikiDir)).not.toBeNull();
    const oldFile = join(wikiDir, PAGE_SUBDIRS.concept, "topic-1.md");
    const newFile = join(wikiDir, PAGE_SUBDIRS.entity, "topic-1.md");
    expect(fs.existsSync(oldFile)).toBe(true);

    await updateEntry("topic-1", { content: "Updated body" });

    // New page lives under entities/, stale concept file is pruned.
    expect(fs.existsSync(newFile)).toBe(true);
    expect(fs.existsSync(oldFile)).toBe(false);

    const after = await getEntry("topic-1");
    expect(after).not.toBeNull();
    expect(after!.content).toContain("Updated body");
  });

  test("writePage throws mid-type-change → original entry is NOT destroyed", async () => {
    const wikiDir = getWikiDir();
    // Seed the source-of-truth page as a concept. deletePage scans subdirs in
    // PAGE_SUBDIRS order (entity, concept, summary, ...) and stops at the first
    // match — so for a concept page it deletes concepts/survivor.md and never
    // touches summaries/.
    await writePage(makeConceptPage("survivor", "Precious original content"), wikiDir);
    const oldFile = join(wikiDir, PAGE_SUBDIRS.concept, "survivor.md");
    const newFile = join(wikiDir, PAGE_SUBDIRS.entity, "survivor.md");
    expect(fs.existsSync(oldFile)).toBe(true);

    // Sabotage writePage WITHOUT breaking deletePage: replace the `summaries/`
    // subdir with a regular FILE. writePage's ensureWikiDirs does
    // mkdir(summaries, {recursive:true}) which throws EEXIST/ENOTDIR on a file,
    // so writePage explodes BEFORE the atomic rename. deletePage("survivor")
    // for a concept page only rm()s concepts/survivor.md — it never opens
    // summaries/ — so the buggy delete-first ordering WOULD have removed the
    // source page before writePage threw, silently destroying the entry.
    const summariesDir = join(wikiDir, PAGE_SUBDIRS.summary);
    await fs.promises.rm(summariesDir, { recursive: true, force: true });
    await fs.promises.writeFile(summariesDir, "I am a file, not a directory", "utf-8");

    await expect(updateEntry("survivor", { content: "doomed update" })).rejects.toThrow();

    // The write never landed under entities/ ...
    expect(fs.existsSync(newFile)).toBe(false);
    // ...and crucially the ORIGINAL concept page is intact, not obliterated.
    expect(fs.existsSync(oldFile)).toBe(true);
    expect(await fs.promises.readFile(oldFile, "utf-8")).toContain("Precious original content");

    // Recover the directory so a fresh read works, then confirm the entry is
    // still queryable end-to-end.
    await fs.promises.rm(summariesDir, { force: true });
    await fs.promises.mkdir(summariesDir, { recursive: true });
    const survived = await getEntry("survivor");
    expect(survived).not.toBeNull();
    expect(survived!.content).toContain("Precious original content");
  });
});
