import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { readConfig, writeConfig } from "../../src/core/config";
import { initRepo } from "../../src/core/git";
import type { Config } from "../../src/core/schema";
import type { RegistryPackage } from "../../src/registry/types";
import { type TestDir, createTestDir } from "../helpers/tmp";

let consoleOutput: string[] = [];
let consoleErrors: string[] = [];
const origLog = console.log;
const origError = console.error;
const origFetch = globalThis.fetch;

function mockFetchResponse(data: unknown, status = 200) {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(data), {
      status,
      headers: { "Content-Type": "application/json" },
    })) as typeof fetch;
}

describe("am update", () => {
  let dir: TestDir;
  let origConfigDir: string | undefined;

  beforeEach(async () => {
    consoleOutput = [];
    consoleErrors = [];
    console.log = (...args: unknown[]) => {
      consoleOutput.push(args.map(String).join(" "));
    };
    console.error = (...args: unknown[]) => {
      consoleErrors.push(args.map(String).join(" "));
    };
    process.exitCode = undefined;
    origConfigDir = process.env.AM_CONFIG_DIR;
  });

  afterEach(async () => {
    console.log = origLog;
    console.error = origError;
    globalThis.fetch = origFetch;
    process.exitCode = undefined;
    if (origConfigDir !== undefined) {
      process.env.AM_CONFIG_DIR = origConfigDir;
    } else {
      process.env.AM_CONFIG_DIR = undefined;
    }
    if (dir) await dir.cleanup();
  });

  test("detects available updates for registry-installed servers", async () => {
    dir = await createTestDir("am-update-");
    const configDir = dir.path;
    process.env.AM_CONFIG_DIR = configDir;
    await initRepo(configDir);

    const config: Config = {
      servers: {
        tavily: {
          command: "bunx",
          args: ["tavily-mcp@1.0.0"],
          transport: "stdio",
          enabled: true,
          _registry: {
            source: "mcp-registry",
            package: "tavily-mcp",
            version: "1.0.0",
            installed_at: "2024-01-01T00:00:00Z",
          },
        },
      },
    };
    const configPath = join(configDir, "config.toml");
    await writeConfig(configPath, config);

    const newerPkg: RegistryPackage = {
      name: "tavily-mcp",
      description: "Web search via Tavily",
      author: "tavily",
      version: "2.0.0",
      verified: true,
      tags: ["search"],
      downloads: 5000,
      created_at: "2024-01-01T00:00:00Z",
      updated_at: "2024-07-01T00:00:00Z",
      server: { command: "bunx", args: ["tavily-mcp@2.0.0"] },
    };
    mockFetchResponse(newerPkg);

    const { updateCommand } = await import("../../src/commands/update");
    await updateCommand.run!({
      args: {
        "dry-run": false,
        yes: true,
        "no-cache": true,
        json: true,
        quiet: false,
        verbose: false,
      } as any,
      rawArgs: [],
      cmd: updateCommand as any,
    });

    const jsonOut = consoleOutput.find((l) => l.includes('"action"'));
    expect(jsonOut).toBeDefined();
    const parsed = JSON.parse(jsonOut!);
    expect(parsed.action).toBe("update");
    expect(parsed.updates.length).toBe(1);
    expect(parsed.updates[0].currentVersion).toBe("1.0.0");
    expect(parsed.updates[0].latestVersion).toBe("2.0.0");

    const updated = await readConfig(configPath);
    expect(updated.servers?.tavily._registry!.version).toBe("2.0.0");
  });

  test("skips servers without _registry metadata", async () => {
    dir = await createTestDir("am-update-");
    const configDir = dir.path;
    process.env.AM_CONFIG_DIR = configDir;
    await initRepo(configDir);

    const config: Config = {
      servers: {
        manual: {
          command: "uvx",
          args: ["manual-server"],
          transport: "stdio",
          enabled: true,
        },
      },
    };
    await writeConfig(join(configDir, "config.toml"), config);

    const { updateCommand } = await import("../../src/commands/update");
    await updateCommand.run!({
      args: {
        "dry-run": false,
        yes: true,
        "no-cache": true,
        json: false, // Use non-json so info() messages are visible
        quiet: false,
        verbose: false,
      } as any,
      rawArgs: [],
      cmd: updateCommand as any,
    });

    const allOutput = consoleOutput.join("\n");
    expect(allOutput).toContain("No registry-installed servers found");
  });

  test("--dry-run shows updates without applying", async () => {
    dir = await createTestDir("am-update-");
    const configDir = dir.path;
    process.env.AM_CONFIG_DIR = configDir;
    await initRepo(configDir);

    const config: Config = {
      servers: {
        tavily: {
          command: "bunx",
          args: ["tavily-mcp@1.0.0"],
          transport: "stdio",
          enabled: true,
          _registry: {
            source: "mcp-registry",
            package: "tavily-mcp",
            version: "1.0.0",
            installed_at: "2024-01-01T00:00:00Z",
          },
        },
      },
    };
    const configPath = join(configDir, "config.toml");
    await writeConfig(configPath, config);

    mockFetchResponse({
      name: "tavily-mcp",
      description: "Web search",
      author: "tavily",
      version: "2.0.0",
      verified: true,
      tags: ["search"],
      created_at: "2024-01-01T00:00:00Z",
      updated_at: "2024-07-01T00:00:00Z",
      server: { command: "bunx", args: ["tavily-mcp@2.0.0"] },
    } as RegistryPackage);

    const { updateCommand } = await import("../../src/commands/update");
    await updateCommand.run!({
      args: {
        "dry-run": true,
        yes: true,
        "no-cache": true,
        json: false,
        quiet: false,
        verbose: false,
      } as any,
      rawArgs: [],
      cmd: updateCommand as any,
    });

    const allOutput = consoleOutput.join("\n");
    expect(allOutput).toContain("1 update(s) available");

    const unchanged = await readConfig(configPath);
    expect(unchanged.servers?.tavily._registry!.version).toBe("1.0.0");
  });

  test("handles registry unreachable gracefully", async () => {
    dir = await createTestDir("am-update-");
    const configDir = dir.path;
    process.env.AM_CONFIG_DIR = configDir;
    await initRepo(configDir);

    const config: Config = {
      servers: {
        tavily: {
          command: "bunx",
          transport: "stdio",
          enabled: true,
          _registry: {
            source: "mcp-registry",
            package: "tavily-mcp",
            version: "1.0.0",
            installed_at: "2024-01-01T00:00:00Z",
          },
        },
      },
    };
    await writeConfig(join(configDir, "config.toml"), config);

    // Return HTTP 500 to trigger RegistryError immediately (no retry delays like network errors)
    globalThis.fetch = (async () =>
      new Response("Internal Server Error", {
        status: 500,
        statusText: "Internal Server Error",
      })) as typeof fetch;

    const { updateCommand } = await import("../../src/commands/update");
    await updateCommand.run!({
      args: {
        "dry-run": false,
        yes: true,
        "no-cache": true,
        json: false,
        quiet: false,
        verbose: false,
      } as any,
      rawArgs: [],
      cmd: updateCommand as any,
    });

    const allOutput = consoleOutput.join("\n");
    // Should show error for the failed server check and report it
    expect(allOutput).toContain("tavily");
    expect(allOutput).toContain("500");
  });

  test("reports all servers up to date when versions match", async () => {
    dir = await createTestDir("am-update-");
    const configDir = dir.path;
    process.env.AM_CONFIG_DIR = configDir;
    await initRepo(configDir);

    const config: Config = {
      servers: {
        tavily: {
          command: "bunx",
          transport: "stdio",
          enabled: true,
          _registry: {
            source: "mcp-registry",
            package: "tavily-mcp",
            version: "1.0.0",
            installed_at: "2024-01-01T00:00:00Z",
          },
        },
      },
    };
    await writeConfig(join(configDir, "config.toml"), config);

    mockFetchResponse({
      name: "tavily-mcp",
      description: "Same version",
      author: "tavily",
      version: "1.0.0",
      verified: true,
      tags: [],
      created_at: "2024-01-01T00:00:00Z",
      updated_at: "2024-01-01T00:00:00Z",
      server: { command: "bunx", args: ["tavily-mcp@1.0.0"] },
    } as RegistryPackage);

    const { updateCommand } = await import("../../src/commands/update");
    await updateCommand.run!({
      args: {
        "dry-run": false,
        yes: true,
        "no-cache": true,
        json: false,
        quiet: false,
        verbose: false,
      } as any,
      rawArgs: [],
      cmd: updateCommand as any,
    });

    const allOutput = consoleOutput.join("\n");
    expect(allOutput).toContain("up to date");
  });
});
