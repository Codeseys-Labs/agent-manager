import { afterEach, describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import * as TOML from "@iarna/toml";
import { validateCommand } from "../../src/commands/config";
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

// ws3-cdc6: `am config validate` must catch profile-inheritance defects that
// ConfigSchema alone cannot — circular and self-referential `inherits` chains
// (and unknown parents) parse clean against the schema but blow up at resolve
// time. validateCommand now runs resolveProfile per profile and surfaces the
// thrown message as a validation error.
describe("am config validate — profile inheritance (ws3-cdc6)", () => {
  let dir: TestDir;
  const origConfigDir = process.env.AM_CONFIG_DIR;
  const origLog = console.log;
  let logged: string[] = [];

  const handler = validateCommand as unknown as {
    run: (ctx: { args: Record<string, unknown> }) => Promise<void>;
  };

  function capture(): void {
    logged = [];
    console.log = (...args: unknown[]) => {
      logged.push(args.map(String).join(" "));
    };
  }

  afterEach(async () => {
    console.log = origLog;
    if (origConfigDir === undefined) Reflect.deleteProperty(process.env, "AM_CONFIG_DIR");
    else process.env.AM_CONFIG_DIR = origConfigDir;
    process.exitCode = 0;
    if (dir) await dir.cleanup();
  });

  async function runValidate(configDir: string): Promise<{ valid: boolean; errors: string[] }> {
    process.env.AM_CONFIG_DIR = configDir;
    process.exitCode = 0;
    capture();
    await handler.run({ args: { json: true, quiet: false, verbose: false } });
    return JSON.parse(logged.join("\n"));
  }

  test("reports an error on mutually-circular profile inheritance", async () => {
    dir = await createTestDir("am-config-validate-circular-");
    const configDir = dir.path;
    await initRepo(configDir);

    await dir.write(
      "config.toml",
      `
[settings]
default_profile = "a"

[profiles.a]
inherits = "b"

[profiles.b]
inherits = "a"
`,
    );

    const result = await runValidate(configDir);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => /[Cc]ircular inheritance/.test(e))).toBe(true);
    expect(process.exitCode).toBe(1);
  });

  test("reports an error on self-referential profile inheritance", async () => {
    dir = await createTestDir("am-config-validate-self-");
    const configDir = dir.path;
    await initRepo(configDir);

    await dir.write(
      "config.toml",
      `
[settings]
default_profile = "loop"

[profiles.loop]
inherits = "loop"
`,
    );

    const result = await runValidate(configDir);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => /[Cc]ircular inheritance/.test(e))).toBe(true);
    expect(process.exitCode).toBe(1);
  });

  test("reports an error when a profile inherits from an unknown parent", async () => {
    dir = await createTestDir("am-config-validate-unknown-");
    const configDir = dir.path;
    await initRepo(configDir);

    await dir.write(
      "config.toml",
      `
[settings]
default_profile = "child"

[profiles.child]
inherits = "ghost"
`,
    );

    const result = await runValidate(configDir);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => /[Uu]nknown profile/.test(e))).toBe(true);
    expect(process.exitCode).toBe(1);
  });

  test("passes a clean linear inheritance chain", async () => {
    dir = await createTestDir("am-config-validate-linear-");
    const configDir = dir.path;
    await initRepo(configDir);

    await dir.write(
      "config.toml",
      `
[settings]
default_profile = "child"

[profiles.base]
description = "Base profile"

[profiles.child]
description = "Child profile"
inherits = "base"
`,
    );

    const result = await runValidate(configDir);
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
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
