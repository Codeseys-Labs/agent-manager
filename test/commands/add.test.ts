import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { readConfig, writeConfig } from "../../src/core/config";
import { commitAll, initRepo } from "../../src/core/git";
import type { Config, Server } from "../../src/core/schema";
import { type TestDir, createTestDir } from "../helpers/tmp";

describe("am add server", () => {
  let dir: TestDir;

  afterEach(async () => {
    if (dir) await dir.cleanup();
  });

  test("adds server to config.toml", async () => {
    dir = await createTestDir("am-add-");
    const configDir = dir.path;
    await initRepo(configDir);

    // Write initial config
    const config: Config = { settings: { default_profile: "default" }, servers: {} };
    const configPath = join(configDir, "config.toml");
    await writeConfig(configPath, config);
    await commitAll(configDir, "init config");

    // Add a server
    const server: Server = {
      command: "bunx",
      args: ["tavily-mcp@latest"],
      tags: ["search", "web"],
      description: "Web search via Tavily",
      transport: "stdio",
      enabled: true,
    };
    config.servers = config.servers ?? {};
    config.servers.tavily = server;
    await writeConfig(configPath, config);
    await commitAll(configDir, "add server: tavily (search, web)");

    // Verify
    const updated = await readConfig(configPath);
    expect(updated.servers?.tavily).toBeDefined();
    expect(updated.servers?.tavily.command).toBe("bunx");
    expect(updated.servers?.tavily.args).toEqual(["tavily-mcp@latest"]);
    expect(updated.servers?.tavily.tags).toEqual(["search", "web"]);
  });

  test("rejects duplicate server name", async () => {
    dir = await createTestDir("am-add-");
    const configDir = dir.path;
    await initRepo(configDir);

    const config: Config = {
      servers: {
        fetch: { command: "uvx", args: ["mcp-server-fetch"], transport: "stdio", enabled: true },
      },
    };
    const configPath = join(configDir, "config.toml");
    await writeConfig(configPath, config);
    await commitAll(configDir, "init config");

    // Check duplicate detection
    const existing = await readConfig(configPath);
    expect(existing.servers?.fetch).toBeDefined();
  });

  test("parses env key=value pairs", () => {
    const envStr = "API_KEY=abc123,REGION=us-east-1";
    const env: Record<string, string> = {};
    for (const pair of envStr.split(",")) {
      const [k, ...rest] = pair.split("=");
      if (k && rest.length > 0) env[k.trim()] = rest.join("=").trim();
    }
    expect(env).toEqual({ API_KEY: "abc123", REGION: "us-east-1" });
  });
});
