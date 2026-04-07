import { describe, test, expect, afterEach } from "bun:test";
import { join } from "node:path";
import { createTestDir, type TestDir } from "../helpers/tmp";
import { writeConfig, loadResolvedConfig } from "../../src/core/config";
import { initRepo, getStatus, commitAll } from "../../src/core/git";
import type { Config } from "../../src/core/schema";

describe("am status", () => {
  let dir: TestDir;

  afterEach(async () => {
    if (dir) await dir.cleanup();
  });

  test("reports clean status after init", async () => {
    dir = await createTestDir("am-status-");
    const configDir = dir.path;
    await initRepo(configDir);

    const config: Config = {
      settings: { default_profile: "default" },
      servers: {
        fetch: { command: "uvx", transport: "stdio", enabled: true },
      },
    };
    await writeConfig(join(configDir, "config.toml"), config);
    await commitAll(configDir, "init config");

    const status = await getStatus(configDir);
    expect(status.clean).toBe(true);
    expect(status.branch).toBe("main");
  });

  test("reports dirty status with uncommitted changes", async () => {
    dir = await createTestDir("am-status-");
    const configDir = dir.path;
    await initRepo(configDir);

    const config: Config = {
      settings: { default_profile: "default" },
      servers: {},
    };
    await writeConfig(join(configDir, "config.toml"), config);
    await commitAll(configDir, "init config");

    // Make a change without committing
    config.servers = { newServer: { command: "test", transport: "stdio", enabled: true } };
    await writeConfig(join(configDir, "config.toml"), config);

    const status = await getStatus(configDir);
    expect(status.clean).toBe(false);
    expect(status.dirty).toContain("config.toml");
  });

  test("reports server count correctly", async () => {
    dir = await createTestDir("am-status-");
    const configDir = dir.path;
    await initRepo(configDir);

    const config: Config = {
      servers: {
        a: { command: "a", transport: "stdio", enabled: true },
        b: { command: "b", transport: "stdio", enabled: true },
        c: { command: "c", transport: "stdio", enabled: false },
      },
    };
    await writeConfig(join(configDir, "config.toml"), config);

    const loaded = await loadResolvedConfig({ configDir, configFile: "config.toml" });
    expect(Object.keys(loaded.servers ?? {}).length).toBe(3);
  });
});
