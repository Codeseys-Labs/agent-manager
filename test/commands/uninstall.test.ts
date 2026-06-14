import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { readConfig, writeConfig } from "../../src/core/config";
import { initRepo } from "../../src/core/git";
import type { Config } from "../../src/core/schema";
import { type TestDir, createTestDir } from "../helpers/tmp";

// Capture console output
let consoleOutput: string[] = [];
let consoleErrors: string[] = [];
const origLog = console.log;
const origError = console.error;

describe("am uninstall", () => {
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
    process.exitCode = undefined;
    if (origConfigDir !== undefined) {
      process.env.AM_CONFIG_DIR = origConfigDir;
    } else {
      Reflect.deleteProperty(process.env, "AM_CONFIG_DIR");
    }
    if (dir) await dir.cleanup();
  });

  test("removes named server from config", async () => {
    dir = await createTestDir("am-uninstall-");
    const configDir = dir.path;
    process.env.AM_CONFIG_DIR = configDir;
    await initRepo(configDir);

    const config: Config = {
      servers: {
        tavily: {
          command: "bunx",
          args: ["tavily-mcp@latest"],
          transport: "stdio",
          enabled: true,
          _registry: {
            source: "mcp-registry",
            package: "tavily-mcp",
            version: "1.0.0",
            installed_at: "2024-01-01T00:00:00Z",
          },
        },
        fetch: {
          command: "uvx",
          args: ["mcp-server-fetch"],
          transport: "stdio",
          enabled: true,
        },
      },
    };
    const configPath = join(configDir, "config.toml");
    await writeConfig(configPath, config);

    const { uninstallCommand } = await import("../../src/commands/uninstall");
    await uninstallCommand.run!({
      args: {
        name: "tavily",
        "dry-run": false,
        yes: true,
        json: false,
        quiet: false,
        verbose: false,
      } as any,
      rawArgs: [],
      cmd: uninstallCommand as any,
    });

    const updated = await readConfig(configPath);
    expect(updated.servers?.tavily).toBeUndefined();
    const allOutput = consoleOutput.join("\n");
    expect(allOutput).toContain('Removed server "tavily"');
  });

  test("returns error for non-existent server", async () => {
    dir = await createTestDir("am-uninstall-");
    const configDir = dir.path;
    process.env.AM_CONFIG_DIR = configDir;
    await initRepo(configDir);

    const config: Config = { servers: {} };
    await writeConfig(join(configDir, "config.toml"), config);

    const { uninstallCommand } = await import("../../src/commands/uninstall");
    await uninstallCommand.run!({
      args: {
        name: "nonexistent",
        "dry-run": false,
        yes: true,
        json: false,
        quiet: false,
        verbose: false,
      } as any,
      rawArgs: [],
      cmd: uninstallCommand as any,
    });

    expect(process.exitCode).toBe(1);
    const allErrors = consoleErrors.join("\n");
    expect(allErrors).toContain('"nonexistent" not found');
  });

  test("--dry-run doesn't modify config", async () => {
    dir = await createTestDir("am-uninstall-");
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
    const configPath = join(configDir, "config.toml");
    await writeConfig(configPath, config);

    const { uninstallCommand } = await import("../../src/commands/uninstall");
    await uninstallCommand.run!({
      args: {
        name: "tavily",
        "dry-run": true,
        yes: true,
        json: false,
        quiet: false,
        verbose: false,
      } as any,
      rawArgs: [],
      cmd: uninstallCommand as any,
    });

    const allOutput = consoleOutput.join("\n");
    expect(allOutput).toContain("[dry-run]");

    // Server should still be in config
    const updated = await readConfig(configPath);
    expect(updated.servers?.tavily).toBeDefined();
  });

  test("preserves other servers when removing one", async () => {
    dir = await createTestDir("am-uninstall-");
    const configDir = dir.path;
    process.env.AM_CONFIG_DIR = configDir;
    await initRepo(configDir);

    const config: Config = {
      servers: {
        tavily: { command: "bunx", args: ["tavily-mcp"], transport: "stdio", enabled: true },
        fetch: { command: "uvx", args: ["mcp-server-fetch"], transport: "stdio", enabled: true },
        outlook: { command: "outlook-mcp", transport: "stdio", enabled: false },
      },
    };
    const configPath = join(configDir, "config.toml");
    await writeConfig(configPath, config);

    const { uninstallCommand } = await import("../../src/commands/uninstall");
    await uninstallCommand.run!({
      args: {
        name: "fetch",
        "dry-run": false,
        yes: true,
        json: false,
        quiet: false,
        verbose: false,
      } as any,
      rawArgs: [],
      cmd: uninstallCommand as any,
    });

    const updated = await readConfig(configPath);
    expect(updated.servers?.fetch).toBeUndefined();
    expect(updated.servers?.tavily).toBeDefined();
    expect(updated.servers?.outlook).toBeDefined();
    expect(Object.keys(updated.servers!).length).toBe(2);
  });

  // ── Fail-closed: non-TTY destructive confirmation gate (ws5-e7f6 gap 2) ──
  // A destructive removal must NEVER proceed unconfirmed. Under `bun test`
  // stdin is non-TTY, so a run without --yes and without --json cannot prompt.
  // The command MUST refuse (exit non-zero, no mutation), not silently delete.
  // Regression guard against the previous `&& process.stdin.isTTY` gate that
  // failed OPEN (skipped the prompt and removed the server) in any non-TTY
  // context (scripts, CI, piped stdin).
  test("FAILS CLOSED: non-TTY without --yes refuses to remove (exit 1, no mutation)", async () => {
    dir = await createTestDir("am-uninstall-");
    const configDir = dir.path;
    process.env.AM_CONFIG_DIR = configDir;
    await initRepo(configDir);

    const config: Config = {
      servers: {
        tavily: { command: "bunx", args: ["tavily-mcp"], transport: "stdio", enabled: true },
      },
    };
    const configPath = join(configDir, "config.toml");
    await writeConfig(configPath, config);

    // Sanity: under bun test stdin is non-TTY (no interactive prompt possible).
    expect(Boolean(process.stdin.isTTY)).toBe(false);

    const { uninstallCommand } = await import("../../src/commands/uninstall");
    await uninstallCommand.run!({
      args: {
        name: "tavily",
        "dry-run": false,
        yes: false, // NO force flag → must fail closed under non-TTY
        json: false,
        quiet: false,
        verbose: false,
      } as any,
      rawArgs: [],
      cmd: uninstallCommand as any,
    });

    // Refused: non-zero exit and a clear message…
    expect(process.exitCode).toBe(1);
    const allErrors = consoleErrors.join("\n");
    expect(allErrors).toContain("Refusing to remove");
    expect(allErrors).toContain("--yes");
    // …and the server is STILL in the config (no destructive mutation).
    const after = await readConfig(configPath);
    expect(after.servers?.tavily).toBeDefined();
  });

  test("outputs JSON when --json is set", async () => {
    dir = await createTestDir("am-uninstall-");
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
    const configPath = join(configDir, "config.toml");
    await writeConfig(configPath, config);

    const { uninstallCommand } = await import("../../src/commands/uninstall");
    await uninstallCommand.run!({
      args: {
        name: "tavily",
        "dry-run": false,
        yes: true,
        json: true,
        quiet: false,
        verbose: false,
      } as any,
      rawArgs: [],
      cmd: uninstallCommand as any,
    });

    const jsonOut = consoleOutput.find((l) => l.includes('"action"'));
    expect(jsonOut).toBeDefined();
    const parsed = JSON.parse(jsonOut!);
    expect(parsed.action).toBe("uninstall");
    expect(parsed.server).toBe("tavily");
    expect(parsed.provenance.package).toBe("tavily-mcp");
  });
});
