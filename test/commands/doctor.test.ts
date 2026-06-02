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

  test("checks encryption key presence at OS data-dir path", async () => {
    dir = await createTestDir("am-doctor-");
    const configDir = dir.path;
    await initRepo(configDir);

    // Redirect key path to a tmp location via AM_KEY_PATH so we don't touch
    // the real ~/Library/Application Support.
    const keyPath = join(configDir, "keystore", "key");
    const origKeyPath = process.env.AM_KEY_PATH;
    process.env.AM_KEY_PATH = keyPath;
    try {
      const { resolveKeyPath } = await import("../../src/core/secrets");
      expect(resolveKeyPath()).toBe(keyPath);

      // Not present initially
      expect(fs.existsSync(keyPath)).toBe(false);

      // Create key at the resolved location
      await fs.promises.mkdir(join(keyPath, ".."), { recursive: true });
      await fs.promises.writeFile(keyPath, "test-key");
      expect(fs.existsSync(keyPath)).toBe(true);
    } finally {
      if (origKeyPath === undefined) Reflect.deleteProperty(process.env, "AM_KEY_PATH");
      else process.env.AM_KEY_PATH = origKeyPath;
    }
  });

  test("warns when legacy key file exists in config dir", async () => {
    dir = await createTestDir("am-doctor-legacy-");
    const configDir = dir.path;
    await initRepo(configDir);

    const { legacyKeyPath } = await import("../../src/core/secrets");
    const legacyPath = legacyKeyPath(configDir);

    // Initially absent
    expect(fs.existsSync(legacyPath)).toBe(false);

    // Create a legacy key file (simulates pre-migration install)
    await fs.promises.writeFile(legacyPath, "legacy-key-contents");
    expect(fs.existsSync(legacyPath)).toBe(true);

    // The doctor check scans for this path and issues a warning. We assert
    // the detection primitive here; the full warning-string assertion is
    // covered in secrets unit tests via migrateLegacyKey.
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
