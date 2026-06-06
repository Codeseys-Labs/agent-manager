/**
 * R-TEST4 — direct unit tests for controller.withConfig (the shared
 * read-modify-write write path used by CLI / MCP / web / TUI). Prior coverage
 * only exercised applyResolved; withConfig's own branches were untested:
 *
 *   - happy path: changed=true with an `updated` config → writes + commits,
 *   - changed=false → short-circuits (no write, no commit),
 *   - noCommit:true → writes but does NOT commit even with a commitMessage,
 *   - changed=true on a NULL config (file did not exist) WITHOUT `updated`
 *     → throws the "nothing to write" guard (lines ~162-166),
 *   - commitAll throwing "Nothing to commit" → swallowed (isNothingToCommitError),
 *   - commitAll throwing a REAL git error → rethrown to the caller.
 *
 * Uses a real temp config dir + real git repo (initRepo) rather than mocking
 * git, mirroring the controller-apply-* tests. The "real git error" case
 * deliberately points withConfig at a NON-repo dir so commitAll's first git
 * call (statusMatrix) fails with a non-"Nothing to commit" error — exercising
 * the rethrow arm without any module mocking (no mock.module leak risk).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { writeConfig } from "../../src/core/config";
import { withConfig } from "../../src/core/controller";
import { commitAll, initRepo, log } from "../../src/core/git";
import type { Config } from "../../src/core/schema";
import { type TestDir, createTestDir } from "../helpers/tmp";

function makeConfig(profile = "default"): Config {
  return {
    settings: { default_profile: profile },
    servers: {
      fetch: { command: "uvx", args: ["mcp-server-fetch"], transport: "stdio", enabled: true },
    },
  };
}

describe("controller.withConfig", () => {
  let dir: TestDir;
  let configPath: string;
  const originalEnv = process.env.AM_CONFIG_DIR;

  beforeEach(async () => {
    dir = await createTestDir("am-withconfig-");
    configPath = join(dir.path, "config.toml");
    process.env.AM_CONFIG_DIR = dir.path;
  });

  afterEach(async () => {
    if (originalEnv === undefined) Reflect.deleteProperty(process.env, "AM_CONFIG_DIR");
    else process.env.AM_CONFIG_DIR = originalEnv;
    await dir.cleanup();
  });

  // ── happy path: write + commit ──────────────────────────────────

  test("changed=true with `updated` writes the file and commits", async () => {
    await initRepo(dir.path);
    await writeConfig(configPath, makeConfig());
    await commitAll(dir.path, "seed: config"); // HEAD now has config.toml

    const commitsBefore = (await log(dir.path)).length;

    const updated = makeConfig("work"); // genuine change → real diff
    const result = await withConfig(dir.path, async (cfg) => {
      expect(cfg).not.toBeNull();
      return { result: "ok", changed: true, updated, commitMessage: "config: switch profile" };
    });

    expect(result).toBe("ok");
    // File was rewritten with the new profile.
    const onDisk = await dir.read("config.toml");
    expect(onDisk).toContain('default_profile = "work"');
    // A new commit landed.
    const commitsAfter = await log(dir.path);
    expect(commitsAfter.length).toBe(commitsBefore + 1);
    expect(commitsAfter[0].message).toBe("config: switch profile");
  });

  // ── changed=false short-circuits ────────────────────────────────

  test("changed=false skips both write and commit", async () => {
    await initRepo(dir.path);
    await writeConfig(configPath, makeConfig());
    await commitAll(dir.path, "seed: config");
    const before = await dir.read("config.toml");
    const commitsBefore = (await log(dir.path)).length;

    const result = await withConfig(dir.path, async () => {
      return { result: 42, changed: false, commitMessage: "should NOT be used" };
    });

    expect(result).toBe(42);
    // Untouched on disk and no new commit.
    expect(await dir.read("config.toml")).toBe(before);
    expect((await log(dir.path)).length).toBe(commitsBefore);
  });

  // ── noCommit path ───────────────────────────────────────────────

  test("noCommit:true writes the file but does not commit", async () => {
    await initRepo(dir.path);
    await writeConfig(configPath, makeConfig());
    await commitAll(dir.path, "seed: config");
    const commitsBefore = (await log(dir.path)).length;

    const result = await withConfig(
      dir.path,
      async () => ({
        result: "wrote-no-commit",
        changed: true,
        updated: makeConfig("staging"),
        commitMessage: "config: should be skipped",
      }),
      { noCommit: true },
    );

    expect(result).toBe("wrote-no-commit");
    // File updated...
    expect(await dir.read("config.toml")).toContain('default_profile = "staging"');
    // ...but NO new commit (the working tree is left dirty for a later commit).
    expect((await log(dir.path)).length).toBe(commitsBefore);
  });

  // ── guard: changed=true + null config + no `updated` ────────────

  test("changed=true with null config (no file) and no `updated` throws", async () => {
    await initRepo(dir.path);
    // No config.toml on disk → tryReadConfig returns null → callback gets null.
    await expect(
      withConfig(dir.path, async (cfg) => {
        expect(cfg).toBeNull();
        // Misuse: claim a change but provide nothing to write.
        return { result: undefined, changed: true };
      }),
    ).rejects.toThrow(/changed=true but config file did not exist/);
  });

  test("changed=true on a null config WITH `updated` writes a fresh file", async () => {
    await initRepo(dir.path);
    const created = makeConfig("brand-new");
    const result = await withConfig(dir.path, async (cfg) => {
      expect(cfg).toBeNull();
      return { result: "created", changed: true, updated: created, commitMessage: "config: init" };
    });
    expect(result).toBe("created");
    expect(await dir.exists("config.toml")).toBe(true);
    expect(await dir.read("config.toml")).toContain('default_profile = "brand-new"');
  });

  // ── isNothingToCommitError swallow ──────────────────────────────

  test("commitAll 'Nothing to commit' is swallowed (no throw)", async () => {
    await initRepo(dir.path);
    const cfg = makeConfig();
    await writeConfig(configPath, cfg);
    await commitAll(dir.path, "seed: config"); // HEAD already has this exact config

    const commitsBefore = (await log(dir.path)).length;

    // Re-writing the SAME config bytes means commitAll finds no diff and throws
    // "Nothing to commit" — which withConfig must swallow via
    // isNothingToCommitError, returning the callback result normally.
    const result = await withConfig(dir.path, async () => ({
      result: "swallowed",
      changed: true,
      updated: makeConfig(), // identical content
      commitMessage: "config: no-op rewrite",
    }));

    expect(result).toBe("swallowed");
    // No commit was created (the benign error was swallowed, not surfaced).
    expect((await log(dir.path)).length).toBe(commitsBefore);
  });

  // ── real git error rethrow ──────────────────────────────────────

  test("a non-'Nothing to commit' git error from commitAll is rethrown", async () => {
    // configDir is a real directory but NOT a git repo (no initRepo). writeConfig
    // succeeds, then commitAll's statusMatrix fails with a non-benign git error,
    // which must propagate out of withConfig.
    let caught: unknown;
    try {
      await withConfig(dir.path, async () => ({
        result: "unreached",
        changed: true,
        updated: makeConfig(),
        commitMessage: "config: will fail to commit",
      }));
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).not.toBe("Nothing to commit");
    // The file was still written before the commit attempt (write succeeds; the
    // git failure is what propagates).
    expect(await dir.exists("config.toml")).toBe(true);
  });
});
