/**
 * SEC-2: wiki page slug/id traversal containment.
 *
 * Wiki page file paths are derived from a user/agent-controlled slug (the
 * KnowledgeEntry id). A slug like `../../escape` must be contained to a single
 * path segment so write/read/delete cannot break out of the wiki directory.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { listPages, readPage, writePage } from "../../src/wiki/storage";
import type { WikiPage } from "../../src/wiki/types";
import { type TestDir, createTestDir } from "../helpers/tmp";

function makePage(slug: string, overrides: Partial<WikiPage> = {}): WikiPage {
  const now = new Date().toISOString();
  return {
    slug,
    title: "Malicious Page",
    type: "entity",
    content: "payload",
    tags: [],
    sources: [],
    backlinks: [],
    created: now,
    updated: now,
    confidence: 0.5,
    ...overrides,
  };
}

describe("SEC-2: wiki storage slug traversal containment", () => {
  let tmp: TestDir;
  let wikiDir: string;

  beforeEach(async () => {
    tmp = await createTestDir("wiki-traversal-");
    wikiDir = join(tmp.path, "wiki");
  });

  afterEach(async () => {
    if (tmp) await tmp.cleanup();
  });

  test("a '../escape' slug is contained inside the wiki directory", async () => {
    const page = makePage("../../escape");
    await writePage(page, wikiDir);

    // The escape target must NOT have been written.
    const outside = join(tmp.path, "escape.md");
    expect(await Bun.file(outside).exists()).toBe(false);

    // The file must live inside the entities subdir with a sanitized name.
    const entities = await readdir(join(wikiDir, "entities"));
    expect(entities.length).toBe(1);
    const written = entities[0];
    expect(written.includes("..")).toBe(false);
    expect(written.includes("/")).toBe(false);
    expect(written.endsWith(".md")).toBe(true);
  });

  test("write then read round-trips a malicious slug to the same contained file", async () => {
    const slug = "../../../etc/passwd";
    await writePage(makePage(slug, { content: "round-trip" }), wikiDir);

    // readPage uses the same sanitization, so it resolves the same file.
    const read = await readPage(slug, wikiDir);
    expect(read).not.toBeNull();
    expect(read!.content).toContain("round-trip");

    // And no file escaped the wiki dir.
    const entities = await readdir(join(wikiDir, "entities"));
    expect(entities.every((f) => !f.includes(".."))).toBe(true);
  });

  test("listPages does not surface any escaped files", async () => {
    await writePage(makePage("../evil", { content: "x" }), wikiDir);
    const pages = await listPages({ wikiDir });
    expect(pages.length).toBe(1);
  });
});
