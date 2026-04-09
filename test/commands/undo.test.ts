import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import { join } from "node:path";
import { readConfig, writeConfig } from "../../src/core/config";
import { commitAll, log as gitLog, initRepo, revertHead } from "../../src/core/git";
import type { Config } from "../../src/core/schema";
import { type TestDir, createTestDir } from "../helpers/tmp";

describe("am undo", () => {
  let dir: TestDir;

  afterEach(async () => {
    if (dir) await dir.cleanup();
  });

  test("undo creates a revert commit", async () => {
    dir = await createTestDir("am-undo-");
    const configDir = dir.path;
    await initRepo(configDir);

    // Add a server
    const config: Config = {
      servers: { fetch: { command: "uvx", transport: "stdio", enabled: true } },
    };
    await writeConfig(join(configDir, "config.toml"), config);
    await commitAll(configDir, "add server: fetch");

    // Add another server
    config.servers!.tavily = { command: "bunx", transport: "stdio", enabled: true };
    await writeConfig(join(configDir, "config.toml"), config);
    await commitAll(configDir, "add server: tavily");

    // Undo
    await revertHead(configDir);

    // Should have revert commit
    const entries = await gitLog(configDir, 1);
    expect(entries[0].message).toContain("revert");
    expect(entries[0].message).toContain("add server: tavily");

    // Config should be back to only fetch
    const reverted = await readConfig(join(configDir, "config.toml"));
    expect(reverted.servers?.fetch).toBeDefined();
    expect(reverted.servers?.tavily).toBeUndefined();
  });

  test("undo fails with only init commit", async () => {
    dir = await createTestDir("am-undo-");
    const configDir = dir.path;
    await initRepo(configDir);

    await expect(revertHead(configDir)).rejects.toThrow();
  });
});
