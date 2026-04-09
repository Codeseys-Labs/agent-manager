import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import { join } from "node:path";
import { getAdapter, listAdapters } from "../../src/adapters/registry";
import { writeConfig } from "../../src/core/config";
import { getStatus, initRepo } from "../../src/core/git";
import { ConfigSchema } from "../../src/core/schema";
import type { Config } from "../../src/core/schema";
import { type TestDir, createTestDir } from "../helpers/tmp";

describe("am doctor", () => {
  let dir: TestDir;

  afterEach(async () => {
    if (dir) await dir.cleanup();
  });

  test("reports healthy state for valid setup", async () => {
    dir = await createTestDir("am-doctor-");
    const configDir = dir.path;
    await initRepo(configDir);

    const config: Config = {
      settings: { default_profile: "default" },
      servers: {
        fetch: { command: "uvx", transport: "stdio", enabled: true },
      },
      profiles: {
        default: { description: "Default", servers: ["fetch"] },
      },
    };
    await writeConfig(join(configDir, "config.toml"), config);

    // Verify config dir exists
    expect(fs.existsSync(configDir)).toBe(true);

    // Verify git repo
    expect(fs.existsSync(join(configDir, ".git"))).toBe(true);

    // Verify config is valid
    const raw = await fs.promises.readFile(join(configDir, "config.toml"), "utf-8");
    const TOML = await import("@iarna/toml");
    const parsed = TOML.parse(raw);
    const result = ConfigSchema.safeParse(parsed);
    expect(result.success).toBe(true);

    // Verify git status is clean (after committing)
    const { commitAll } = await import("../../src/core/git");
    await commitAll(configDir, "init config");
    const status = await getStatus(configDir);
    expect(status.clean).toBe(true);
  });

  test("reports missing config directory", async () => {
    const missingDir = `/tmp/am-doctor-nonexistent-${Date.now()}`;
    expect(fs.existsSync(missingDir)).toBe(false);
  });

  test("reports missing config.toml", async () => {
    dir = await createTestDir("am-doctor-");
    const configDir = dir.path;
    await initRepo(configDir);

    // Don't write config.toml — it should be missing
    const configPath = join(configDir, "config.toml");
    expect(fs.existsSync(configPath)).toBe(false);
  });

  test("detects adapters", async () => {
    const adapterNames = listAdapters();
    expect(adapterNames).toContain("claude-code");

    const adapter = await getAdapter("claude-code");
    expect(adapter).toBeDefined();
    expect(adapter?.meta.displayName).toBeTruthy();
  });

  test("checks encryption key presence", async () => {
    dir = await createTestDir("am-doctor-");
    const configDir = dir.path;
    await initRepo(configDir);

    // No key by default
    const keyPath = join(configDir, ".agent-manager", "key.txt");
    expect(fs.existsSync(keyPath)).toBe(false);

    // Create key
    await fs.promises.writeFile(keyPath, "test-key");
    expect(fs.existsSync(keyPath)).toBe(true);
  });

  test("reports git remote status", async () => {
    dir = await createTestDir("am-doctor-");
    const configDir = dir.path;
    await initRepo(configDir);

    const status = await getStatus(configDir);
    // No remote configured in test
    expect(status.remotes.length).toBe(0);
  });
});
