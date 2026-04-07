import { describe, test, expect, afterEach } from "bun:test";
import { join } from "node:path";
import { createTestDir, type TestDir } from "../helpers/tmp";
import { writeConfig, loadResolvedConfig } from "../../src/core/config";
import { initRepo } from "../../src/core/git";
import type { Config } from "../../src/core/schema";
import type { ResolvedConfig, ResolvedServer } from "../../src/adapters/types";

function buildResolvedConfig(
  config: Awaited<ReturnType<typeof loadResolvedConfig>>,
  profileName: string,
): ResolvedConfig {
  const servers: Record<string, ResolvedServer> = {};
  for (const [name, srv] of Object.entries(config.servers ?? {})) {
    servers[name] = {
      name,
      command: srv.command,
      args: srv.args ?? [],
      env: srv.env ?? {},
      transport: srv.transport ?? "stdio",
      description: srv.description ?? "",
      tags: srv.tags ?? [],
      enabled: srv.enabled ?? true,
      adapters: (srv.adapters as Record<string, Record<string, unknown>>) ?? {},
    };
  }
  return {
    servers,
    instructions: {},
    skills: {},
    profile: profileName,
    adapters: (config.adapters as Record<string, Record<string, unknown>>) ?? {},
  };
}

describe("am apply", () => {
  let dir: TestDir;

  afterEach(async () => {
    if (dir) await dir.cleanup();
  });

  test("builds resolved config from loaded config", async () => {
    dir = await createTestDir("am-apply-");
    const configDir = dir.path;
    await initRepo(configDir);

    const config: Config = {
      settings: { default_profile: "default" },
      servers: {
        fetch: { command: "uvx", args: ["mcp-server-fetch"], tags: ["utility"], transport: "stdio", enabled: true },
        tavily: { command: "bunx", args: ["tavily-mcp@latest"], tags: ["search"], transport: "stdio", enabled: true },
      },
    };
    await writeConfig(join(configDir, "config.toml"), config);

    const loaded = await loadResolvedConfig({ configDir, configFile: "config.toml" });
    const resolved = buildResolvedConfig(loaded, "default");

    expect(Object.keys(resolved.servers)).toEqual(["fetch", "tavily"]);
    expect(resolved.servers.fetch.command).toBe("uvx");
    expect(resolved.servers.fetch.args).toEqual(["mcp-server-fetch"]);
    expect(resolved.servers.tavily.tags).toEqual(["search"]);
    expect(resolved.profile).toBe("default");
  });

  test("resolved config includes env and adapters", async () => {
    dir = await createTestDir("am-apply-");
    const configDir = dir.path;
    await initRepo(configDir);

    const config: Config = {
      servers: {
        outlook: {
          command: "aws-outlook-mcp",
          env: { MIDWAY_AUTH: "true" },
          transport: "stdio",
          enabled: true,
          adapters: { "claude-code": { always_allow: ["email_search"] } },
        },
      },
      adapters: { "claude-code": { permission_mode: "allowEdits" } },
    };
    await writeConfig(join(configDir, "config.toml"), config);

    const loaded = await loadResolvedConfig({ configDir, configFile: "config.toml" });
    const resolved = buildResolvedConfig(loaded, "work");

    expect(resolved.servers.outlook.env).toEqual({ MIDWAY_AUTH: "true" });
    expect(resolved.servers.outlook.adapters["claude-code"]).toEqual({ always_allow: ["email_search"] });
    expect(resolved.adapters["claude-code"]).toEqual({ permission_mode: "allowEdits" });
  });
});
