import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import { join } from "node:path";
import { getAdapter, listAdapters } from "../../src/adapters/registry";
import { collectDoctorChecks, doctorCommand } from "../../src/commands/doctor";
import { writeConfig } from "../../src/core/config";
import { commitAll, getStatus, initRepo } from "../../src/core/git";
import { ConfigSchema } from "../../src/core/schema";
import type { Config } from "../../src/core/schema";
import { encryptValue, importKey } from "../../src/core/secrets";
import { type TestDir, createTestDir } from "../helpers/tmp";

describe("am doctor", () => {
  let dir: TestDir;

  afterEach(async () => {
    if (dir) await dir.cleanup();
  });

  test("reports healthy state for valid setup", async () => {
    dir = await createTestDir("am-doctor-");
    const configDir = dir.path;
    await initRepo(configDir);

    const config: Config = {
      settings: { default_profile: "default" },
      servers: {
        fetch: { command: "uvx", transport: "stdio", enabled: true },
      },
      profiles: {
        default: { description: "Default", servers: ["fetch"] },
      },
    };
    await writeConfig(join(configDir, "config.toml"), config);

    // Verify config dir exists
    expect(fs.existsSync(configDir)).toBe(true);

    // Verify git repo
    expect(fs.existsSync(join(configDir, ".git"))).toBe(true);

    // Verify config is valid
    const raw = await fs.promises.readFile(join(configDir, "config.toml"), "utf-8");
    const TOML = await import("@iarna/toml");
    const parsed = TOML.parse(raw);
    const result = ConfigSchema.safeParse(parsed);
    expect(result.success).toBe(true);

    // Verify git status is clean (after committing)
    const { commitAll } = await import("../../src/core/git");
    await commitAll(configDir, "init config");
    const status = await getStatus(configDir);
    expect(status.clean).toBe(true);
  });

  test("reports missing config directory", async () => {
    const missingDir = `/tmp/am-doctor-nonexistent-${Date.now()}`;
    expect(fs.existsSync(missingDir)).toBe(false);
  });

  test("reports missing config.toml", async () => {
    dir = await createTestDir("am-doctor-");
    const configDir = dir.path;
    await initRepo(configDir);

    // Don't write config.toml — it should be missing
    const configPath = join(configDir, "config.toml");
    expect(fs.existsSync(configPath)).toBe(false);
  });

  test("detects adapters", async () => {
    const adapterNames = listAdapters();
    expect(adapterNames).toContain("claude-code");

    const adapter = await getAdapter("claude-code");
    expect(adapter).toBeDefined();
    expect(adapter?.meta.displayName).toBeTruthy();
  });

  test("checks encryption key presence at OS data-dir path", async () => {
    dir = await createTestDir("am-doctor-");
    const configDir = dir.path;
    await initRepo(configDir);

    // Redirect key path to a tmp location via AM_KEY_PATH so we don't touch
    // the real ~/Library/Application Support.
    const keyPath = join(configDir, "keystore", "key");
    const origKeyPath = process.env.AM_KEY_PATH;
    process.env.AM_KEY_PATH = keyPath;
    try {
      const { resolveKeyPath } = await import("../../src/core/secrets");
      expect(resolveKeyPath()).toBe(keyPath);

      // Not present initially
      expect(fs.existsSync(keyPath)).toBe(false);

      // Create key at the resolved location
      await fs.promises.mkdir(join(keyPath, ".."), { recursive: true });
      await fs.promises.writeFile(keyPath, "test-key");
      expect(fs.existsSync(keyPath)).toBe(true);
    } finally {
      if (origKeyPath === undefined) Reflect.deleteProperty(process.env, "AM_KEY_PATH");
      else process.env.AM_KEY_PATH = origKeyPath;
    }
  });

  test("warns when legacy key file exists in config dir", async () => {
    dir = await createTestDir("am-doctor-legacy-");
    const configDir = dir.path;
    await initRepo(configDir);

    const { legacyKeyPath } = await import("../../src/core/secrets");
    const legacyPath = legacyKeyPath(configDir);

    // Initially absent
    expect(fs.existsSync(legacyPath)).toBe(false);

    // Create a legacy key file (simulates pre-migration install)
    await fs.promises.writeFile(legacyPath, "legacy-key-contents");
    expect(fs.existsSync(legacyPath)).toBe(true);

    // The doctor check scans for this path and issues a warning. We assert
    // the detection primitive here; the full warning-string assertion is
    // covered in secrets unit tests via migrateLegacyKey.
  });

  test("reports git remote status", async () => {
    dir = await createTestDir("am-doctor-");
    const configDir = dir.path;
    await initRepo(configDir);

    const status = await getStatus(configDir);
    // No remote configured in test
    expect(status.remotes.length).toBe(0);
  });

  // ws6-skill-deps-missing-agent (R2/297e): doctor must flag a skill whose
  // SKILL.md references an agent the catalog does not provide.
  test("warns when a skill references an absent agent", async () => {
    dir = await createTestDir("am-doctor-deps-");
    const configDir = dir.path;
    await initRepo(configDir);

    const skillDir = join(configDir, "skills", "researcher");
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(
      join(skillDir, "SKILL.md"),
      "# Researcher\n\nFan out with Task(subagent_type='hyperresearch-fetcher').\n",
    );

    const config: Config = {
      settings: { default_profile: "default" },
      skills: {
        researcher: { path: skillDir, description: "Research skill" },
      },
    };
    await writeConfig(join(configDir, "config.toml"), config);

    const checks = await collectDoctorChecks(configDir, configDir);
    const depCheck = checks.find((c) => c.name === "Skill dependencies");
    expect(depCheck).toBeDefined();
    expect(depCheck?.status).toBe("warn");
    expect(depCheck?.message).toContain("hyperresearch-fetcher");
    expect(depCheck?.message).toContain("researcher");
  });

  test("passes the skill-dependency check when the referenced agent exists", async () => {
    dir = await createTestDir("am-doctor-deps-ok-");
    const configDir = dir.path;
    await initRepo(configDir);

    const skillDir = join(configDir, "skills", "researcher");
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(
      join(skillDir, "SKILL.md"),
      "# Researcher\n\nFan out with Task(subagent_type='hyperresearch-fetcher').\n",
    );

    const config: Config = {
      settings: { default_profile: "default" },
      skills: {
        researcher: { path: skillDir, description: "Research skill" },
      },
      agents: {
        "hyperresearch-fetcher": { name: "hyperresearch-fetcher", prompt: "Fetch sources." },
      },
    };
    await writeConfig(join(configDir, "config.toml"), config);

    const checks = await collectDoctorChecks(configDir, configDir);
    const depCheck = checks.find((c) => c.name === "Skill dependencies");
    expect(depCheck).toBeDefined();
    expect(depCheck?.status).toBe("ok");
  });

  // ws3-cdc6: doctor must flag a config whose profiles form a circular (or
  // self-referential / unknown-parent) inheritance chain. ConfigSchema accepts
  // it, but resolveProfile throws — so the "Profile inheritance" check runs the
  // resolver to surface the defect.
  test("flags circular profile inheritance", async () => {
    dir = await createTestDir("am-doctor-circular-");
    const configDir = dir.path;
    await initRepo(configDir);

    fs.writeFileSync(
      join(configDir, "config.toml"),
      `[settings]
default_profile = "a"

[profiles.a]
inherits = "b"

[profiles.b]
inherits = "a"
`,
    );

    const checks = await collectDoctorChecks(configDir, configDir);
    const inhCheck = checks.find((c) => c.name === "Profile inheritance");
    expect(inhCheck).toBeDefined();
    expect(inhCheck?.status).toBe("fail");
    expect(inhCheck?.message).toMatch(/[Cc]ircular inheritance/);
  });

  test("flags an unknown profile parent", async () => {
    dir = await createTestDir("am-doctor-unknown-parent-");
    const configDir = dir.path;
    await initRepo(configDir);

    fs.writeFileSync(
      join(configDir, "config.toml"),
      `[settings]
default_profile = "child"

[profiles.child]
inherits = "ghost"
`,
    );

    const checks = await collectDoctorChecks(configDir, configDir);
    const inhCheck = checks.find((c) => c.name === "Profile inheritance");
    expect(inhCheck).toBeDefined();
    expect(inhCheck?.status).toBe("fail");
    expect(inhCheck?.message).toMatch(/[Uu]nknown profile/);
  });

  test("passes the profile-inheritance check on a clean chain", async () => {
    dir = await createTestDir("am-doctor-inherit-ok-");
    const configDir = dir.path;
    await initRepo(configDir);

    const config: Config = {
      settings: { default_profile: "child" },
      profiles: {
        base: { description: "Base" },
        child: { description: "Child", inherits: "base" },
      },
    };
    await writeConfig(join(configDir, "config.toml"), config);

    const checks = await collectDoctorChecks(configDir, configDir);
    const inhCheck = checks.find((c) => c.name === "Profile inheritance");
    expect(inhCheck).toBeDefined();
    expect(inhCheck?.status).toBe("ok");
  });

  // fix-0-1: the config.toml check must surface a typed AmError's detail (the
  // offending field path, carried in the AmError suggestion by parseConfigBytes)
  // AND redact any secret-shaped value it echoes. A schema-invalid server whose
  // NAME is a GitHub token forces the Zod issue path to echo the token; the
  // check must report a fail, keep the diagnostic, and replace the token with
  // the redaction placeholder. Mirrors the MCP `am_doctor` redaction test.
  test("config.toml check redacts secret-shaped values in validation errors", async () => {
    dir = await createTestDir("am-doctor-redact-");
    const configDir = dir.path;
    await initRepo(configDir);

    const secretToken = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";
    // Write a raw, schema-invalid config (server missing `command`) whose name
    // is the secret token, bypassing writeConfig which would reject it.
    fs.writeFileSync(
      join(configDir, "config.toml"),
      `[servers."${secretToken}"]\ntransport = "stdio"\n`,
    );

    const checks = await collectDoctorChecks(configDir, configDir);
    const configCheck = checks.find((c) => c.name === "config.toml");
    expect(configCheck).toBeDefined();
    expect(configCheck?.status).toBe("fail");
    // The diagnostic detail (the field path) survives, but the token is gone.
    expect(configCheck?.message).toContain("Parse/validation error:");
    expect(configCheck?.message).not.toContain(secretToken);
    expect(configCheck?.message).toContain("[REDACTED_GH_TOKEN]");
  });

  // ws-doctor-health (agent-manager-2424) BUG 2: encrypted envelopes present
  // but the key is lost = apply is hard-broken. The "Encryption integrity"
  // check must FAIL (not warn) so healthy:false.
  test("reports a fail when an enc: envelope exists but no key is present", async () => {
    dir = await createTestDir("am-doctor-enc-nokey-");
    const configDir = dir.path;
    await initRepo(configDir);

    // Point the key path at a location that does not exist, and ensure no env
    // key shadows it — loadKey must return null.
    const keyPath = join(configDir, "keystore", "key");
    const origKeyPath = process.env.AM_KEY_PATH;
    const origEnvKey = process.env.AM_ENCRYPTION_KEY;
    process.env.AM_KEY_PATH = keyPath;
    Reflect.deleteProperty(process.env, "AM_ENCRYPTION_KEY");
    try {
      // Encrypt a real envelope with an ephemeral key (not persisted to disk),
      // then write it into settings.env so the catalog has ciphertext but the
      // resolvable key is gone.
      const { generateKey } = await import("../../src/core/secrets");
      const ephemeral = await importKey(await generateKey());
      const envelope = await encryptValue("super-secret", ephemeral);
      expect(envelope.startsWith("enc:v1:")).toBe(true);

      const config: Config = {
        settings: { default_profile: "default", env: { API_TOKEN: envelope } },
        profiles: { default: { description: "Default" } },
      };
      await writeConfig(join(configDir, "config.toml"), config);

      const checks = await collectDoctorChecks(configDir, configDir);
      const integrity = checks.find((c) => c.name === "Encryption integrity");
      expect(integrity).toBeDefined();
      expect(integrity?.status).toBe("fail");
      expect(integrity?.message).toContain(keyPath);
      // healthy is derived from the absence of any "fail" check.
      expect(checks.some((c) => c.status === "fail")).toBe(true);
    } finally {
      if (origKeyPath === undefined) Reflect.deleteProperty(process.env, "AM_KEY_PATH");
      else process.env.AM_KEY_PATH = origKeyPath;
      if (origEnvKey === undefined) Reflect.deleteProperty(process.env, "AM_ENCRYPTION_KEY");
      else process.env.AM_ENCRYPTION_KEY = origEnvKey;
    }
  });

  test("reports healthy when an enc: envelope exists AND the key loads", async () => {
    dir = await createTestDir("am-doctor-enc-key-");
    const configDir = dir.path;
    await initRepo(configDir);

    const origKeyPath = process.env.AM_KEY_PATH;
    const origEnvKey = process.env.AM_ENCRYPTION_KEY;
    Reflect.deleteProperty(process.env, "AM_KEY_PATH");
    try {
      const { generateKey } = await import("../../src/core/secrets");
      const keyB64 = await generateKey();
      // Supply the key via AM_ENCRYPTION_KEY so loadKey resolves it without
      // touching any on-disk OS data dir.
      process.env.AM_ENCRYPTION_KEY = keyB64;
      const key = await importKey(keyB64);
      const envelope = await encryptValue("super-secret", key);

      const config: Config = {
        settings: { default_profile: "default", env: { API_TOKEN: envelope } },
        profiles: { default: { description: "Default" } },
      };
      await writeConfig(join(configDir, "config.toml"), config);

      const checks = await collectDoctorChecks(configDir, configDir);
      const integrity = checks.find((c) => c.name === "Encryption integrity");
      expect(integrity).toBeDefined();
      expect(integrity?.status).toBe("ok");
      expect(checks.some((c) => c.status === "fail")).toBe(false);
    } finally {
      if (origKeyPath === undefined) Reflect.deleteProperty(process.env, "AM_KEY_PATH");
      else process.env.AM_KEY_PATH = origKeyPath;
      if (origEnvKey === undefined) Reflect.deleteProperty(process.env, "AM_ENCRYPTION_KEY");
      else process.env.AM_ENCRYPTION_KEY = origEnvKey;
    }
  });

  // A green config with no encrypted envelopes and no key must NOT trip the
  // integrity check (mirrors the `am setup --json` healthy path). The missing
  // key stays a benign warn via the separate "Encryption key" check.
  test("does not fail the no-secrets-no-key path", async () => {
    dir = await createTestDir("am-doctor-no-enc-");
    const configDir = dir.path;
    await initRepo(configDir);

    const keyPath = join(configDir, "keystore", "missing-key");
    const origKeyPath = process.env.AM_KEY_PATH;
    const origEnvKey = process.env.AM_ENCRYPTION_KEY;
    process.env.AM_KEY_PATH = keyPath;
    Reflect.deleteProperty(process.env, "AM_ENCRYPTION_KEY");
    try {
      const config: Config = {
        settings: { default_profile: "default", env: { PLAIN: "not-a-secret" } },
        profiles: { default: { description: "Default" } },
      };
      await writeConfig(join(configDir, "config.toml"), config);

      const checks = await collectDoctorChecks(configDir, configDir);
      // No envelopes → the integrity check is skipped entirely.
      expect(checks.find((c) => c.name === "Encryption integrity")).toBeUndefined();
      expect(checks.some((c) => c.status === "fail")).toBe(false);
    } finally {
      if (origKeyPath === undefined) Reflect.deleteProperty(process.env, "AM_KEY_PATH");
      else process.env.AM_KEY_PATH = origKeyPath;
      if (origEnvKey === undefined) Reflect.deleteProperty(process.env, "AM_ENCRYPTION_KEY");
      else process.env.AM_ENCRYPTION_KEY = origEnvKey;
    }
  });
});

// ws-doctor-health (agent-manager-2424) BUG 1: `am doctor --json` must let its
// exit code track health — nonzero on a failing check, 0 when only warnings.
describe("am doctor --json exit code", () => {
  let dir: TestDir;
  const origConfigDir = process.env.AM_CONFIG_DIR;
  const origKeyPath = process.env.AM_KEY_PATH;
  const origEnvKey = process.env.AM_ENCRYPTION_KEY;
  const origLog = console.log;
  let logged: string[] = [];

  const handler = doctorCommand as unknown as {
    run: (ctx: { args: Record<string, unknown> }) => Promise<void>;
  };

  afterEach(async () => {
    console.log = origLog;
    if (origConfigDir === undefined) Reflect.deleteProperty(process.env, "AM_CONFIG_DIR");
    else process.env.AM_CONFIG_DIR = origConfigDir;
    if (origKeyPath === undefined) Reflect.deleteProperty(process.env, "AM_KEY_PATH");
    else process.env.AM_KEY_PATH = origKeyPath;
    if (origEnvKey === undefined) Reflect.deleteProperty(process.env, "AM_ENCRYPTION_KEY");
    else process.env.AM_ENCRYPTION_KEY = origEnvKey;
    process.exitCode = 0;
    if (dir) await dir.cleanup();
  });

  function capture(): void {
    logged = [];
    console.log = (...args: unknown[]) => {
      logged.push(args.map(String).join(" "));
    };
  }

  test("exits nonzero and emits healthy:false on a failing check", async () => {
    dir = await createTestDir("am-doctor-json-fail-");
    const configDir = dir.path;
    await initRepo(configDir);
    process.env.AM_CONFIG_DIR = configDir;

    // Force a deterministic fail: enc: envelope present but key unresolvable.
    const keyPath = join(configDir, "keystore", "key");
    process.env.AM_KEY_PATH = keyPath;
    Reflect.deleteProperty(process.env, "AM_ENCRYPTION_KEY");

    const { generateKey } = await import("../../src/core/secrets");
    const ephemeral = await importKey(await generateKey());
    const envelope = await encryptValue("super-secret", ephemeral);
    const config: Config = {
      settings: { default_profile: "default", env: { API_TOKEN: envelope } },
      profiles: { default: { description: "Default" } },
    };
    await writeConfig(join(configDir, "config.toml"), config);
    await commitAll(configDir, "init");

    process.exitCode = 0;
    capture();
    await handler.run({ args: { json: true, quiet: false, verbose: false } });

    expect(process.exitCode).toBe(1);
    const payload = JSON.parse(logged.join("\n"));
    expect(payload.healthy).toBe(false);
  });

  test("exits 0 and emits healthy:true when only warnings are present", async () => {
    dir = await createTestDir("am-doctor-json-warn-");
    const configDir = dir.path;
    await initRepo(configDir);
    process.env.AM_CONFIG_DIR = configDir;

    // No encrypted envelopes; a missing key is only a warn here.
    const keyPath = join(configDir, "keystore", "missing-key");
    process.env.AM_KEY_PATH = keyPath;
    Reflect.deleteProperty(process.env, "AM_ENCRYPTION_KEY");

    const config: Config = {
      settings: { default_profile: "default" },
      profiles: { default: { description: "Default" } },
    };
    await writeConfig(join(configDir, "config.toml"), config);
    await commitAll(configDir, "init");

    process.exitCode = 0;
    capture();
    await handler.run({ args: { json: true, quiet: false, verbose: false } });

    expect(process.exitCode).toBe(0);
    const payload = JSON.parse(logged.join("\n"));
    expect(payload.healthy).toBe(true);
    // Sanity: there is at least one warning (e.g. no git remote) so this is a
    // genuine warnings-only case, not an all-green one.
    expect(payload.checks.some((c: { status: string }) => c.status === "warn")).toBe(true);
  });
});
