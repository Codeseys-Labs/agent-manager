import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  WIKI_PROJECT_DIRNAME,
  getProjectWikiDir,
  pushToGlobal,
  resolveProjectName,
} from "../../src/wiki/storage";
import { type TestDir, createTestDir } from "../helpers/tmp";

// ADR-0054 R6: pushToGlobal({ promote: true }) targets the cross-project GLOBAL
// store (wiki/global/), with the same conflict surface (conflict / --force) as
// the ADR-0044 per-project-mirror push. The default (no `promote`) preserves
// the ADR-0044 per-project mirror target so existing flows do not regress.

const PAGE_MD = (slug: string, title: string, body = "body") => `---
title: ${title}
type: entity
slug: ${slug}
tags: []
sources: []
backlinks: []
created: "2026-06-01T00:00:00.000Z"
updated: "2026-06-01T00:00:00.000Z"
---
${body}
`;

function seedLocalEntry(projectDir: string, subdir: string, slug: string, content: string): string {
  const dir = join(projectDir, WIKI_PROJECT_DIRNAME, subdir);
  mkdirSync(dir, { recursive: true });
  const filePath = join(dir, `${slug}.md`);
  writeFileSync(filePath, content, "utf-8");
  return filePath;
}

function seedGlobalStoreEntry(
  configDir: string,
  subdir: string,
  slug: string,
  content: string,
): string {
  const dir = join(configDir, "wiki", "global", subdir);
  mkdirSync(dir, { recursive: true });
  const filePath = join(dir, `${slug}.md`);
  writeFileSync(filePath, content, "utf-8");
  return filePath;
}

describe("ADR-0054 R6: pushToGlobal({ promote }) targets wiki/global", () => {
  let projectDir: TestDir;
  let configHome: TestDir;
  let savedEnv: string | undefined;
  let projectName: string;

  beforeEach(async () => {
    projectDir = await createTestDir("r6-proj-");
    configHome = await createTestDir("r6-cfg-");
    savedEnv = process.env.AM_CONFIG_DIR;
    process.env.AM_CONFIG_DIR = configHome.path;
    projectName = resolveProjectName(projectDir.path);
  });

  afterEach(async () => {
    if (savedEnv === undefined) {
      // biome-ignore lint/performance/noDelete: env var cleanup
      delete process.env.AM_CONFIG_DIR;
    } else {
      process.env.AM_CONFIG_DIR = savedEnv;
    }
    await projectDir.cleanup();
    await configHome.cleanup();
  });

  test("promote: true lands in wiki/global, NOT the per-project mirror", async () => {
    seedLocalEntry(projectDir.path, "entities", "shared-fact", PAGE_MD("shared-fact", "Shared"));

    const result = await pushToGlobal(projectDir.path, "shared-fact", { promote: true });
    expect(result).toEqual({ pushed: "shared-fact", conflict: false });

    // Reaches the cross-project global store.
    const globalPath = join(configHome.path, "wiki", "global", "entities", "shared-fact.md");
    expect(readFileSync(globalPath, "utf-8")).toContain("Shared");

    // Does NOT write to the per-project mirror (that's the pre-R6 bug).
    const mirrorPath = join(getProjectWikiDir(projectName), "entities", "shared-fact.md");
    let mirrorExists = true;
    try {
      readFileSync(mirrorPath, "utf-8");
    } catch {
      mirrorExists = false;
    }
    expect(mirrorExists).toBe(false);
  });

  test("default (no promote) still targets the per-project mirror, not global", async () => {
    seedLocalEntry(projectDir.path, "entities", "local-only", PAGE_MD("local-only", "Local"));

    const result = await pushToGlobal(projectDir.path, "local-only");
    expect(result).toEqual({ pushed: "local-only", conflict: false });

    const mirrorPath = join(getProjectWikiDir(projectName), "entities", "local-only.md");
    expect(readFileSync(mirrorPath, "utf-8")).toContain("Local");

    // Global store untouched.
    const globalPath = join(configHome.path, "wiki", "global", "entities", "local-only.md");
    let globalExists = true;
    try {
      readFileSync(globalPath, "utf-8");
    } catch {
      globalExists = false;
    }
    expect(globalExists).toBe(false);
  });

  test("promote conflict: differing global entry returns conflict:true without overwriting", async () => {
    seedLocalEntry(
      projectDir.path,
      "entities",
      "policy",
      PAGE_MD("policy", "Policy", "LOCAL body"),
    );
    const globalPath = seedGlobalStoreEntry(
      configHome.path,
      "entities",
      "policy",
      PAGE_MD("policy", "Policy", "GLOBAL body"),
    );
    const before = readFileSync(globalPath, "utf-8");

    const result = await pushToGlobal(projectDir.path, "policy", { promote: true });
    expect(result).toEqual({ pushed: null, conflict: true });

    // Global slot is untouched on conflict.
    expect(readFileSync(globalPath, "utf-8")).toBe(before);
    expect(readFileSync(globalPath, "utf-8")).toContain("GLOBAL body");
  });

  test("promote --force overwrites a differing global entry", async () => {
    seedLocalEntry(
      projectDir.path,
      "entities",
      "policy",
      PAGE_MD("policy", "Policy", "LOCAL WINS"),
    );
    const globalPath = seedGlobalStoreEntry(
      configHome.path,
      "entities",
      "policy",
      PAGE_MD("policy", "Policy", "OLD GLOBAL"),
    );

    const result = await pushToGlobal(projectDir.path, "policy", { promote: true, force: true });
    expect(result).toEqual({ pushed: "policy", conflict: false });

    const after = readFileSync(globalPath, "utf-8");
    expect(after).toContain("LOCAL WINS");
    expect(after).not.toContain("OLD GLOBAL");
  });

  test("promote idempotent: byte-identical global entry is a no-op (conflict:false)", async () => {
    const content = PAGE_MD("same", "Same");
    seedLocalEntry(projectDir.path, "entities", "same", content);
    seedGlobalStoreEntry(configHome.path, "entities", "same", content);

    const result = await pushToGlobal(projectDir.path, "same", { promote: true });
    expect(result).toEqual({ pushed: "same", conflict: false });
  });

  test("promote finds the entry regardless of which subdir holds it", async () => {
    seedLocalEntry(projectDir.path, "decisions", "adr-009", PAGE_MD("adr-009", "ADR 009"));

    const result = await pushToGlobal(projectDir.path, "adr-009", { promote: true });
    expect(result).toEqual({ pushed: "adr-009", conflict: false });

    const globalPath = join(configHome.path, "wiki", "global", "decisions", "adr-009.md");
    expect(readFileSync(globalPath, "utf-8")).toContain("ADR 009");
  });

  test("promote of a missing slug throws", async () => {
    let caught: Error | null = null;
    try {
      await pushToGlobal(projectDir.path, "no-such", { promote: true });
    } catch (err) {
      caught = err as Error;
    }
    expect(caught).not.toBeNull();
    expect(caught?.message).toContain("no-such");
  });
});
