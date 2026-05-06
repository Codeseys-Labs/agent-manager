import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  WIKI_PROJECT_DIRNAME,
  getProjectWikiDir,
  materialiseProject,
  pushToGlobal,
  resolveProjectName,
} from "../../src/wiki/storage";
import { type TestDir, createTestDir } from "../helpers/tmp";

// ADR-0044 tasks 2+3: `materialiseProject` copies global-store entries down
// into a project's `.am-wiki/`; `pushToGlobal` promotes a project-local entry
// back up to the global store. Both are the copy-based replacement for
// ADR-0022's symlink mechanism.

// ── helpers ──────────────────────────────────────────────────────

const PAGE_MD = (slug: string, title: string, body = "body") => `---
title: ${title}
type: entity
slug: ${slug}
tags: []
sources: []
backlinks: []
created: "2026-05-05T00:00:00.000Z"
updated: "2026-05-05T00:00:00.000Z"
---
${body}
`;

/**
 * Seed the global store at $AM_CONFIG_DIR/wiki/projects/<projectName>/<subdir>/<slug>.md.
 * Returns the absolute path to the file written.
 */
function seedGlobalEntry(
  configDir: string,
  projectName: string,
  subdir: string,
  slug: string,
  content: string,
): string {
  const dir = join(configDir, "wiki", "projects", projectName, subdir);
  mkdirSync(dir, { recursive: true });
  const filePath = join(dir, `${slug}.md`);
  writeFileSync(filePath, content, "utf-8");
  return filePath;
}

function seedLocalEntry(projectDir: string, subdir: string, slug: string, content: string): string {
  const dir = join(projectDir, WIKI_PROJECT_DIRNAME, subdir);
  mkdirSync(dir, { recursive: true });
  const filePath = join(dir, `${slug}.md`);
  writeFileSync(filePath, content, "utf-8");
  return filePath;
}

// ── suite ────────────────────────────────────────────────────────

describe("ADR-0044: materialiseProject + pushToGlobal", () => {
  let projectDir: TestDir;
  let configHome: TestDir;
  let savedEnv: string | undefined;
  let projectName: string;

  beforeEach(async () => {
    projectDir = await createTestDir("adr44-proj-");
    configHome = await createTestDir("adr44-cfg-");
    savedEnv = process.env.AM_CONFIG_DIR;
    process.env.AM_CONFIG_DIR = configHome.path;
    projectName = resolveProjectName(projectDir.path);
  });

  afterEach(async () => {
    if (savedEnv === undefined) process.env.AM_CONFIG_DIR = undefined;
    else process.env.AM_CONFIG_DIR = savedEnv;
    await projectDir.cleanup();
    await configHome.cleanup();
  });

  // ── materialiseProject ────────────────────────────────────────

  test("materialiseProject('all') with empty global store returns empty arrays", async () => {
    // Global project store doesn't even exist yet.
    const result = await materialiseProject(projectDir.path, "all");
    expect(result.copied).toEqual([]);
    expect(result.skipped).toEqual([]);
  });

  test("materialiseProject('all') copies every entry across subdirs", async () => {
    seedGlobalEntry(configHome.path, projectName, "entities", "alice", PAGE_MD("alice", "Alice"));
    seedGlobalEntry(configHome.path, projectName, "concepts", "beta", PAGE_MD("beta", "Beta"));
    seedGlobalEntry(configHome.path, projectName, "decisions", "gamma", PAGE_MD("gamma", "Gamma"));

    const result = await materialiseProject(projectDir.path, "all");
    expect(result.copied.sort()).toEqual(["alice", "beta", "gamma"]);
    expect(result.skipped).toEqual([]);

    // And the files actually exist at the expected destinations.
    expect(await projectDir.exists(join(WIKI_PROJECT_DIRNAME, "entities", "alice.md"))).toBe(true);
    expect(await projectDir.exists(join(WIKI_PROJECT_DIRNAME, "concepts", "beta.md"))).toBe(true);
    expect(await projectDir.exists(join(WIKI_PROJECT_DIRNAME, "decisions", "gamma.md"))).toBe(true);
  });

  test("materialiseProject is idempotent: second run classifies identical files as skipped", async () => {
    seedGlobalEntry(configHome.path, projectName, "entities", "alice", PAGE_MD("alice", "Alice"));
    seedGlobalEntry(configHome.path, projectName, "concepts", "beta", PAGE_MD("beta", "Beta"));

    const first = await materialiseProject(projectDir.path, "all");
    expect(first.copied.sort()).toEqual(["alice", "beta"]);

    const second = await materialiseProject(projectDir.path, "all");
    expect(second.copied).toEqual([]);
    expect(second.skipped.sort()).toEqual(["alice", "beta"]);
  });

  test("materialiseProject overwrites when local content differs from global", async () => {
    seedGlobalEntry(
      configHome.path,
      projectName,
      "entities",
      "alice",
      PAGE_MD("alice", "Alice", "GLOBAL body"),
    );
    // Seed local with different content first.
    seedLocalEntry(
      projectDir.path,
      "entities",
      "alice",
      PAGE_MD("alice", "Alice", "LOCAL stale body"),
    );

    const result = await materialiseProject(projectDir.path, "all");
    expect(result.copied).toEqual(["alice"]);
    expect(result.skipped).toEqual([]);

    const merged = await projectDir.read(join(WIKI_PROJECT_DIRNAME, "entities", "alice.md"));
    expect(merged).toContain("GLOBAL body");
    expect(merged).not.toContain("LOCAL stale body");
  });

  test("materialiseProject with specific slug list: missing slugs returned in skipped without throwing", async () => {
    seedGlobalEntry(configHome.path, projectName, "entities", "alice", PAGE_MD("alice", "Alice"));

    const result = await materialiseProject(projectDir.path, ["alice", "zeta-not-there"]);
    expect(result.copied).toEqual(["alice"]);
    expect(result.skipped).toEqual(["zeta-not-there"]);
  });

  test("materialiseProject writes into `.am-wiki/`, NOT `.agent-manager/wiki/`", async () => {
    seedGlobalEntry(configHome.path, projectName, "entities", "alice", PAGE_MD("alice", "Alice"));

    await materialiseProject(projectDir.path, "all");

    expect(await projectDir.exists(join(".am-wiki", "entities", "alice.md"))).toBe(true);
    expect(await projectDir.exists(join(".agent-manager", "wiki", "entities", "alice.md"))).toBe(
      false,
    );
  });

  test("materialiseProject returns slugs sorted alphabetically in both arrays", async () => {
    seedGlobalEntry(configHome.path, projectName, "entities", "charlie", PAGE_MD("charlie", "C"));
    seedGlobalEntry(configHome.path, projectName, "entities", "alpha", PAGE_MD("alpha", "A"));
    seedGlobalEntry(configHome.path, projectName, "entities", "bravo", PAGE_MD("bravo", "B"));

    const result = await materialiseProject(projectDir.path, "all");
    expect(result.copied).toEqual(["alpha", "bravo", "charlie"]);
  });

  // ── pushToGlobal ──────────────────────────────────────────────

  test("pushToGlobal: clean push when global slot is empty", async () => {
    const localPath = seedLocalEntry(
      projectDir.path,
      "entities",
      "alice",
      PAGE_MD("alice", "Alice"),
    );

    const result = await pushToGlobal(projectDir.path, "alice");
    expect(result).toEqual({ pushed: "alice", conflict: false });

    const globalPath = join(getProjectWikiDir(projectName), "entities", "alice.md");
    expect(readFileSync(globalPath, "utf-8")).toBe(readFileSync(localPath, "utf-8"));
  });

  test("pushToGlobal: pushed file is byte-identical to local source", async () => {
    const body = "Rich\ncontent\nwith\nnewlines\n";
    seedLocalEntry(projectDir.path, "concepts", "beta", PAGE_MD("beta", "Beta", body));

    await pushToGlobal(projectDir.path, "beta");

    const localBytes = readFileSync(
      join(projectDir.path, WIKI_PROJECT_DIRNAME, "concepts", "beta.md"),
    );
    const globalBytes = readFileSync(join(getProjectWikiDir(projectName), "concepts", "beta.md"));
    expect(globalBytes.equals(localBytes)).toBe(true);
  });

  test("pushToGlobal: identical-existing is idempotent (conflict: false, no overwrite needed)", async () => {
    const content = PAGE_MD("alice", "Alice");
    seedLocalEntry(projectDir.path, "entities", "alice", content);
    seedGlobalEntry(configHome.path, projectName, "entities", "alice", content);

    const result = await pushToGlobal(projectDir.path, "alice");
    expect(result).toEqual({ pushed: "alice", conflict: false });
  });

  test("pushToGlobal: differing-existing returns conflict:true and does NOT overwrite", async () => {
    seedLocalEntry(projectDir.path, "entities", "alice", PAGE_MD("alice", "Alice", "LOCAL body"));
    const globalPath = seedGlobalEntry(
      configHome.path,
      projectName,
      "entities",
      "alice",
      PAGE_MD("alice", "Alice", "GLOBAL body"),
    );
    const beforeBytes = readFileSync(globalPath, "utf-8");

    const result = await pushToGlobal(projectDir.path, "alice");
    expect(result).toEqual({ pushed: null, conflict: true });

    const afterBytes = readFileSync(globalPath, "utf-8");
    expect(afterBytes).toBe(beforeBytes);
    expect(afterBytes).toContain("GLOBAL body");
  });

  test("pushToGlobal with force: true: overwrites a differing existing global entry", async () => {
    seedLocalEntry(projectDir.path, "entities", "alice", PAGE_MD("alice", "Alice", "LOCAL WINS"));
    const globalPath = seedGlobalEntry(
      configHome.path,
      projectName,
      "entities",
      "alice",
      PAGE_MD("alice", "Alice", "OLD GLOBAL"),
    );

    const result = await pushToGlobal(projectDir.path, "alice", { force: true });
    expect(result).toEqual({ pushed: "alice", conflict: false });

    const finalContent = readFileSync(globalPath, "utf-8");
    expect(finalContent).toContain("LOCAL WINS");
    expect(finalContent).not.toContain("OLD GLOBAL");
  });

  test("pushToGlobal: missing slug throws with descriptive error", async () => {
    // Nothing seeded locally.
    let caught: Error | null = null;
    try {
      await pushToGlobal(projectDir.path, "no-such-slug");
    } catch (err) {
      caught = err as Error;
    }
    expect(caught).not.toBeNull();
    expect(caught?.message).toContain("no-such-slug");
  });

  test("pushToGlobal finds an entry regardless of which PAGE_SUBDIRS subdir holds it", async () => {
    // Seed in `decisions/`, not the default `entities/`.
    seedLocalEntry(projectDir.path, "decisions", "adr-007", PAGE_MD("adr-007", "ADR 007"));

    const result = await pushToGlobal(projectDir.path, "adr-007");
    expect(result).toEqual({ pushed: "adr-007", conflict: false });

    const globalPath = join(getProjectWikiDir(projectName), "decisions", "adr-007.md");
    const globalContent = readFileSync(globalPath, "utf-8");
    expect(globalContent).toContain("ADR 007");
  });
});
