/**
 * ADR-0054 Wave C — wiki cross-project search (R5) + global promotion (R6).
 *
 * Drives the citty subcommands directly (same harness as wiki-wave-b). The
 * `AM_CONFIG_DIR` override redirects the central wiki store into a tmp dir;
 * `process.chdir` puts us inside a project so `resolveProjectConfig` finds the
 * `.agent-manager.toml` marker.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { wikiCommand } from "../../src/commands/wiki";
import { getProjectWikiDir, resolveProjectName, writePage } from "../../src/wiki/storage";
import type { WikiPage } from "../../src/wiki/types";
import { type TestDir, createTestDir } from "../helpers/tmp";

// ── citty introspection ─────────────────────────────────────────

type SubcommandRunner = { run: (ctx: { args: Record<string, unknown> }) => Promise<void> };

async function getSub(name: string): Promise<SubcommandRunner> {
  const subs = (wikiCommand as unknown as { subCommands: Record<string, () => Promise<unknown>> })
    .subCommands;
  const loader = subs[name];
  if (!loader) throw new Error(`subcommand not registered: ${name}`);
  return (await loader()) as SubcommandRunner;
}

async function runSub(name: string, args: Record<string, unknown>): Promise<void> {
  const cmd = await getSub(name);
  await cmd.run({ args });
}

// ── Console capture ─────────────────────────────────────────────

let stdoutLines: string[] = [];
let stderrLines: string[] = [];
const origLog = console.log;
const origErr = console.error;

function captureConsole() {
  stdoutLines = [];
  stderrLines = [];
  console.log = (...chunks: unknown[]) => {
    stdoutLines.push(chunks.map(String).join(" "));
  };
  console.error = (...chunks: unknown[]) => {
    stderrLines.push(chunks.map(String).join(" "));
  };
}

function restoreConsole() {
  console.log = origLog;
  console.error = origErr;
}

function makePage(overrides: Partial<WikiPage> = {}): WikiPage {
  const now = new Date().toISOString();
  return {
    slug: "p",
    title: "Page",
    type: "entity",
    content: "Body content.",
    tags: [],
    sources: [],
    backlinks: [],
    created: now,
    updated: now,
    ...overrides,
  };
}

const PROMOTE_MD = (slug: string, title: string) => `---
title: ${title}
type: entity
slug: ${slug}
tags: []
sources: []
backlinks: []
created: "2026-06-01T00:00:00.000Z"
updated: "2026-06-01T00:00:00.000Z"
promote: true
---
body
`;

function seedLocalEntry(projectDir: string, subdir: string, slug: string, content: string): void {
  const dir = join(projectDir, ".am-wiki", subdir);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${slug}.md`), content, "utf-8");
}

function stubProjectToml(projectDir: string): void {
  writeFileSync(join(projectDir, ".agent-manager.toml"), "# am project marker\n");
}

// ── R5: search --all-projects ───────────────────────────────────

describe("ADR-0054 R5 — am wiki search --all-projects", () => {
  let configHome: TestDir;
  let savedEnv: string | undefined;

  beforeEach(async () => {
    configHome = await createTestDir("wave-c-search-cfg-");
    savedEnv = process.env.AM_CONFIG_DIR;
    process.env.AM_CONFIG_DIR = configHome.path;
    captureConsole();
    process.exitCode = 0;
  });

  afterEach(async () => {
    restoreConsole();
    process.exitCode = 0;
    if (savedEnv === undefined) {
      // biome-ignore lint/performance/noDelete: env var cleanup
      delete process.env.AM_CONFIG_DIR;
    } else {
      process.env.AM_CONFIG_DIR = savedEnv;
    }
    await configHome.cleanup();
  });

  test("--all-projects (JSON) aggregates hits from >1 project wiki + the global store", async () => {
    const alpha = join(configHome.path, "wiki", "projects", "alpha");
    const beta = join(configHome.path, "wiki", "projects", "beta");
    const global = join(configHome.path, "wiki", "global");
    await writePage(
      makePage({ slug: "alpha-redis", title: "Redis (alpha)", content: "alpha uses redis" }),
      alpha,
    );
    await writePage(
      makePage({ slug: "beta-redis", title: "Redis (beta)", content: "beta uses redis too" }),
      beta,
    );
    await writePage(
      makePage({ slug: "global-redis", title: "Redis conventions", content: "redis naming" }),
      global,
    );

    await runSub("search", {
      query: "redis",
      json: true,
      quiet: false,
      verbose: false,
      limit: "20",
      global: false,
      "all-projects": true,
    });

    const payload = JSON.parse(stdoutLines.join("\n"));
    expect(payload.allProjects).toBe(true);
    expect(payload.query).toBe("redis");
    const projects = new Set(payload.results.map((r: { project: string }) => r.project));
    expect(projects.has("alpha")).toBe(true);
    expect(projects.has("beta")).toBe(true);
    expect(projects.has("global")).toBe(true);
    // Two distinct projects proven to contribute (the core R5 assertion).
    expect(projects.size).toBeGreaterThanOrEqual(2);
    expect(payload.total).toBeGreaterThanOrEqual(3);
  });

  test("--all-projects (JSON) returns total:0 + empty results when nothing matches", async () => {
    const alpha = join(configHome.path, "wiki", "projects", "alpha");
    await writePage(makePage({ slug: "a", content: "unrelated topic" }), alpha);

    await runSub("search", {
      query: "zzz-nonexistent-xyz",
      json: true,
      quiet: false,
      verbose: false,
      limit: "20",
      global: false,
      "all-projects": true,
    });

    const payload = JSON.parse(stdoutLines.join("\n"));
    expect(payload.allProjects).toBe(true);
    expect(payload.total).toBe(0);
    expect(payload.results).toEqual([]);
  });

  test("without --all-projects the single-tier search shape is unchanged (no project key)", async () => {
    const global = join(configHome.path, "wiki", "global");
    await writePage(
      makePage({ slug: "g", title: "Global Page", content: "kubernetes notes" }),
      global,
    );

    await runSub("search", {
      query: "kubernetes",
      json: true,
      quiet: false,
      verbose: false,
      limit: "20",
      global: true,
      "all-projects": false,
    });

    const payload = JSON.parse(stdoutLines.join("\n"));
    expect(payload.allProjects).toBeUndefined();
    expect(payload.results[0]?.project).toBeUndefined();
    expect(payload.results.map((r: { slug: string }) => r.slug)).toContain("g");
  });
});

// ── R6: publish --promote ───────────────────────────────────────

describe("ADR-0054 R6 — am wiki publish --promote", () => {
  let projectDir: TestDir;
  let configHome: TestDir;
  let savedCwd: string;
  let savedEnv: string | undefined;
  let projectName: string;

  beforeEach(async () => {
    projectDir = await createTestDir("wave-c-pub-proj-");
    configHome = await createTestDir("wave-c-pub-cfg-");
    savedEnv = process.env.AM_CONFIG_DIR;
    process.env.AM_CONFIG_DIR = configHome.path;
    savedCwd = process.cwd();
    stubProjectToml(projectDir.path);
    process.chdir(projectDir.path);
    projectName = resolveProjectName(projectDir.path);
    captureConsole();
    process.exitCode = 0;
  });

  afterEach(async () => {
    restoreConsole();
    process.chdir(savedCwd);
    process.exitCode = 0;
    if (savedEnv === undefined) {
      // biome-ignore lint/performance/noDelete: env var cleanup
      delete process.env.AM_CONFIG_DIR;
    } else {
      process.env.AM_CONFIG_DIR = savedEnv;
    }
    await projectDir.cleanup();
    await configHome.cleanup();
  });

  test("publish <slug> --promote lands in wiki/global, not the per-project mirror", async () => {
    seedLocalEntry(projectDir.path, "entities", "cross", PROMOTE_MD("cross", "Cross"));

    await runSub("publish", {
      slug: "cross",
      auto: false,
      promote: true,
      force: false,
      json: true,
      quiet: false,
      verbose: false,
    });

    const payload = JSON.parse(stdoutLines.join("\n"));
    expect(payload.promote).toBe(true);
    expect(payload.published).toEqual(["cross"]);
    expect(payload.conflicts).toEqual([]);

    expect(existsSync(join(configHome.path, "wiki", "global", "entities", "cross.md"))).toBe(true);
    expect(existsSync(join(getProjectWikiDir(projectName), "entities", "cross.md"))).toBe(false);
  });

  test("publish --auto --promote promotes promote:true entries to the global store", async () => {
    seedLocalEntry(projectDir.path, "entities", "wanted", PROMOTE_MD("wanted", "Wanted"));
    seedLocalEntry(
      projectDir.path,
      "entities",
      "skipme",
      // no promote flag
      PROMOTE_MD("skipme", "Skip").replace("promote: true\n", ""),
    );

    await runSub("publish", {
      slug: undefined,
      auto: true,
      promote: true,
      force: false,
      json: true,
      quiet: false,
      verbose: false,
    });

    const payload = JSON.parse(stdoutLines.join("\n"));
    expect(payload.promote).toBe(true);
    expect(payload.published).toEqual(["wanted"]);
    expect(existsSync(join(configHome.path, "wiki", "global", "entities", "wanted.md"))).toBe(true);
    expect(existsSync(join(configHome.path, "wiki", "global", "entities", "skipme.md"))).toBe(
      false,
    );
  });

  test("publish <slug> --promote conflict on a differing global entry → exit 1, no overwrite", async () => {
    seedLocalEntry(projectDir.path, "entities", "dup", PROMOTE_MD("dup", "Local Dup"));
    // Seed a DIFFERENT global entry at the same slug.
    const globalDir = join(configHome.path, "wiki", "global", "entities");
    mkdirSync(globalDir, { recursive: true });
    const globalFile = join(globalDir, "dup.md");
    writeFileSync(globalFile, PROMOTE_MD("dup", "Global Dup"), "utf-8");

    await runSub("publish", {
      slug: "dup",
      auto: false,
      promote: true,
      force: false,
      json: true,
      quiet: false,
      verbose: false,
    });

    expect(process.exitCode).toBe(1);
    const payload = JSON.parse(stdoutLines.join("\n"));
    expect(payload.conflicts).toEqual(["dup"]);
    expect(payload.published).toEqual([]);
    // Global entry left intact.
    expect(existsSync(globalFile)).toBe(true);
  });

  test("publish <slug> WITHOUT --promote keeps the per-project mirror (no global write)", async () => {
    seedLocalEntry(projectDir.path, "entities", "localpub", PROMOTE_MD("localpub", "Local Pub"));

    await runSub("publish", {
      slug: "localpub",
      auto: false,
      promote: false,
      force: false,
      json: true,
      quiet: false,
      verbose: false,
    });

    const payload = JSON.parse(stdoutLines.join("\n"));
    expect(payload.promote).toBe(false);
    expect(payload.published).toEqual(["localpub"]);
    expect(existsSync(join(getProjectWikiDir(projectName), "entities", "localpub.md"))).toBe(true);
    expect(existsSync(join(configHome.path, "wiki", "global", "entities", "localpub.md"))).toBe(
      false,
    );
  });
});
