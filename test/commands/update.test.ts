import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { readConfig, writeConfig } from "../../src/core/config";
import { initRepo } from "../../src/core/git";
import type { Config } from "../../src/core/schema";
import type { ServerListResponse } from "../../src/registry/types";
import { type TestDir, createTestDir } from "../helpers/tmp";

// `am update` resolves provenance.package ("tavily-mcp", a short name) via the
// v0 search route, so the fetch body is a list envelope. The server name's
// trailing segment matches the short name so getPackage's segment-match picks it.
function tavilyList(version: string): ServerListResponse {
  return {
    servers: [
      {
        server: {
          name: "io.github.tavily/tavily-mcp",
          description: "Web search via Tavily",
          version,
          packages: [
            {
              registryType: "npm",
              identifier: "tavily-mcp",
              version,
              transport: { type: "stdio" },
            },
          ],
        },
        _meta: {
          "io.modelcontextprotocol.registry/official": {
            publishedAt: "2024-01-01T00:00:00Z",
            updatedAt: "2024-07-01T00:00:00Z",
            isLatest: true,
          },
        },
      },
    ],
    metadata: { count: 1 },
  };
}

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
    })) as unknown as typeof fetch;
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
      Reflect.deleteProperty(process.env, "AM_CONFIG_DIR");
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

    mockFetchResponse(tavilyList("2.0.0"));

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

    mockFetchResponse(tavilyList("2.0.0"));

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
      })) as unknown as typeof fetch;

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

    // Per-package check failures are now surfaced via warn() → stderr
    // (previously info() → stdout). Scan both streams so the assertion is
    // robust to either routing.
    const allOutput = [...consoleOutput, ...consoleErrors].join("\n");
    // Should show error for the failed server check and report it
    expect(allOutput).toContain("tavily");
    expect(allOutput).toContain("500");
  });

  // ── Fail-closed: non-TTY destructive confirmation gate (ws5-e7f6 gap 2) ──
  // Applying registry updates OVERWRITES existing server definitions in the
  // catalog. With a candidate update available, a run without --yes and without
  // --json under non-TTY stdin (the default under bun test) cannot prompt, so
  // the command MUST refuse (exit non-zero, leave the catalog untouched), not
  // silently apply. Regression guard against the previous `&& process.stdin.isTTY`
  // gate that failed OPEN in any non-TTY context (scripts, CI, piped stdin).
  test("FAILS CLOSED: non-TTY without --yes refuses to apply updates (exit 1, no mutation)", async () => {
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

    // A newer version is available → there IS a candidate that would be applied.
    mockFetchResponse(tavilyList("2.0.0"));

    // Sanity: under bun test stdin is non-TTY (no interactive prompt possible).
    expect(Boolean(process.stdin.isTTY)).toBe(false);

    const { updateCommand } = await import("../../src/commands/update");
    await updateCommand.run!({
      args: {
        "dry-run": false,
        yes: false, // NO force flag → must fail closed under non-TTY
        "no-cache": true,
        json: false,
        quiet: false,
        verbose: false,
      } as any,
      rawArgs: [],
      cmd: updateCommand as any,
    });

    // Refused: non-zero exit and a clear message…
    expect(process.exitCode).toBe(1);
    const allErrors = consoleErrors.join("\n");
    expect(allErrors).toContain("Refusing to apply");
    expect(allErrors).toContain("--yes");
    // …and the catalog version is UNCHANGED (no destructive mutation).
    const after = await readConfig(configPath);
    expect(after.servers?.tavily._registry!.version).toBe("1.0.0");
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

    mockFetchResponse(tavilyList("1.0.0"));

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
