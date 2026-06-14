import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import { join } from "node:path";
import git from "isomorphic-git";
import { initCommand } from "../../src/commands/init";
import { undoCommand } from "../../src/commands/undo";
import { readConfig } from "../../src/core/config";
import { log as gitLog } from "../../src/core/git";
import { type TestDir, createTestDir } from "../helpers/tmp";

describe("am init", () => {
  let dir: TestDir;

  afterEach(async () => {
    if (dir) await dir.cleanup();
  });

  test("creates config.toml and .git in config dir", async () => {
    dir = await createTestDir("am-init-");
    const configDir = dir.path;

    // Simulate init logic directly (testing the core, not the CLI runner)
    const { initRepo } = await import("../../src/core/git");
    const { writeConfig } = await import("../../src/core/config");

    await initRepo(configDir);
    const configPath = join(configDir, "config.toml");
    await writeConfig(configPath, {
      settings: { default_profile: "default" },
      servers: {},
      profiles: {
        default: { description: "Default profile — all servers" },
      },
    });

    // Verify config.toml exists and is valid
    const config = await readConfig(configPath);
    expect(config.settings?.default_profile).toBe("default");
    expect(config.profiles?.default).toBeDefined();
    expect(config.servers).toEqual({});

    // Verify .git exists
    const entries = await fs.promises.readdir(configDir, { withFileTypes: true });
    expect(entries.some((e) => e.name === ".git" && e.isDirectory())).toBe(true);
  });

  test("creates .agent-manager directory", async () => {
    dir = await createTestDir("am-init-");
    const { initRepo } = await import("../../src/core/git");
    await initRepo(dir.path);

    const entries = await fs.promises.readdir(dir.path, { withFileTypes: true });
    expect(entries.some((e) => e.name === ".agent-manager" && e.isDirectory())).toBe(true);
  });

  test("init is idempotent — detects existing config", async () => {
    dir = await createTestDir("am-init-");
    const configDir = dir.path;
    const { initRepo } = await import("../../src/core/git");
    const { writeConfig, tryReadConfig } = await import("../../src/core/config");

    await initRepo(configDir);
    const configPath = join(configDir, "config.toml");
    await writeConfig(configPath, {
      settings: { default_profile: "default" },
      servers: {},
    });

    // Second call should detect existing
    const existing = await tryReadConfig(configPath);
    expect(existing).not.toBeNull();
    expect(existing?.settings?.default_profile).toBe("default");
  });
});

// ws3 brownfield-wipe fix: the FULL `am init` handler must commit config.toml
// in the SAME single init commit, while preserving the "Nothing to undo"
// invariant immediately after init.
describe("am init — config.toml baseline commit (ws3)", () => {
  let dir: TestDir;
  let keyDir: TestDir;
  const origConfigDir = process.env.AM_CONFIG_DIR;
  const origKeyPath = process.env.AM_KEY_PATH;
  const origTTY = process.stdin.isTTY;
  const origExitCode = process.exitCode;

  beforeEach(async () => {
    dir = await createTestDir("am-init-ws3-");
    keyDir = await createTestDir("am-init-ws3-key-");
    process.env.AM_CONFIG_DIR = dir.path;
    process.env.AM_KEY_PATH = join(keyDir.path, "key");
    // Non-TTY so the interactive key/remote prompts never engage.
    process.stdin.isTTY = false;
    process.exitCode = 0;
  });

  afterEach(async () => {
    process.exitCode = origExitCode ?? 0;
    process.stdin.isTTY = origTTY;
    if (origConfigDir === undefined) Reflect.deleteProperty(process.env, "AM_CONFIG_DIR");
    else process.env.AM_CONFIG_DIR = origConfigDir;
    if (origKeyPath === undefined) Reflect.deleteProperty(process.env, "AM_KEY_PATH");
    else process.env.AM_KEY_PATH = origKeyPath;
    if (dir) await dir.cleanup();
    if (keyDir) await keyDir.cleanup();
  });

  async function runInit(): Promise<void> {
    await (initCommand as unknown as { run: (ctx: unknown) => Promise<void> }).run({
      args: { project: false, json: true, yes: true, quiet: false, verbose: false },
      cmd: initCommand,
      rawArgs: [],
      data: undefined,
    });
  }

  test("config.toml is tracked at HEAD after `am init` (single commit)", async () => {
    await runInit();

    // config.toml exists on disk.
    const configPath = join(dir.path, "config.toml");
    expect(await dir.exists("config.toml")).toBe(true);
    const config = await readConfig(configPath);
    expect(config.settings?.default_profile).toBe("default");

    // Exactly ONE commit — the baseline commit must NOT be split in two.
    const commits = await git.log({ fs, dir: dir.path, depth: 10 });
    expect(commits.length).toBe(1);

    // config.toml is in the HEAD tree (committed, not merely written to disk).
    const head = await git.resolveRef({ fs, dir: dir.path, ref: "HEAD" });
    const tracked: string[] = [];
    await git.walk({
      fs,
      dir: dir.path,
      trees: [git.TREE({ ref: head })],
      map: async (filepath, [entry]) => {
        if (entry && filepath !== "." && (await entry.type()) === "blob") tracked.push(filepath);
        return filepath;
      },
    });
    expect(tracked).toContain("config.toml");
    expect(tracked).toContain(".gitignore");
  });

  test("undo immediately after `am init` reports 'Nothing to undo'", async () => {
    await runInit();
    process.exitCode = 0;

    // The repo is at exactly one commit, so `am undo` must refuse.
    const before = await gitLog(dir.path);
    expect(before.length).toBe(1);

    await (undoCommand as unknown as { run: (ctx: unknown) => Promise<void> }).run({
      args: { apply: false, json: true, quiet: false, verbose: false },
      cmd: undoCommand,
      rawArgs: [],
      data: undefined,
    });

    // undo guards on log length < 2 → exit 1, no new commit.
    expect(process.exitCode).toBe(1);
    const after = await gitLog(dir.path);
    expect(after.length).toBe(1);
  });
});
