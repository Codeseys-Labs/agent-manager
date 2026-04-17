import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { loadResolvedConfig, writeConfig } from "../../src/core/config";
import { initRepo } from "../../src/core/git";
import type { Config } from "../../src/core/schema";
import { type TestDir, createTestDir } from "../helpers/tmp";

describe("am list servers", () => {
  let dir: TestDir;

  afterEach(async () => {
    if (dir) await dir.cleanup();
  });

  test("lists servers from config", async () => {
    dir = await createTestDir("am-list-");
    const configDir = dir.path;
    await initRepo(configDir);

    const config: Config = {
      servers: {
        fetch: {
          command: "uvx",
          args: ["mcp-server-fetch"],
          tags: ["utility"],
          transport: "stdio",
          enabled: true,
        },
        tavily: {
          command: "bunx",
          args: ["tavily-mcp@latest"],
          tags: ["search"],
          transport: "stdio",
          enabled: true,
        },
        outlook: {
          command: "aws-outlook-mcp",
          tags: ["email", "work"],
          transport: "stdio",
          enabled: false,
        },
      },
    };
    await writeConfig(join(configDir, "config.toml"), config);

    const loaded = await loadResolvedConfig({
      configDir,
      configFile: "config.toml",
    });

    const servers = loaded.servers ?? {};
    const entries = Object.entries(servers);
    expect(entries.length).toBe(3);

    const names = entries.map(([name]) => name);
    expect(names).toContain("fetch");
    expect(names).toContain("tavily");
    expect(names).toContain("outlook");
  });

  test("top-level description points at `am agent list` for the unified view", async () => {
    // ADR-0031 M2: `am list agents` returns the config slice only.
    // The canonical full-roster view lives at `am agent list`. The help
    // text must disambiguate so users never get surprised.
    const mod = await import("../../src/commands/list");
    const desc = mod.listCommand.meta?.description ?? "";
    expect(desc).toContain("am agent list");
  });

  test("returns empty when no servers configured", async () => {
    dir = await createTestDir("am-list-");
    const configDir = dir.path;
    await initRepo(configDir);

    const config: Config = { settings: { default_profile: "default" } };
    await writeConfig(join(configDir, "config.toml"), config);

    const loaded = await loadResolvedConfig({
      configDir,
      configFile: "config.toml",
    });

    const servers = loaded.servers ?? {};
    expect(Object.keys(servers).length).toBe(0);
  });
});
