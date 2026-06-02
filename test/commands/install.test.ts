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

function makePackage(overrides: Partial<RegistryPackage> = {}): RegistryPackage {
  return {
    name: "test-mcp",
    description: "A test MCP server",
    author: "tester",
    version: "1.0.0",
    verified: true,
    tags: ["test"],
    downloads: 100,
    created_at: "2024-01-01T00:00:00Z",
    updated_at: "2024-06-01T00:00:00Z",
    server: {
      command: "bunx",
      args: ["test-mcp@latest"],
    },
    ...overrides,
  };
}

function mockFetchResponse(data: unknown, status = 200) {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(data), {
      status,
      headers: { "Content-Type": "application/json" },
    })) as unknown as typeof fetch;
}

describe("am install", () => {
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

  test("installs a package: creates server entry with _registry provenance", async () => {
    dir = await createTestDir("am-install-");
    const configDir = dir.path;
    process.env.AM_CONFIG_DIR = configDir;
    await initRepo(configDir);

    const config: Config = { settings: { default_profile: "default" }, servers: {} };
    const configPath = join(configDir, "config.toml");
    await writeConfig(configPath, config);

    const pkg = makePackage({ name: "tavily-mcp", version: "1.2.0" });
    mockFetchResponse(pkg);

    const { installCommand } = await import("../../src/commands/install");
    await installCommand.run!({
      args: {
        packages: "tavily-mcp",
        "dry-run": false,
        yes: true,
        "no-cache": true,
        json: true,
        quiet: false,
        verbose: false,
      } as any,
      rawArgs: [],
      cmd: installCommand as any,
    });

    const updated = await readConfig(configPath);
    expect(updated.servers?.["tavily-mcp"]).toBeDefined();
    expect(updated.servers?.["tavily-mcp"].command).toBe("bunx");
    expect(updated.servers?.["tavily-mcp"]._registry).toBeDefined();
    expect(updated.servers?.["tavily-mcp"]._registry!.package).toBe("tavily-mcp");
    expect(updated.servers?.["tavily-mcp"]._registry!.version).toBe("1.2.0");
    expect(updated.servers?.["tavily-mcp"]._registry!.source).toBe("mcp-registry");
  });

  test("detects existing server and skips without --yes", async () => {
    dir = await createTestDir("am-install-");
    const configDir = dir.path;
    process.env.AM_CONFIG_DIR = configDir;
    await initRepo(configDir);

    const config: Config = {
      servers: {
        "test-mcp": {
          command: "bunx",
          args: ["test-mcp@0.9.0"],
          transport: "stdio",
          enabled: true,
        },
      },
    };
    const configPath = join(configDir, "config.toml");
    await writeConfig(configPath, config);

    mockFetchResponse(makePackage());

    const { installCommand } = await import("../../src/commands/install");
    await installCommand.run!({
      args: {
        packages: "test-mcp",
        "dry-run": false,
        yes: false,
        "no-cache": true,
        json: true,
        quiet: false,
        verbose: false,
      } as any,
      rawArgs: [],
      cmd: installCommand as any,
    });

    const jsonOut = consoleOutput.find((l) => l.includes('"action"'));
    expect(jsonOut).toBeDefined();
    const parsed = JSON.parse(jsonOut!);
    expect(parsed.results[0].action).toBe("skipped");
    expect(parsed.results[0].reason).toBe("already exists");
  });

  test("--dry-run doesn't write config", async () => {
    dir = await createTestDir("am-install-");
    const configDir = dir.path;
    process.env.AM_CONFIG_DIR = configDir;
    await initRepo(configDir);

    const config: Config = { servers: {} };
    const configPath = join(configDir, "config.toml");
    await writeConfig(configPath, config);

    mockFetchResponse(makePackage({ name: "dry-run-pkg" }));

    const { installCommand } = await import("../../src/commands/install");
    await installCommand.run!({
      args: {
        packages: "dry-run-pkg",
        "dry-run": true,
        yes: true,
        "no-cache": true,
        json: false,
        quiet: false,
        verbose: false,
      } as any,
      rawArgs: [],
      cmd: installCommand as any,
    });

    const allOutput = consoleOutput.join("\n");
    expect(allOutput).toContain("[dry-run]");

    const updated = await readConfig(configPath);
    expect(updated.servers?.["dry-run-pkg"]).toBeUndefined();
  });

  test("handles registry 404 (package not found)", async () => {
    dir = await createTestDir("am-install-");
    const configDir = dir.path;
    process.env.AM_CONFIG_DIR = configDir;
    await initRepo(configDir);

    const config: Config = { servers: {} };
    await writeConfig(join(configDir, "config.toml"), config);

    // Return 404 from registry
    globalThis.fetch = (async () =>
      new Response("Not Found", { status: 404 })) as unknown as typeof fetch;

    const { installCommand } = await import("../../src/commands/install");
    await installCommand.run!({
      args: {
        packages: "nonexistent-pkg",
        "dry-run": false,
        yes: true,
        "no-cache": true,
        json: true,
        quiet: false,
        verbose: false,
      } as any,
      rawArgs: [],
      cmd: installCommand as any,
    });

    const allErrors = consoleErrors.join("\n");
    expect(allErrors).toContain("not found");
    // BUG-3 regression: a not-found package must set a non-zero exit code so
    // `am install bogus` fails loudly for callers and CI (was exit 0).
    expect(process.exitCode).toBe(1);
  });

  test("returns the JSON failure result for a not-found package", async () => {
    dir = await createTestDir("am-install-");
    const configDir = dir.path;
    process.env.AM_CONFIG_DIR = configDir;
    await initRepo(configDir);

    await writeConfig(join(configDir, "config.toml"), { servers: {} });

    // 200 OK but null body — the registry's "package does not exist" shape.
    mockFetchResponse(null);

    const { installCommand } = await import("../../src/commands/install");
    await installCommand.run!({
      args: {
        packages: "ghost-pkg",
        "dry-run": false,
        yes: true,
        "no-cache": true,
        json: true,
        quiet: false,
        verbose: false,
      } as any,
      rawArgs: [],
      cmd: installCommand as any,
    });

    expect(process.exitCode).toBe(1);
    const jsonOut = consoleOutput.find((l) => l.includes('"action"'));
    expect(jsonOut).toBeDefined();
    const parsed = JSON.parse(jsonOut!);
    expect(parsed.results[0].action).toBe("failed");
    expect(parsed.results[0].reason).toBe("not found");
  });

  test("a registry fetch error (HTTP 500) sets a non-zero exit code", async () => {
    dir = await createTestDir("am-install-");
    const configDir = dir.path;
    process.env.AM_CONFIG_DIR = configDir;
    await initRepo(configDir);

    await writeConfig(join(configDir, "config.toml"), { servers: {} });

    // Non-404 error response — getPackage() throws a RegistryError, exercising
    // install's per-package fetch-fail branch (distinct from the 404 path).
    globalThis.fetch = (async () =>
      new Response("Internal Server Error", { status: 500 })) as unknown as typeof fetch;

    const { installCommand } = await import("../../src/commands/install");
    await installCommand.run!({
      args: {
        packages: "boom-pkg",
        "dry-run": false,
        yes: true,
        "no-cache": true,
        json: true,
        quiet: false,
        verbose: false,
      } as any,
      rawArgs: [],
      cmd: installCommand as any,
    });

    expect(process.exitCode).toBe(1);
    const jsonOut = consoleOutput.find((l) => l.includes('"action"'));
    expect(jsonOut).toBeDefined();
    const parsed = JSON.parse(jsonOut!);
    expect(parsed.results[0].action).toBe("failed");
  });

  test("sets placeholder env vars for required env in non-interactive mode", async () => {
    dir = await createTestDir("am-install-");
    const configDir = dir.path;
    process.env.AM_CONFIG_DIR = configDir;
    await initRepo(configDir);

    const config: Config = { servers: {} };
    const configPath = join(configDir, "config.toml");
    await writeConfig(configPath, config);

    const pkg = makePackage({
      name: "env-mcp",
      server: {
        command: "bunx",
        args: ["env-mcp@latest"],
        env: [
          { name: "API_KEY", description: "The API key", required: true },
          { name: "REGION", description: "AWS region", required: false, default: "us-east-1" },
        ],
      },
    });
    mockFetchResponse(pkg);

    const { installCommand } = await import("../../src/commands/install");
    await installCommand.run!({
      args: {
        packages: "env-mcp",
        "dry-run": false,
        yes: true,
        "no-cache": true,
        json: true,
        quiet: false,
        verbose: false,
      } as any,
      rawArgs: [],
      cmd: installCommand as any,
    });

    const updated = await readConfig(configPath);
    const server = updated.servers?.["env-mcp"];
    expect(server).toBeDefined();
    expect(server!.env?.API_KEY).toBe("${API_KEY}");
    expect(server!.env?.REGION).toBe("us-east-1");
  });
});
