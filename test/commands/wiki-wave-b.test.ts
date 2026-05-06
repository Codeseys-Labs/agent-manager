/**
 * ADR-0044 Wave B — `am wiki init` refactor + new `migrate`, `publish`, `pull`
 * subcommands. These tests drive each subcommand's `.run({ args })` entrypoint
 * directly (citty pattern, same as `test/commands/agent-run-guard.test.ts`).
 *
 * Key test scaffolding:
 *   - `AM_CONFIG_DIR` env override redirects the global wiki store into a tmp
 *     directory, matching the Wave A storage-level tests.
 *   - A `.agent-manager.toml` stub is written in each test project so
 *     `resolveProjectConfig(process.cwd())` finds it.
 *   - `process.chdir` is saved/restored per test so the subcommand can find
 *     the project.
 *   - Console output is captured to assert on info/warn/error emissions.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { wikiCommand } from "../../src/commands/wiki";
import { getProjectWikiDir, resolveProjectName } from "../../src/wiki/storage";
import { type TestDir, createTestDir } from "../helpers/tmp";

// ── citty introspection ─────────────────────────────────────────

type SubcommandRunner = { run: (ctx: { args: Record<string, unknown> }) => Promise<void> };

async function getSub(name: string): Promise<SubcommandRunner> {
  const subs = (wikiCommand as unknown as { subCommands: Record<string, () => Promise<unknown>> })
    .subCommands;
  const loader = subs[name];
  if (!loader) throw new Error(`subcommand not registered: ${name}`);
  const cmd = (await loader()) as SubcommandRunner;
  return cmd;
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

// ── Fixtures ────────────────────────────────────────────────────

const PAGE_MD = (slug: string, title: string, extraFrontmatter = "", body = "body") => `---
title: ${title}
type: entity
slug: ${slug}
tags: []
sources: []
backlinks: []
created: "2026-05-05T00:00:00.000Z"
updated: "2026-05-05T00:00:00.000Z"${extraFrontmatter ? `\n${extraFrontmatter}` : ""}
---
${body}
`;

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
  const dir = join(projectDir, ".am-wiki", subdir);
  mkdirSync(dir, { recursive: true });
  const filePath = join(dir, `${slug}.md`);
  writeFileSync(filePath, content, "utf-8");
  return filePath;
}

function stubProjectToml(projectDir: string): void {
  writeFileSync(join(projectDir, ".agent-manager.toml"), "# am project marker\n");
}

// ── Suite ───────────────────────────────────────────────────────

describe("ADR-0044 Wave B — wiki init/migrate/publish/pull", () => {
  let projectDir: TestDir;
  let configHome: TestDir;
  let savedCwd: string;
  let savedEnv: string | undefined;
  let projectName: string;

  beforeEach(async () => {
    projectDir = await createTestDir("adr44-wb-proj-");
    configHome = await createTestDir("adr44-wb-cfg-");
    savedEnv = process.env.AM_CONFIG_DIR;
    process.env.AM_CONFIG_DIR = configHome.path;
    savedCwd = process.cwd();
    stubProjectToml(projectDir.path);
    process.chdir(projectDir.path);
    projectName = resolveProjectName(projectDir.path);
    captureConsole();
  });

  afterEach(async () => {
    restoreConsole();
    process.chdir(savedCwd);
    if (savedEnv === undefined) process.env.AM_CONFIG_DIR = undefined;
    else process.env.AM_CONFIG_DIR = savedEnv;
    process.exitCode = 0;
    await projectDir.cleanup();
    await configHome.cleanup();
  });

  // ── init ──────────────────────────────────────────────────────

  test("init: fresh project creates .am-wiki/, AGENTS.md, and updates .gitignore", async () => {
    // Seed some global content so materialisation has something to copy.
    seedGlobalEntry(configHome.path, projectName, "entities", "alice", PAGE_MD("alice", "Alice"));

    await runSub("init", { json: false, quiet: false, verbose: false });

    expect(existsSync(join(projectDir.path, ".am-wiki"))).toBe(true);
    expect(existsSync(join(projectDir.path, ".am-wiki", "AGENTS.md"))).toBe(true);
    expect(existsSync(join(projectDir.path, ".am-wiki", "entities", "alice.md"))).toBe(true);

    const gitignore = readFileSync(join(projectDir.path, ".gitignore"), "utf-8");
    expect(gitignore).toContain(".am-wiki/");
    expect(gitignore).not.toContain(".agent-manager/wiki"); // no legacy entry on fresh init

    // Template content marker.
    const agentsMd = readFileSync(join(projectDir.path, ".am-wiki", "AGENTS.md"), "utf-8");
    expect(agentsMd).toContain("schema_version: 1.0");
  });

  test("init: JSON output uses new schema (no symlink field, includes projectWikiDir)", async () => {
    await runSub("init", { json: true, quiet: false, verbose: false });

    // Find the JSON object in stdout.
    const jsonOut = stdoutLines.join("\n");
    const parsed = JSON.parse(jsonOut);
    expect(parsed.action).toBe("init");
    expect(parsed.scope).toBe("project");
    expect(parsed.projectWikiDir).toContain(".am-wiki");
    expect(parsed.projectStoreDir).toBeDefined();
    expect("symlink" in parsed).toBe(false);
  });

  test("init: legacy layout present → deprecation warning, no rewrite", async () => {
    // Simulate legacy layout with a real directory.
    const legacyDir = join(projectDir.path, ".agent-manager", "wiki");
    mkdirSync(legacyDir, { recursive: true });
    writeFileSync(join(legacyDir, "marker.txt"), "legacy");

    await runSub("init", { json: false, quiet: false, verbose: false });

    // Legacy dir untouched.
    expect(existsSync(join(legacyDir, "marker.txt"))).toBe(true);
    // New dir NOT created.
    expect(existsSync(join(projectDir.path, ".am-wiki"))).toBe(false);
    // Warning emitted to stderr.
    const allErr = stderrLines.join("\n");
    expect(allErr).toMatch(/migrate/i);
  });

  test("init: already-initialized → idempotent info message, no overwrite", async () => {
    // Pre-create new layout and stash a marker file.
    const newDir = join(projectDir.path, ".am-wiki");
    mkdirSync(newDir, { recursive: true });
    writeFileSync(join(newDir, "MY_EDITS.md"), "hand-written");

    await runSub("init", { json: false, quiet: false, verbose: false });

    // Marker preserved.
    expect(readFileSync(join(newDir, "MY_EDITS.md"), "utf-8")).toBe("hand-written");
    const allOut = stdoutLines.join("\n");
    expect(allOut).toMatch(/already initialized/i);
  });

  // ── migrate ───────────────────────────────────────────────────

  test("migrate: nothing to migrate (clean project)", async () => {
    await runSub("migrate", { "dry-run": false, json: false, quiet: false, verbose: false });
    const allOut = stdoutLines.join("\n");
    expect(allOut).toMatch(/nothing to migrate/i);
  });

  test("migrate: already-migrated (only .am-wiki/ present)", async () => {
    mkdirSync(join(projectDir.path, ".am-wiki"), { recursive: true });

    await runSub("migrate", { "dry-run": false, json: false, quiet: false, verbose: false });
    const allOut = stdoutLines.join("\n");
    expect(allOut).toMatch(/already migrated/i);
  });

  test("migrate: real legacy directory → backs up, materialises, updates gitignore", async () => {
    // Seed legacy as a real dir.
    const legacyDir = join(projectDir.path, ".agent-manager", "wiki");
    mkdirSync(join(legacyDir, "entities"), { recursive: true });
    writeFileSync(join(legacyDir, "entities", "old.md"), "old content");
    // Seed gitignore with legacy entry.
    writeFileSync(join(projectDir.path, ".gitignore"), ".agent-manager/wiki\n");
    // Seed the global store so materialise has something to pull.
    seedGlobalEntry(configHome.path, projectName, "entities", "alice", PAGE_MD("alice", "Alice"));

    await runSub("migrate", { "dry-run": false, json: true, quiet: false, verbose: false });

    const parsed = JSON.parse(stdoutLines.join("\n"));
    expect(parsed.status).toBe("migrated");
    // ADR-0044 backup-path uses ISO timestamp YYYYMMDD-HHMMSS to avoid same-day collisions.
    expect(parsed.backupPath).toMatch(/wiki\.backup-\d{8}-\d{6}/);

    // Backup created under .agent-manager/.
    const backups = readdirSync(join(projectDir.path, ".agent-manager")).filter((n) =>
      n.startsWith("wiki.backup-"),
    );
    expect(backups.length).toBe(1);
    // Legacy content preserved in backup.
    expect(
      existsSync(join(projectDir.path, ".agent-manager", backups[0], "entities", "old.md")),
    ).toBe(true);
    // Legacy dir removed.
    expect(existsSync(legacyDir)).toBe(false);
    // New layout populated from global.
    expect(existsSync(join(projectDir.path, ".am-wiki", "entities", "alice.md"))).toBe(true);
    // Gitignore rewritten.
    const gi = readFileSync(join(projectDir.path, ".gitignore"), "utf-8");
    expect(gi).not.toContain(".agent-manager/wiki");
    expect(gi).toContain(".am-wiki/");
  });

  test("migrate: legacy symlink → unlinked (no backup), materialises", async () => {
    // Seed the global store so symlinking to it makes sense.
    seedGlobalEntry(configHome.path, projectName, "entities", "alice", PAGE_MD("alice", "Alice"));
    const projectStore = getProjectWikiDir(projectName);
    // Ensure it exists so the symlink target is real.
    mkdirSync(projectStore, { recursive: true });
    mkdirSync(join(projectDir.path, ".agent-manager"), { recursive: true });
    symlinkSync(projectStore, join(projectDir.path, ".agent-manager", "wiki"));

    await runSub("migrate", { "dry-run": false, json: true, quiet: false, verbose: false });

    const parsed = JSON.parse(stdoutLines.join("\n"));
    expect(parsed.status).toBe("migrated");
    expect(parsed.backupPath).toBeNull();
    // Symlink removed.
    expect(existsSync(join(projectDir.path, ".agent-manager", "wiki"))).toBe(false);
    // No backup dir created for symlinks.
    const amEntries = existsSync(join(projectDir.path, ".agent-manager"))
      ? readdirSync(join(projectDir.path, ".agent-manager"))
      : [];
    expect(amEntries.some((n) => n.startsWith("wiki.backup-"))).toBe(false);
    // New layout populated.
    expect(existsSync(join(projectDir.path, ".am-wiki", "entities", "alice.md"))).toBe(true);
  });

  test("migrate: --dry-run makes no filesystem changes", async () => {
    const legacyDir = join(projectDir.path, ".agent-manager", "wiki");
    mkdirSync(legacyDir, { recursive: true });
    writeFileSync(join(legacyDir, "marker.txt"), "legacy");
    seedGlobalEntry(configHome.path, projectName, "entities", "alice", PAGE_MD("alice", "Alice"));

    await runSub("migrate", { "dry-run": true, json: false, quiet: false, verbose: false });

    // Legacy dir still there.
    expect(readFileSync(join(legacyDir, "marker.txt"), "utf-8")).toBe("legacy");
    // No new dir.
    expect(existsSync(join(projectDir.path, ".am-wiki"))).toBe(false);
    // No backup dir.
    const amEntries = readdirSync(join(projectDir.path, ".agent-manager"));
    expect(amEntries.some((n) => n.startsWith("wiki.backup-"))).toBe(false);
  });

  test("migrate: both layouts present → error exit 1", async () => {
    mkdirSync(join(projectDir.path, ".agent-manager", "wiki"), { recursive: true });
    mkdirSync(join(projectDir.path, ".am-wiki"), { recursive: true });

    await runSub("migrate", { "dry-run": false, json: false, quiet: false, verbose: false });

    expect(process.exitCode).toBe(1);
    const allErr = stderrLines.join("\n");
    expect(allErr).toMatch(/both/i);
  });

  // ── publish ───────────────────────────────────────────────────

  test("publish: explicit slug copies entry to global store", async () => {
    seedLocalEntry(projectDir.path, "entities", "bob", PAGE_MD("bob", "Bob"));

    await runSub("publish", {
      slug: "bob",
      auto: false,
      force: false,
      json: true,
      quiet: false,
      verbose: false,
    });

    const parsed = JSON.parse(stdoutLines.join("\n"));
    expect(parsed.published).toEqual(["bob"]);
    expect(parsed.conflicts).toEqual([]);
    const globalPath = join(getProjectWikiDir(projectName), "entities", "bob.md");
    expect(existsSync(globalPath)).toBe(true);
  });

  test("publish: conflict (differing global) → exit 1 without overwrite", async () => {
    seedLocalEntry(
      projectDir.path,
      "entities",
      "carol",
      PAGE_MD("carol", "Carol", "", "LOCAL body"),
    );
    const globalPath = seedGlobalEntry(
      configHome.path,
      projectName,
      "entities",
      "carol",
      PAGE_MD("carol", "Carol", "", "GLOBAL body"),
    );
    const beforeBytes = readFileSync(globalPath, "utf-8");

    await runSub("publish", {
      slug: "carol",
      auto: false,
      force: false,
      json: true,
      quiet: false,
      verbose: false,
    });

    expect(process.exitCode).toBe(1);
    const parsed = JSON.parse(stdoutLines.join("\n"));
    expect(parsed.conflicts).toEqual(["carol"]);
    expect(parsed.published).toEqual([]);
    // Global unchanged.
    expect(readFileSync(globalPath, "utf-8")).toBe(beforeBytes);
  });

  test("publish: --force overrides conflict and overwrites global", async () => {
    seedLocalEntry(projectDir.path, "entities", "dan", PAGE_MD("dan", "Dan", "", "LOCAL WINS"));
    const globalPath = seedGlobalEntry(
      configHome.path,
      projectName,
      "entities",
      "dan",
      PAGE_MD("dan", "Dan", "", "OLD GLOBAL"),
    );

    await runSub("publish", {
      slug: "dan",
      auto: false,
      force: true,
      json: true,
      quiet: false,
      verbose: false,
    });

    expect(process.exitCode !== 1).toBe(true);
    const finalContent = readFileSync(globalPath, "utf-8");
    expect(finalContent).toContain("LOCAL WINS");
    expect(finalContent).not.toContain("OLD GLOBAL");
  });

  test("publish: --auto scans .am-wiki/ for entries with `promote: true`", async () => {
    // Two entries: one with promote: true, one without.
    seedLocalEntry(projectDir.path, "entities", "eve", PAGE_MD("eve", "Eve", "promote: true"));
    seedLocalEntry(projectDir.path, "entities", "frank", PAGE_MD("frank", "Frank"));

    await runSub("publish", {
      slug: undefined,
      auto: true,
      force: false,
      json: true,
      quiet: false,
      verbose: false,
    });

    const parsed = JSON.parse(stdoutLines.join("\n"));
    expect(parsed.published).toEqual(["eve"]);
    expect(parsed.conflicts).toEqual([]);
    expect(existsSync(join(getProjectWikiDir(projectName), "entities", "eve.md"))).toBe(true);
    expect(existsSync(join(getProjectWikiDir(projectName), "entities", "frank.md"))).toBe(false);
  });

  test("publish: both --auto and <slug> → error exit 1", async () => {
    mkdirSync(join(projectDir.path, ".am-wiki"), { recursive: true });
    await runSub("publish", {
      slug: "anything",
      auto: true,
      force: false,
      json: false,
      quiet: false,
      verbose: false,
    });
    expect(process.exitCode).toBe(1);
    expect(stderrLines.join("\n")).toMatch(/either --auto or/i);
  });

  // ── pull ──────────────────────────────────────────────────────

  test("pull: --all copies every global entry into .am-wiki/", async () => {
    seedGlobalEntry(configHome.path, projectName, "entities", "alice", PAGE_MD("alice", "Alice"));
    seedGlobalEntry(configHome.path, projectName, "concepts", "beta", PAGE_MD("beta", "Beta"));

    await runSub("pull", {
      slug: undefined,
      all: true,
      json: true,
      quiet: false,
      verbose: false,
    });

    const parsed = JSON.parse(stdoutLines.join("\n"));
    expect(parsed.copied.sort()).toEqual(["alice", "beta"]);
    expect(existsSync(join(projectDir.path, ".am-wiki", "entities", "alice.md"))).toBe(true);
    expect(existsSync(join(projectDir.path, ".am-wiki", "concepts", "beta.md"))).toBe(true);
  });

  test("pull: explicit slug copies only that entry", async () => {
    seedGlobalEntry(configHome.path, projectName, "entities", "alice", PAGE_MD("alice", "Alice"));
    seedGlobalEntry(configHome.path, projectName, "concepts", "beta", PAGE_MD("beta", "Beta"));

    await runSub("pull", {
      slug: "alice",
      all: false,
      json: true,
      quiet: false,
      verbose: false,
    });

    const parsed = JSON.parse(stdoutLines.join("\n"));
    expect(parsed.copied).toEqual(["alice"]);
    expect(existsSync(join(projectDir.path, ".am-wiki", "entities", "alice.md"))).toBe(true);
    expect(existsSync(join(projectDir.path, ".am-wiki", "concepts", "beta.md"))).toBe(false);
  });

  test("pull: missing slug reported in skipped (no throw, exit 0)", async () => {
    await runSub("pull", {
      slug: "ghost",
      all: false,
      json: true,
      quiet: false,
      verbose: false,
    });

    expect(process.exitCode === 1).toBe(false);
    const parsed = JSON.parse(stdoutLines.join("\n"));
    expect(parsed.copied).toEqual([]);
    expect(parsed.skipped).toEqual(["ghost"]);
  });

  test("pull: neither --all nor slug → error exit 1", async () => {
    await runSub("pull", {
      slug: undefined,
      all: false,
      json: false,
      quiet: false,
      verbose: false,
    });
    expect(process.exitCode).toBe(1);
    expect(stderrLines.join("\n")).toMatch(/either --all or/i);
  });

  // ADR-0044 Wave B post-review fix: pull into a fresh project (no prior init)
  // must seed AGENTS.md and gitignore so the layout matches `am wiki init`.
  test("pull: into fresh project (no init) seeds AGENTS.md and gitignore", async () => {
    seedGlobalEntry(configHome.path, projectName, "entities", "alice", PAGE_MD("alice", "Alice"));

    // No prior `am wiki init`. The .am-wiki dir does NOT exist yet.
    expect(existsSync(join(projectDir.path, ".am-wiki"))).toBe(false);

    await runSub("pull", {
      slug: undefined,
      all: true,
      json: false,
      quiet: false,
      verbose: false,
    });

    expect(existsSync(join(projectDir.path, ".am-wiki", "AGENTS.md"))).toBe(true);
    const gitignore = readFileSync(join(projectDir.path, ".gitignore"), "utf-8");
    expect(gitignore).toContain(".am-wiki/");
  });
});
