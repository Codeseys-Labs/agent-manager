import { afterEach, beforeEach, describe, expect, test } from "bun:test";
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
    const { resolveMeta } = await import("../helpers/citty");
    const desc = (await resolveMeta(mod.listCommand))?.description ?? "";
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

// ─────────────────────────────────────────────────────────────────────────
// R2-2: `am list commands` had ZERO handler coverage. ADR-0058 makes commands
// the 6th catalog entity (round-trip persistence only). These tests exercise
// the real listCommand.run() handler — not the config loader — so the
// `commands` switch arm (list.ts:202-230), the singular→plural alias
// (parseEntityType, list.ts:30-31), the empty-state string (list.ts:219-222),
// and the JSON envelope shape (output({ commands }), list.ts:214-216) all stay
// covered.
//
// `--global` is passed so the handler skips resolveProjectConfig(process.cwd())
// and reads only the sandbox config.toml — otherwise a stray project config in
// the test's CWD could leak entries in.
describe("am list commands", () => {
  let dir: TestDir;
  let consoleOutput: string[];
  const origLog = console.log;
  let origConfigDir: string | undefined;

  // type-only — accessor for run() like the agents.test.ts template uses
  type RunnableCmd = { run: (ctx: { args: Record<string, unknown> }) => Promise<void> };

  async function writeCommandsConfig(commands: Config["commands"]): Promise<string> {
    dir = await createTestDir("am-list-commands-");
    const configDir = dir.path;
    await initRepo(configDir);
    const config: Config = { ...(commands ? { commands } : {}) };
    await writeConfig(join(configDir, "config.toml"), config);
    return configDir;
  }

  async function runList(args: Record<string, unknown>): Promise<void> {
    const { listCommand } = await import("../../src/commands/list");
    await (listCommand as unknown as RunnableCmd).run({
      args: { json: false, quiet: false, verbose: false, global: true, ...args },
    });
  }

  beforeEach(() => {
    consoleOutput = [];
    console.log = (...args: unknown[]) => {
      consoleOutput.push(args.map(String).join(" "));
    };
    origConfigDir = process.env.AM_CONFIG_DIR;
  });

  afterEach(async () => {
    console.log = origLog;
    if (origConfigDir !== undefined) {
      process.env.AM_CONFIG_DIR = origConfigDir;
    } else {
      Reflect.deleteProperty(process.env, "AM_CONFIG_DIR");
    }
    if (dir) await dir.cleanup();
  });

  test("entity 'commands' (plural) prints the command name + path row", async () => {
    const configDir = await writeCommandsConfig({
      deploy: {
        type: "command",
        path: ".claude/commands/deploy.md",
        description: "Deploy the app",
        tags: ["ops"],
      },
    });
    process.env.AM_CONFIG_DIR = configDir;

    await runList({ entity: "commands" });

    const out = consoleOutput.join("\n");
    expect(out).toContain("deploy");
    expect(out).toContain(".claude/commands/deploy.md");
  });

  test("entity 'command' (singular alias) prints the same row", async () => {
    const configDir = await writeCommandsConfig({
      deploy: {
        type: "command",
        path: ".claude/commands/deploy.md",
        description: "Deploy the app",
        tags: ["ops"],
      },
    });
    process.env.AM_CONFIG_DIR = configDir;

    await runList({ entity: "command" });

    const out = consoleOutput.join("\n");
    expect(out).toContain("deploy");
    expect(out).toContain(".claude/commands/deploy.md");
  });

  test("JSON envelope is { commands: [{ name, path, description, tags }] }", async () => {
    const configDir = await writeCommandsConfig({
      deploy: {
        type: "command",
        path: ".claude/commands/deploy.md",
        description: "Deploy the app",
        tags: ["ops", "ci"],
      },
    });
    process.env.AM_CONFIG_DIR = configDir;

    await runList({ entity: "commands", json: true });

    // output() writes a single JSON.stringify(data, null, 2) line.
    const parsed = JSON.parse(consoleOutput.join("\n")) as {
      commands: Array<{ name: string; path: string; description: string; tags: string[] }>;
    };
    expect(parsed.commands.length).toBe(1);
    expect(parsed.commands[0]).toEqual({
      name: "deploy",
      path: ".claude/commands/deploy.md",
      description: "Deploy the app",
      tags: ["ops", "ci"],
    });
  });

  test("empty-state: no commands configured prints 'No commands configured.'", async () => {
    const configDir = await writeCommandsConfig(undefined);
    process.env.AM_CONFIG_DIR = configDir;

    await runList({ entity: "commands" });

    expect(consoleOutput.join("\n")).toContain("No commands configured.");
  });
});
