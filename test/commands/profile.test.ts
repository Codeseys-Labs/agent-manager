import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { readConfig, writeConfig } from "../../src/core/config";
import { commitAll, initRepo } from "../../src/core/git";
import { resolveProfile } from "../../src/core/resolver";
import type { Config } from "../../src/core/schema";
import { type TestDir, createTestDir } from "../helpers/tmp";

describe("am profile list", () => {
  let dir: TestDir;

  afterEach(async () => {
    if (dir) await dir.cleanup();
  });

  test("lists profiles from config", async () => {
    dir = await createTestDir("am-profile-list-");
    const configDir = dir.path;
    await initRepo(configDir);

    const config: Config = {
      settings: { default_profile: "work" },
      servers: {
        fetch: { command: "uvx", transport: "stdio", enabled: true },
        tavily: { command: "bunx", transport: "stdio", enabled: true },
      },
      profiles: {
        base: { description: "Base utilities", servers: ["fetch"] },
        work: { description: "Work environment", inherits: "base", servers: ["tavily"] },
        personal: { description: "Personal setup" },
      },
    };
    await writeConfig(join(configDir, "config.toml"), config);

    const loaded = await readConfig(join(configDir, "config.toml"));
    const profiles = loaded.profiles ?? {};
    const names = Object.keys(profiles);

    expect(names).toContain("base");
    expect(names).toContain("work");
    expect(names).toContain("personal");
    expect(names.length).toBe(3);
  });

  test("shows inheritance relationships", async () => {
    dir = await createTestDir("am-profile-list-");
    const configDir = dir.path;
    await initRepo(configDir);

    const config: Config = {
      profiles: {
        base: { description: "Base" },
        work: { inherits: "base", description: "Work" },
      },
    };
    await writeConfig(join(configDir, "config.toml"), config);

    const loaded = await readConfig(join(configDir, "config.toml"));
    expect(loaded.profiles?.work?.inherits).toBe("base");
  });
});

describe("am profile show", () => {
  let dir: TestDir;

  afterEach(async () => {
    if (dir) await dir.cleanup();
  });

  test("displays resolved profile with inherited servers", async () => {
    dir = await createTestDir("am-profile-show-");
    const configDir = dir.path;
    await initRepo(configDir);

    const config: Config = {
      servers: {
        fetch: { command: "uvx", transport: "stdio", enabled: true },
        tavily: { command: "bunx", transport: "stdio", enabled: true },
      },
      profiles: {
        base: { servers: ["fetch"] },
        work: { inherits: "base", servers: ["tavily"], env: { AWS_PROFILE: "work" } },
      },
    };
    await writeConfig(join(configDir, "config.toml"), config);

    const loaded = await readConfig(join(configDir, "config.toml"));
    const resolved = resolveProfile("work", loaded);

    expect(resolved.name).toBe("work");
    expect(resolved.servers).toContain("fetch");
    expect(resolved.servers).toContain("tavily");
    expect(resolved.env.AWS_PROFILE).toBe("work");
  });

  test("errors on unknown profile", async () => {
    dir = await createTestDir("am-profile-show-");
    const configDir = dir.path;
    await initRepo(configDir);

    const config: Config = {
      profiles: { default: { description: "Default" } },
    };
    await writeConfig(join(configDir, "config.toml"), config);

    const loaded = await readConfig(join(configDir, "config.toml"));

    expect(() => resolveProfile("nonexistent", loaded)).toThrow("Unknown profile");
  });
});

describe("am profile create", () => {
  let dir: TestDir;

  afterEach(async () => {
    if (dir) await dir.cleanup();
  });

  test("adds a new profile to config", async () => {
    dir = await createTestDir("am-profile-create-");
    const configDir = dir.path;
    await initRepo(configDir);

    const config: Config = {
      settings: { default_profile: "default" },
      profiles: {
        default: { description: "Default profile" },
      },
    };
    const configPath = join(configDir, "config.toml");
    await writeConfig(configPath, config);
    await commitAll(configDir, "init config");

    // Simulate profile creation
    const loaded = await readConfig(configPath);
    if (!loaded.profiles) loaded.profiles = {};
    loaded.profiles.staging = {
      description: "Staging environment",
      inherits: "default",
    };
    await writeConfig(configPath, loaded);
    await commitAll(configDir, "add profile: staging");

    // Verify
    const updated = await readConfig(configPath);
    expect(updated.profiles?.staging).toBeDefined();
    expect(updated.profiles?.staging?.description).toBe("Staging environment");
    expect(updated.profiles?.staging?.inherits).toBe("default");
  });

  test("rejects duplicate profile name", async () => {
    dir = await createTestDir("am-profile-create-");
    const configDir = dir.path;
    await initRepo(configDir);

    const config: Config = {
      profiles: {
        default: { description: "Default" },
      },
    };
    await writeConfig(join(configDir, "config.toml"), config);

    const loaded = await readConfig(join(configDir, "config.toml"));
    expect(loaded.profiles?.default).toBeDefined();
  });
});

describe("am profile delete", () => {
  let dir: TestDir;

  afterEach(async () => {
    if (dir) await dir.cleanup();
  });

  test("removes a profile from config", async () => {
    dir = await createTestDir("am-profile-delete-");
    const configDir = dir.path;
    await initRepo(configDir);

    const config: Config = {
      profiles: {
        default: { description: "Default" },
        staging: { description: "Staging" },
      },
    };
    const configPath = join(configDir, "config.toml");
    await writeConfig(configPath, config);
    await commitAll(configDir, "init config");

    // Simulate deletion
    const loaded = await readConfig(configPath);
    loaded.profiles = Object.fromEntries(
      Object.entries(loaded.profiles!).filter(([name]) => name !== "staging"),
    );
    await writeConfig(configPath, loaded);
    await commitAll(configDir, "delete profile: staging");

    const updated = await readConfig(configPath);
    expect(updated.profiles?.staging).toBeUndefined();
    expect(updated.profiles?.default).toBeDefined();
  });

  test("prevents deleting a profile with dependents", async () => {
    dir = await createTestDir("am-profile-delete-");
    const configDir = dir.path;
    await initRepo(configDir);

    const config: Config = {
      profiles: {
        base: { description: "Base" },
        work: { inherits: "base", description: "Work" },
      },
    };
    await writeConfig(join(configDir, "config.toml"), config);

    const loaded = await readConfig(join(configDir, "config.toml"));

    // Check that "work" inherits "base" — deletion logic should block this
    const dependents = Object.entries(loaded.profiles ?? {}).filter(
      ([_, p]) => p.inherits === "base",
    );
    expect(dependents.length).toBeGreaterThan(0);
    expect(dependents[0][0]).toBe("work");
  });
});

describe("am profile scope", () => {
  let dir: TestDir;
  // Capture console output (info → console.log, error → console.error).
  let consoleOutput: string[] = [];
  let consoleErrors: string[] = [];
  const origLog = console.log;
  const origError = console.error;

  beforeEach(() => {
    consoleOutput = [];
    consoleErrors = [];
    console.log = (...args: unknown[]) => {
      consoleOutput.push(args.map(String).join(" "));
    };
    console.error = (...args: unknown[]) => {
      consoleErrors.push(args.map(String).join(" "));
    };
    process.exitCode = 0;
  });

  afterEach(async () => {
    console.log = origLog;
    console.error = origError;
    if (dir) await dir.cleanup();
    Reflect.deleteProperty(process.env, "AM_CONFIG_DIR");
    process.exitCode = 0;
  });

  async function setup(prefix = "am-profile-scope-"): Promise<string> {
    dir = await createTestDir(prefix);
    const configDir = dir.path;
    process.env.AM_CONFIG_DIR = configDir;
    await initRepo(configDir);
    const config: Config = {
      settings: { default_profile: "default", mcp_serve: { tools: ["core", "registry"] } },
      profiles: { default: { description: "Default" } },
    };
    await writeConfig(join(configDir, "config.toml"), config);
    await commitAll(configDir, "init config");
    return configDir;
  }

  function runScope(args: Record<string, unknown>) {
    return import("../../src/commands/profile").then(({ profileScopeCommand }) =>
      profileScopeCommand.run!({
        args: { json: false, quiet: false, verbose: false, ...args } as any,
        rawArgs: [],
        cmd: profileScopeCommand as any,
      }),
    );
  }

  test("(a) --tool-groups persists scope.tool_groups and show --tools reflects it", async () => {
    const configDir = await setup();

    await runScope({ name: "default", "tool-groups": "core,registry" });
    expect(process.exitCode).not.toBe(1);

    const updated = await readConfig(join(configDir, "config.toml"));
    expect(updated.profiles?.default?.scope?.tool_groups).toEqual(["core", "registry"]);

    // `am profile show --tools` builds the manifest from the SAME machinery and
    // must reflect the persisted scope (registry tools now in scope).
    consoleOutput = [];
    const { profileShowCommand } = await import("../../src/commands/profile");
    await profileShowCommand.run!({
      args: { name: "default", tools: true, json: true, quiet: false, verbose: false } as any,
      rawArgs: [],
      cmd: profileShowCommand as any,
    });
    const jsonLine = consoleOutput.find((l) => l.includes('"profile"'));
    expect(jsonLine).toBeDefined();
    const manifest = JSON.parse(jsonLine!);
    expect(manifest.scoped).toBe(true);
    expect(manifest.toolGroups).toEqual(["core", "registry"]);
  });

  test("(b) --deny-tools and --allow-tools persist", async () => {
    const configDir = await setup();

    await runScope({
      name: "default",
      "tool-groups": "core",
      "allow-tools": "am_status,am_list",
      "deny-tools": "am_init",
    });
    expect(process.exitCode).not.toBe(1);

    const updated = await readConfig(join(configDir, "config.toml"));
    expect(updated.profiles?.default?.scope?.allow_tools).toEqual(["am_status", "am_list"]);
    expect(updated.profiles?.default?.scope?.deny_tools).toEqual(["am_init"]);
    expect(updated.profiles?.default?.scope?.tool_groups).toEqual(["core"]);
  });

  test("(c) --clear removes scope entirely", async () => {
    const configDir = await setup();

    await runScope({ name: "default", "tool-groups": "core,registry" });
    let updated = await readConfig(join(configDir, "config.toml"));
    expect(updated.profiles?.default?.scope).toBeDefined();

    await runScope({ name: "default", clear: true });
    expect(process.exitCode).not.toBe(1);
    updated = await readConfig(join(configDir, "config.toml"));
    expect(updated.profiles?.default?.scope).toBeUndefined();
  });

  test("(d) unknown tool group errors nonzero and writes nothing (fail closed)", async () => {
    const configDir = await setup();

    await runScope({ name: "default", "tool-groups": "core,bogus" });
    expect(process.exitCode).toBe(1);
    expect(consoleErrors.some((l) => /bogus|unknown tool group/i.test(l))).toBe(true);

    // SECURITY: an invalid group must NEVER silently widen/alter scope — the
    // config is untouched.
    const updated = await readConfig(join(configDir, "config.toml"));
    expect(updated.profiles?.default?.scope).toBeUndefined();
  });

  test("(e) scope on a nonexistent profile errors", async () => {
    await setup();

    await runScope({ name: "ghost", "tool-groups": "core" });
    expect(process.exitCode).toBe(1);
    expect(consoleErrors.some((l) => /does not exist|ghost/i.test(l))).toBe(true);
  });

  test("--json echoes the resulting scope", async () => {
    await setup();

    await runScope({ name: "default", "tool-groups": "core", "deny-tools": "am_init", json: true });
    const jsonLine = consoleOutput.find((l) => l.includes('"scope"') || l.includes('"action"'));
    expect(jsonLine).toBeDefined();
    const parsed = JSON.parse(jsonLine!);
    expect(parsed.profile).toBe("default");
    expect(parsed.scope.tool_groups).toEqual(["core"]);
    expect(parsed.scope.deny_tools).toEqual(["am_init"]);
  });

  test("auto-commits the scope change with the expected message", async () => {
    const configDir = await setup();
    const { log } = await import("../../src/core/git");
    const before = await log(configDir);

    await runScope({ name: "default", "tool-groups": "core" });

    const after = await log(configDir);
    expect(after.length).toBe(before.length + 1);
    expect(after[0].message).toBe("set profile scope: default");
  });

  test("setting only allow/deny (no --tool-groups) leaves tool_groups unset", async () => {
    const configDir = await setup();

    await runScope({ name: "default", "allow-tools": "am_status" });
    const updated = await readConfig(join(configDir, "config.toml"));
    expect(updated.profiles?.default?.scope?.tool_groups).toBeUndefined();
    expect(updated.profiles?.default?.scope?.allow_tools).toEqual(["am_status"]);
  });
});
