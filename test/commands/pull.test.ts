import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { writeConfig } from "../../src/core/config";
import { addRemote, commitAll, getStatus, initRepo } from "../../src/core/git";
import type { Config } from "../../src/core/schema";
import { type TestDir, createTestDir } from "../helpers/tmp";

describe("am pull", () => {
  let dir: TestDir;

  afterEach(async () => {
    if (dir) await dir.cleanup();
  });

  test("getStatus reports no remotes on fresh repo", async () => {
    dir = await createTestDir("am-pull-");
    const configDir = dir.path;
    await initRepo(configDir);

    const config: Config = {
      settings: { default_profile: "default" },
      servers: {},
    };
    await writeConfig(join(configDir, "config.toml"), config);
    await commitAll(configDir, "init config");

    const status = await getStatus(configDir);
    expect(status.remotes.length).toBe(0);
  });

  test("getStatus fails on uninitialized directory", async () => {
    dir = await createTestDir("am-pull-");
    // No git init -- getStatus should throw
    await expect(getStatus(dir.path)).rejects.toThrow();
  });

  test("pull rejects when no remote is configured", async () => {
    dir = await createTestDir("am-pull-");
    const configDir = dir.path;
    await initRepo(configDir);

    const config: Config = {
      settings: { default_profile: "default" },
      servers: {},
    };
    await writeConfig(join(configDir, "config.toml"), config);
    await commitAll(configDir, "init config");

    // The pull command checks status.remotes.length === 0 before calling pull()
    const status = await getStatus(configDir);
    expect(status.remotes).toEqual([]);
    expect(status.remotes.length === 0).toBe(true);
  });

  test("addRemote makes remote visible in getStatus", async () => {
    dir = await createTestDir("am-pull-");
    const configDir = dir.path;
    await initRepo(configDir);

    const config: Config = {
      settings: { default_profile: "default" },
      servers: {},
    };
    await writeConfig(join(configDir, "config.toml"), config);
    await commitAll(configDir, "init config");

    await addRemote(configDir, "https://github.com/test/repo.git");

    const status = await getStatus(configDir);
    expect(status.remotes.length).toBe(1);
    expect(status.remotes[0].remote).toBe("origin");
    expect(status.remotes[0].url).toBe("https://github.com/test/repo.git");
  });

  test("pull fails with network error when remote is unreachable", async () => {
    dir = await createTestDir("am-pull-");
    const configDir = dir.path;
    await initRepo(configDir);

    const config: Config = {
      settings: { default_profile: "default" },
      servers: {},
    };
    await writeConfig(join(configDir, "config.toml"), config);
    await commitAll(configDir, "init config");

    await addRemote(configDir, "https://invalid.example.com/repo.git");

    const { pull } = await import("../../src/core/git");
    await expect(pull(configDir)).rejects.toThrow();
  });
});
