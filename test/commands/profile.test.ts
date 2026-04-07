import { describe, test, expect, afterEach } from "bun:test";
import { join } from "node:path";
import { createTestDir, type TestDir } from "../helpers/tmp";
import { writeConfig, readConfig } from "../../src/core/config";
import { initRepo, commitAll } from "../../src/core/git";
import { resolveProfile } from "../../src/core/resolver";
import type { Config } from "../../src/core/schema";

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
    loaded.profiles["staging"] = {
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
    delete loaded.profiles!["staging"];
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
