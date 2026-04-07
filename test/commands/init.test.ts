import { describe, test, expect, afterEach } from "bun:test";
import { join } from "node:path";
import { createTestDir, type TestDir } from "../helpers/tmp";
import { readConfig } from "../../src/core/config";
import * as fs from "node:fs";
import git from "isomorphic-git";

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
