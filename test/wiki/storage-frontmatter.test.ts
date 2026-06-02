import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  getSupersedeInfo,
  readPage,
  serializeFrontmatter,
  writePage,
} from "../../src/wiki/storage";
import type { WikiPage } from "../../src/wiki/types";
import { type TestDir, createTestDir } from "../helpers/tmp";

// ADR-0054 R4: WikiPage gains ADR-0020 frontmatter (entities / coverage /
// supersedes / superseded_by) and confidence becomes the low|medium|high enum.
// Reads normalise legacy numeric confidence so existing pages don't break.

function makePage(overrides: Partial<WikiPage> = {}): WikiPage {
  const now = new Date().toISOString();
  return {
    slug: "fm-page",
    title: "FM Page",
    type: "entity",
    content: "Body content.",
    tags: ["a"],
    sources: [],
    backlinks: [],
    created: now,
    updated: now,
    ...overrides,
  };
}

describe("wiki/storage frontmatter (ADR-0054 R4)", () => {
  let tmp: TestDir;
  let wikiDir: string;

  beforeEach(async () => {
    tmp = await createTestDir("wiki-frontmatter-");
    wikiDir = join(tmp.path, "wiki");
  });

  afterEach(async () => {
    await tmp.cleanup();
  });

  test("ADR-0020 fields round-trip through write + read", async () => {
    const page = makePage({
      slug: "rich-page",
      confidence: "high",
      entities: ["claude-code", "bun"],
      coverage: 3,
      supersedes: "old-page",
      superseded_by: "newer-page",
    });
    await writePage(page, { wikiDir, maintainDerived: false });

    const loaded = await readPage("rich-page", wikiDir);
    expect(loaded).not.toBeNull();
    expect(loaded!.confidence).toBe("high");
    expect(loaded!.entities).toEqual(["claude-code", "bun"]);
    expect(loaded!.coverage).toBe(3);
    expect(loaded!.supersedes).toBe("old-page");
    expect(loaded!.superseded_by).toBe("newer-page");
  });

  test("confidence enum round-trips for each level", async () => {
    for (const level of ["low", "medium", "high"] as const) {
      await writePage(makePage({ slug: `c-${level}`, confidence: level }), {
        wikiDir,
        maintainDerived: false,
      });
      const loaded = await readPage(`c-${level}`, wikiDir);
      expect(loaded!.confidence).toBe(level);
    }
  });

  test("legacy numeric confidence is normalised to the enum on write", async () => {
    // A caller still passing a number (pre-R4 producer) is normalised.
    await writePage(makePage({ slug: "legacy-num", confidence: 0.9 }), {
      wikiDir,
      maintainDerived: false,
    });
    const loaded = await readPage("legacy-num", wikiDir);
    expect(loaded!.confidence).toBe("high");
  });

  test("pages without the new fields stay diff-clean (fields omitted)", async () => {
    await writePage(makePage({ slug: "minimal" }), { wikiDir, maintainDerived: false });
    const loaded = await readPage("minimal", wikiDir);
    expect(loaded!.confidence).toBeUndefined();
    expect(loaded!.entities).toBeUndefined();
    expect(loaded!.coverage).toBeUndefined();
    expect(loaded!.supersedes).toBeUndefined();
    expect(loaded!.superseded_by).toBeUndefined();
  });

  test("reads a pre-R4 page with numeric confidence on disk (one-time migration)", async () => {
    // Simulate a page written before R4: confidence stored as a raw number.
    await mkdir(join(wikiDir, "entities"), { recursive: true });
    const legacyBody = serializeFrontmatter(
      {
        title: "Pre R4",
        type: "entity",
        slug: "pre-r4",
        tags: [],
        sources: [],
        backlinks: [],
        created: new Date().toISOString(),
        updated: new Date().toISOString(),
        confidence: 0.55,
      },
      "Old-format body.",
    );
    await writeFile(join(wikiDir, "entities", "pre-r4.md"), legacyBody, "utf-8");

    const loaded = await readPage("pre-r4", wikiDir);
    expect(loaded).not.toBeNull();
    // 0.55 → "medium" bucket.
    expect(loaded!.confidence).toBe("medium");
  });
});

// ADR-0054 R4 read surface: getSupersedeInfo turns the supersedes /
// superseded_by frontmatter fields (previously serialize+parse-only) into a
// reportable relationship, so they are no longer write-then-parse dead weight.
describe("wiki/storage getSupersedeInfo (ADR-0054 R4 read surface)", () => {
  let tmp: TestDir;
  let wikiDir: string;

  beforeEach(async () => {
    tmp = await createTestDir("wiki-supersede-");
    wikiDir = join(tmp.path, "wiki");
  });

  afterEach(async () => {
    await tmp.cleanup();
  });

  test("returns null when neither supersede field is set (the common case)", () => {
    expect(getSupersedeInfo(makePage({ slug: "plain" }))).toBeNull();
  });

  test("reports 'superseded by X' when the page is shadowed", () => {
    const info = getSupersedeInfo(makePage({ slug: "stale", superseded_by: "fresh" }));
    expect(info).not.toBeNull();
    expect(info!.supersededBy).toBe("fresh");
    expect(info!.supersedes).toBeNull();
    expect(info!.label).toBe("superseded by fresh");
  });

  test("reports 'supersedes Y' when the page replaces an older one", () => {
    const info = getSupersedeInfo(makePage({ slug: "fresh", supersedes: "stale" }));
    expect(info).not.toBeNull();
    expect(info!.supersedes).toBe("stale");
    expect(info!.supersededBy).toBeNull();
    expect(info!.label).toBe("supersedes stale");
  });

  test("reports both relationships, superseded-by first (more actionable)", () => {
    const info = getSupersedeInfo(
      makePage({ slug: "mid", supersedes: "older", superseded_by: "newer" }),
    );
    expect(info).not.toBeNull();
    expect(info!.label).toBe("superseded by newer; supersedes older");
  });

  test("surfaces the relationship for a page round-tripped through disk", async () => {
    await writePage(
      makePage({ slug: "on-disk", supersedes: "ancestor", superseded_by: "descendant" }),
      { wikiDir, maintainDerived: false },
    );
    const loaded = await readPage("on-disk", wikiDir);
    expect(loaded).not.toBeNull();
    const info = getSupersedeInfo(loaded!);
    expect(info!.label).toBe("superseded by descendant; supersedes ancestor");
  });
});
