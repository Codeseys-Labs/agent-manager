import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import { join } from "node:path";
import {
  LEGACY_WIKI_PROJECT_DIRNAME,
  WIKI_PROJECT_DIRNAME,
  detectLegacyWikiLayout,
} from "../../src/wiki/storage";
import { type TestDir, createTestDir } from "../helpers/tmp";

// ADR-0044: detect which of {legacy `.agent-manager/wiki/`, new `.am-wiki/`}
// layouts is present in a project directory. Used by `am wiki migrate` and
// the deprecation warning in the refactored `am wiki init`.

describe("ADR-0044: detectLegacyWikiLayout", () => {
  let dir: TestDir;

  afterEach(async () => {
    if (dir) await dir.cleanup();
  });

  test("constants point at the right paths", () => {
    expect(WIKI_PROJECT_DIRNAME).toBe(".am-wiki");
    expect(LEGACY_WIKI_PROJECT_DIRNAME).toBe(join(".agent-manager", "wiki"));
  });

  test("clean project: neither layout present", async () => {
    dir = await createTestDir("wiki-layout-clean-");
    const result = detectLegacyWikiLayout(dir.path);
    expect(result.hasLegacy).toBe(false);
    expect(result.hasNew).toBe(false);
    expect(result.legacyPath).toBe(join(dir.path, LEGACY_WIKI_PROJECT_DIRNAME));
    expect(result.newPath).toBe(join(dir.path, WIKI_PROJECT_DIRNAME));
  });

  test("only legacy `.agent-manager/wiki/` present", async () => {
    dir = await createTestDir("wiki-layout-legacy-");
    fs.mkdirSync(join(dir.path, ".agent-manager", "wiki"), { recursive: true });
    const result = detectLegacyWikiLayout(dir.path);
    expect(result.hasLegacy).toBe(true);
    expect(result.hasNew).toBe(false);
  });

  test("only new `.am-wiki/` present", async () => {
    dir = await createTestDir("wiki-layout-new-");
    fs.mkdirSync(join(dir.path, ".am-wiki"));
    const result = detectLegacyWikiLayout(dir.path);
    expect(result.hasLegacy).toBe(false);
    expect(result.hasNew).toBe(true);
  });

  test("both layouts present (mid-migration)", async () => {
    dir = await createTestDir("wiki-layout-both-");
    fs.mkdirSync(join(dir.path, ".agent-manager", "wiki"), { recursive: true });
    fs.mkdirSync(join(dir.path, ".am-wiki"));
    const result = detectLegacyWikiLayout(dir.path);
    expect(result.hasLegacy).toBe(true);
    expect(result.hasNew).toBe(true);
  });

  test("symlink at legacy path counts as present (ADR-0022 mechanism)", async () => {
    dir = await createTestDir("wiki-layout-symlink-");
    // Create a target dir, then symlink .agent-manager/wiki to it.
    fs.mkdirSync(join(dir.path, ".agent-manager"), { recursive: true });
    const target = join(dir.path, "global-wiki-target");
    fs.mkdirSync(target);
    try {
      fs.symlinkSync(target, join(dir.path, ".agent-manager", "wiki"));
    } catch (err) {
      // Windows without dev mode / admin rights — skip this case.
      // The detection function still works; we just can't construct
      // the fixture here.
      const e = err as NodeJS.ErrnoException;
      if (e.code === "EPERM" || e.code === "ENOSYS") return;
      throw err;
    }
    const result = detectLegacyWikiLayout(dir.path);
    expect(result.hasLegacy).toBe(true);
    expect(result.hasNew).toBe(false);
  });

  test("returns absolute paths regardless of input form", async () => {
    dir = await createTestDir("wiki-layout-abs-");
    const result = detectLegacyWikiLayout(dir.path);
    // Both paths should be sub-paths of the input (which is absolute via tmpdir).
    expect(result.legacyPath.startsWith(dir.path)).toBe(true);
    expect(result.newPath.startsWith(dir.path)).toBe(true);
  });
});
