import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  getCoverageInfo,
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

// ── WAVE G-WIKIREAD: supersession + coverage read accessors ─────────

describe("wiki/storage getSupersedeInfo", () => {
  test("reports both pointers + hasSupersession when set", () => {
    const info = getSupersedeInfo({ supersedes: "old", superseded_by: "new" });
    expect(info.supersedes).toBe("old");
    expect(info.superseded_by).toBe("new");
    expect(info.hasSupersession).toBe(true);
  });

  test("reports only the pointer that is set", () => {
    const onlySupersedes = getSupersedeInfo({ supersedes: "old" });
    expect(onlySupersedes.supersedes).toBe("old");
    expect(onlySupersedes.superseded_by).toBeUndefined();
    expect(onlySupersedes.hasSupersession).toBe(true);

    const onlySuperseded = getSupersedeInfo({ superseded_by: "new" });
    expect(onlySuperseded.supersedes).toBeUndefined();
    expect(onlySuperseded.superseded_by).toBe("new");
    expect(onlySuperseded.hasSupersession).toBe(true);
  });

  test("a page with neither pointer reports hasSupersession=false and omits both", () => {
    const info = getSupersedeInfo({});
    expect(info.supersedes).toBeUndefined();
    expect(info.superseded_by).toBeUndefined();
    expect(info.hasSupersession).toBe(false);
  });
});

describe("wiki/storage getCoverageInfo", () => {
  test("returns the coverage count when set", () => {
    expect(getCoverageInfo({ coverage: 3 })).toBe(3);
    expect(getCoverageInfo({ coverage: 0 })).toBe(0);
  });

  test("returns undefined when the page never set coverage", () => {
    expect(getCoverageInfo({})).toBeUndefined();
  });
});
