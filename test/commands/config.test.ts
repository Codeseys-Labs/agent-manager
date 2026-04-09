import { afterEach, describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import * as TOML from "@iarna/toml";
import { loadResolvedConfig, writeConfig } from "../../src/core/config";
import { initRepo } from "../../src/core/git";
import { ConfigSchema } from "../../src/core/schema";
import type { Config } from "../../src/core/schema";
import { type TestDir, createTestDir } from "../helpers/tmp";

describe("am config validate", () => {
  let dir: TestDir;

  afterEach(async () => {
    if (dir) await dir.cleanup();
  });

  test("passes on valid config", async () => {
    dir = await createTestDir("am-config-validate-");
    const configDir = dir.path;
    await initRepo(configDir);

    const config: Config = {
      settings: { default_profile: "default" },
      servers: {
        fetch: { command: "uvx", args: ["mcp-server-fetch"], transport: "stdio", enabled: true },
      },
      profiles: {
        default: { description: "Default profile", servers: ["fetch"] },
      },
    };
    await writeConfig(join(configDir, "config.toml"), config);

    // Validate by reading and parsing through Zod
    const raw = await readFile(join(configDir, "config.toml"), "utf-8");
    const parsed = TOML.parse(raw);
    const result = ConfigSchema.safeParse(parsed);

    expect(result.success).toBe(true);
  });

  test("fails on invalid config", async () => {
    dir = await createTestDir("am-config-validate-");
    const configDir = dir.path;
    await initRepo(configDir);

    // Write invalid TOML (server missing required `command` field)
    await dir.write(
      "config.toml",
      `
[servers.bad]
transport = "stdio"
`,
    );

    const raw = await readFile(join(configDir, "config.toml"), "utf-8");
    const parsed = TOML.parse(raw);
    const result = ConfigSchema.safeParse(parsed);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.length).toBeGreaterThan(0);
    }
  });

  test("reports instruction mutual exclusivity error", async () => {
    dir = await createTestDir("am-config-validate-");
    const configDir = dir.path;
    await initRepo(configDir);

    // Both content and content_file set
    await dir.write(
      "config.toml",
      `
[instructions.bad]
content = "hello"
content_file = "file.md"
scope = "always"
`,
    );

    const raw = await readFile(join(configDir, "config.toml"), "utf-8");
    const parsed = TOML.parse(raw);
    const result = ConfigSchema.safeParse(parsed);

    expect(result.success).toBe(false);
  });
});

describe("am config show", () => {
  let dir: TestDir;

  afterEach(async () => {
    if (dir) await dir.cleanup();
  });

  test("shows raw config content", async () => {
    dir = await createTestDir("am-config-show-");
    const configDir = dir.path;
    await initRepo(configDir);

    const config: Config = {
      settings: { default_profile: "default" },
      servers: {
        fetch: { command: "uvx", transport: "stdio", enabled: true },
      },
    };
    await writeConfig(join(configDir, "config.toml"), config);

    const raw = await readFile(join(configDir, "config.toml"), "utf-8");
    expect(raw).toContain("default_profile");
    expect(raw).toContain("fetch");
  });

  test("shows resolved config after merge", async () => {
    dir = await createTestDir("am-config-show-");
    const configDir = dir.path;
    await initRepo(configDir);

    const config: Config = {
      settings: { default_profile: "default" },
      servers: {
        fetch: { command: "uvx", args: ["mcp-server-fetch"], transport: "stdio", enabled: true },
      },
    };
    await writeConfig(join(configDir, "config.toml"), config);

    // Write a local override
    await dir.write(
      "config.local.toml",
      `
[servers.local-only]
command = "local-cmd"
`,
    );

    const resolved = await loadResolvedConfig({ configDir, configFile: "config.toml" });

    expect(resolved.servers?.fetch).toBeDefined();
    expect(resolved.servers?.["local-only"]).toBeDefined();
    expect(resolved.servers?.["local-only"]?.command).toBe("local-cmd");
  });
});
