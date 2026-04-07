import { describe, test, expect, afterEach } from "bun:test";
import { join } from "node:path";
import { createTestDir, type TestDir } from "../helpers/tmp";
import { initRepo, commitAll, revertHead, log as gitLog } from "../../src/core/git";
import { writeConfig, readConfig } from "../../src/core/config";
import type { Config } from "../../src/core/schema";
import * as fs from "node:fs";

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
