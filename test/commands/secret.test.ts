import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { secretCommand } from "../../src/commands/secret";
import { readConfig, writeConfig } from "../../src/core/config";
import { initRepo } from "../../src/core/git";
import type { Config } from "../../src/core/schema";
import {
  decryptValue,
  generateKey,
  importKey,
  isEncrypted,
  loadKey,
  saveKey,
} from "../../src/core/secrets";
import { type TestDir, createTestDir } from "../helpers/tmp";

// Helper: set up a test config dir with init + key
async function setupConfigDir(
  dir: TestDir,
): Promise<{ configDir: string; configPath: string; base64Key: string }> {
  const configDir = dir.path;
  await initRepo(configDir);
  const configPath = join(configDir, "config.toml");
  const config: Config = {
    settings: { default_profile: "default" },
    servers: {
      tavily: {
        command: "bunx",
        args: ["tavily-mcp@latest"],
        transport: "stdio",
        enabled: true,
        env: { TAVILY_API_KEY: "plain-key" },
      },
    },
    profiles: {
      default: { description: "Default profile" },
    },
  };
  await writeConfig(configPath, config);

  const base64Key = await generateKey();
  await saveKey(configDir, base64Key);

  return { configDir, configPath, base64Key };
}

describe("am secret", () => {
  let dir: TestDir;
  let keyDir: TestDir;
  const origEnv: Record<string, string | undefined> = {};

  function setEnv(key: string, value: string) {
    origEnv[key] = process.env[key];
    process.env[key] = value;
  }

  beforeEach(async () => {
    // Redirect master-key writes to a tmp dir so tests never touch ~/.
    keyDir = await createTestDir("am-secret-keydir-");
    setEnv("AM_KEY_PATH", join(keyDir.path, "key"));
  });

  afterEach(async () => {
    if (dir) await dir.cleanup();
    if (keyDir) await keyDir.cleanup();
    for (const [key, value] of Object.entries(origEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    for (const key of Object.keys(origEnv)) {
      delete origEnv[key];
    }
  });

  describe("generate-key", () => {
    test("creates key file at AM_KEY_PATH location", async () => {
      dir = await createTestDir("am-secret-genkey-");
      await initRepo(dir.path);

      const base64 = await generateKey();
      await saveKey(dir.path, base64);

      const loaded = await loadKey(dir.path);
      expect(loaded).not.toBeNull();

      const keyPath = process.env.AM_KEY_PATH!;
      const keyContents = await readFile(keyPath, "utf-8");
      expect(keyContents.trim()).toBe(base64);
    });

    // L5 (ws W-l5-secret-genkey): `am secret generate-key` must NOT leak the raw
    // base64 master key into shell history / logs / captured JSON by default.
    // The raw key is only emitted when --show-key is explicitly passed.
    describe("does not leak the raw master key by default", () => {
      const origConfigDir = process.env.AM_CONFIG_DIR;
      const origLog = console.log;
      let logged: string[] = [];

      // Reach the `generate-key` subcommand handler off the parent command's
      // lazy subCommands map (same pattern as the scan tests above).
      async function resolveGenerateKey(): Promise<{
        run: (ctx: { args: Record<string, unknown> }) => Promise<void>;
      }> {
        const subCommands = secretCommand.subCommands as unknown as Record<
          string,
          () => Promise<unknown>
        >;
        const gen = await subCommands["generate-key"]();
        return gen as { run: (ctx: { args: Record<string, unknown> }) => Promise<void> };
      }

      function capture(): void {
        logged = [];
        console.log = (...args: unknown[]) => {
          logged.push(args.map(String).join(" "));
        };
      }

      afterEach(() => {
        console.log = origLog;
        if (origConfigDir === undefined) Reflect.deleteProperty(process.env, "AM_CONFIG_DIR");
        else process.env.AM_CONFIG_DIR = origConfigDir;
      });

      test("--json (no --show-key) omits the key and reports the path + keyShown:false", async () => {
        dir = await createTestDir("am-secret-genkey-json-noshow-");
        const configDir = dir.path;
        await initRepo(configDir);
        process.env.AM_CONFIG_DIR = configDir;

        const gen = await resolveGenerateKey();
        capture();
        await gen.run({
          args: { json: true, quiet: false, verbose: false, "show-key": false, showKey: false },
        });

        const payload = JSON.parse(logged.join("\n"));
        expect(payload.action).toBe("generate-key");
        // The raw key MUST NOT be present in the JSON payload by default.
        expect(payload.key).toBeUndefined();
        expect("key" in payload).toBe(false);
        // The path to the key file IS reported so callers know where it landed.
        expect(payload.path).toBeDefined();
        expect(typeof payload.path).toBe("string");
        // An explicit indicator that the key was withheld.
        expect(payload.keyShown).toBe(false);
      });

      test("default text output never contains the base64 key", async () => {
        dir = await createTestDir("am-secret-genkey-text-noshow-");
        const configDir = dir.path;
        await initRepo(configDir);
        process.env.AM_CONFIG_DIR = configDir;

        const gen = await resolveGenerateKey();
        capture();
        await gen.run({
          args: { json: false, quiet: false, verbose: false, "show-key": false, showKey: false },
        });

        const out = logged.join("\n");
        // Read the actual key off disk and prove it does NOT appear in stdout.
        const keyContents = (await readFile(process.env.AM_KEY_PATH!, "utf-8")).trim();
        expect(keyContents.length).toBeGreaterThan(0);
        expect(out).not.toContain(keyContents);
        // A safe message points at the key file path instead.
        expect(out).toContain(process.env.AM_KEY_PATH!);
      });

      test("--show-key --json includes the raw key and keyShown:true", async () => {
        dir = await createTestDir("am-secret-genkey-json-show-");
        const configDir = dir.path;
        await initRepo(configDir);
        process.env.AM_CONFIG_DIR = configDir;

        const gen = await resolveGenerateKey();
        capture();
        await gen.run({
          args: { json: true, quiet: false, verbose: false, "show-key": true, showKey: true },
        });

        const payload = JSON.parse(logged.join("\n"));
        expect(payload.action).toBe("generate-key");
        expect(payload.keyShown).toBe(true);
        expect(typeof payload.key).toBe("string");
        // The emitted key matches what was written to disk.
        const keyContents = (await readFile(process.env.AM_KEY_PATH!, "utf-8")).trim();
        expect(payload.key).toBe(keyContents);
      });

      test("--show-key text output prints the raw key inline", async () => {
        dir = await createTestDir("am-secret-genkey-text-show-");
        const configDir = dir.path;
        await initRepo(configDir);
        process.env.AM_CONFIG_DIR = configDir;

        const gen = await resolveGenerateKey();
        capture();
        await gen.run({
          args: { json: false, quiet: false, verbose: false, "show-key": true, showKey: true },
        });

        const out = logged.join("\n");
        const keyContents = (await readFile(process.env.AM_KEY_PATH!, "utf-8")).trim();
        expect(out).toContain(keyContents);
      });
    });
  });

  describe("import-key", () => {
    test("writes key to the configured key path", async () => {
      dir = await createTestDir("am-secret-importkey-");
      await initRepo(dir.path);

      // Create a source key file
      const base64 = await generateKey();
      const sourcePath = join(dir.path, "external-key.txt");
      await Bun.write(sourcePath, `${base64}\n`);

      // Write to the configured key path (simulates `am secret import-key`)
      const keyPath = process.env.AM_KEY_PATH!;
      await mkdir(join(keyPath, ".."), { recursive: true });
      const contents = await readFile(sourcePath, "utf-8");
      await writeFile(keyPath, contents, { encoding: "utf-8", mode: 0o600 });

      const loaded = await loadKey(dir.path);
      expect(loaded).not.toBeNull();
    });
  });

  describe("set + get roundtrip", () => {
    test("encrypts value in server env and decrypts it back", async () => {
      dir = await createTestDir("am-secret-setget-");
      const { configDir, configPath, base64Key } = await setupConfigDir(dir);
      const key = await importKey(base64Key);

      // Read config, encrypt value, write back (simulate `am secret set`)
      let config = await readConfig(configPath);
      const { encryptValue } = await import("../../src/core/secrets");
      const encrypted = await encryptValue("sk-live-supersecret", key);

      config.servers!.tavily.env!.TAVILY_API_KEY = encrypted;
      await writeConfig(configPath, config);

      // Re-read and verify it's encrypted on disk
      config = await readConfig(configPath);
      expect(isEncrypted(config.servers!.tavily.env!.TAVILY_API_KEY)).toBe(true);

      // Decrypt (simulate `am secret get`)
      const decrypted = await decryptValue(config.servers!.tavily.env!.TAVILY_API_KEY, key);
      expect(decrypted).toBe("sk-live-supersecret");
    });

    test("sets secret in settings.env when no server specified", async () => {
      dir = await createTestDir("am-secret-settings-");
      const { configDir, configPath, base64Key } = await setupConfigDir(dir);
      const key = await importKey(base64Key);

      const { encryptValue } = await import("../../src/core/secrets");
      const encrypted = await encryptValue("global-secret", key);

      let config = await readConfig(configPath);
      if (!config.settings) config.settings = {};
      (config.settings as any).env = { GLOBAL_KEY: encrypted };
      await writeConfig(configPath, config);

      config = await readConfig(configPath);
      const settingsEnv = (config.settings as any)?.env;
      expect(settingsEnv?.GLOBAL_KEY).toBeDefined();
      expect(isEncrypted(settingsEnv.GLOBAL_KEY)).toBe(true);

      const decrypted = await decryptValue(settingsEnv.GLOBAL_KEY, key);
      expect(decrypted).toBe("global-secret");
    });
  });

  describe("list", () => {
    test("finds encrypted values across servers", async () => {
      dir = await createTestDir("am-secret-list-");
      const { configDir, configPath, base64Key } = await setupConfigDir(dir);
      const key = await importKey(base64Key);

      const { encryptValue } = await import("../../src/core/secrets");

      let config = await readConfig(configPath);
      config.servers!.tavily.env!.TAVILY_API_KEY = await encryptValue("secret1", key);

      // Add another server with an encrypted value
      config.servers!.exa = {
        command: "exa-mcp",
        transport: "stdio",
        enabled: true,
        env: {
          EXA_KEY: await encryptValue("secret2", key),
          PLAIN_VAR: "not-encrypted",
        },
      };
      await writeConfig(configPath, config);

      // Scan for secrets (simulate `am secret list`)
      config = await readConfig(configPath);
      const secrets: Array<{ name: string; location: string }> = [];
      for (const [serverName, server] of Object.entries(config.servers ?? {})) {
        for (const [name, value] of Object.entries(server.env ?? {})) {
          if (isEncrypted(value)) {
            secrets.push({ name, location: `server:${serverName}` });
          }
        }
      }

      expect(secrets).toHaveLength(2);
      expect(secrets.find((s) => s.name === "TAVILY_API_KEY")).toBeDefined();
      expect(secrets.find((s) => s.name === "EXA_KEY")).toBeDefined();
      // PLAIN_VAR should NOT appear
      expect(secrets.find((s) => s.name === "PLAIN_VAR")).toBeUndefined();
    });
  });

  // ws 1f08-secret-scan-exit-code (M5): `am secret scan` (no --fix) must exit
  // nonzero when plaintext secrets are found so it can gate CI. The report
  // branch previously printed findings then returned with no exit code set.
  describe("scan exit code", () => {
    const origConfigDir = process.env.AM_CONFIG_DIR;
    const origLog = console.log;
    let logged: string[] = [];

    // Reach the `scan` subcommand handler the same way doctor.test.ts reaches
    // its command — resolve it off the parent command's subCommands map. The
    // map is typed as a citty `Resolvable<SubCommandsDef>`, so we cast to a
    // record of lazy resolvers before indexing `scan`.
    async function resolveScan(): Promise<{
      run: (ctx: { args: Record<string, unknown> }) => Promise<void>;
    }> {
      const subCommands = secretCommand.subCommands as unknown as Record<
        string,
        () => Promise<unknown>
      >;
      const scan = await subCommands.scan();
      return scan as { run: (ctx: { args: Record<string, unknown> }) => Promise<void> };
    }

    function capture(): void {
      logged = [];
      console.log = (...args: unknown[]) => {
        logged.push(args.map(String).join(" "));
      };
    }

    afterEach(() => {
      console.log = origLog;
      if (origConfigDir === undefined) Reflect.deleteProperty(process.env, "AM_CONFIG_DIR");
      else process.env.AM_CONFIG_DIR = origConfigDir;
      process.exitCode = 0;
    });

    test("exits 1 and still prints findings when plaintext secrets are found (human)", async () => {
      dir = await createTestDir("am-secret-scan-exit-found-");
      // setupConfigDir seeds a tavily server with a plaintext TAVILY_API_KEY,
      // which Tier-1 key-name detection flags.
      const { configDir } = await setupConfigDir(dir);
      process.env.AM_CONFIG_DIR = configDir;

      const scan = await resolveScan();
      process.exitCode = 0;
      capture();
      await scan.run({ args: { fix: false, json: false, quiet: false, verbose: false } });

      expect(process.exitCode).toBe(1);
      // Findings are still printed — the gate doesn't suppress the report.
      const out = logged.join("\n");
      expect(out).toContain("secret(s) found");
      expect(out).toContain("TAVILY_API_KEY");
    });

    test("exits 1 and emits the findings payload in JSON mode", async () => {
      dir = await createTestDir("am-secret-scan-exit-found-json-");
      const { configDir } = await setupConfigDir(dir);
      process.env.AM_CONFIG_DIR = configDir;

      const scan = await resolveScan();
      process.exitCode = 0;
      capture();
      await scan.run({ args: { fix: false, json: true, quiet: false, verbose: false } });

      expect(process.exitCode).toBe(1);
      const payload = JSON.parse(logged.join("\n"));
      expect(payload.action).toBe("scan");
      expect(payload.secrets.length).toBeGreaterThan(0);
    });

    // M6 (ws 01ae-secret-scan-settings-env): a plaintext secret stored in
    // [settings.env] must be surfaced by `am secret scan` and counted by the
    // M5 exit-code gate. scanConfigForSecrets only looks at servers, so before
    // the fix a settings.env secret was invisible (false-clean → leaked cred).
    test("flags a plaintext secret in settings.env and exits 1", async () => {
      dir = await createTestDir("am-secret-scan-settings-env-");
      const configDir = dir.path;
      await initRepo(configDir);
      const configPath = join(configDir, "config.toml");
      // Servers are clean; the only plaintext secret lives in settings.env.
      const config: Config = {
        settings: {
          default_profile: "default",
          env: { GITHUB_TOKEN: "ghp_realtokenvalue1234567890" },
        } as Config["settings"],
        servers: {
          memory: {
            command: "bunx",
            args: ["@modelcontextprotocol/server-memory"],
            transport: "stdio",
            enabled: true,
            env: { LOG_LEVEL: "info" },
          },
        },
        profiles: { default: { description: "Default profile" } },
      };
      await writeConfig(configPath, config);
      process.env.AM_CONFIG_DIR = configDir;

      const scan = await resolveScan();
      process.exitCode = 0;
      capture();
      await scan.run({ args: { fix: false, json: true, quiet: false, verbose: false } });

      expect(process.exitCode).toBe(1);
      const payload = JSON.parse(logged.join("\n"));
      expect(payload.action).toBe("scan");
      // The settings.env finding is present, tagged with the synthetic scope.
      const settingsResult = payload.secrets.find(
        (r: { server: string }) => r.server === "settings",
      );
      expect(settingsResult).toBeDefined();
      expect(
        settingsResult.secrets.find((s: { key: string }) => s.key === "GITHUB_TOKEN"),
      ).toBeDefined();
    });

    // M6: --fix must encrypt a plaintext settings.env secret IN PLACE (the
    // value already lives where encrypted secrets belong), leaving no plaintext.
    test("--fix encrypts a plaintext settings.env secret in place", async () => {
      dir = await createTestDir("am-secret-scan-fix-settings-env-");
      const configDir = dir.path;
      await initRepo(configDir);
      const configPath = join(configDir, "config.toml");
      const config: Config = {
        settings: {
          default_profile: "default",
          env: { GITHUB_TOKEN: "ghp_realtokenvalue1234567890" },
        } as Config["settings"],
        profiles: { default: { description: "Default profile" } },
      };
      await writeConfig(configPath, config);
      // --fix generates a key if none exists; AM_KEY_PATH already points at tmp.
      process.env.AM_CONFIG_DIR = configDir;

      const scan = await resolveScan();
      process.exitCode = 0;
      capture();
      await scan.run({ args: { fix: true, json: true, quiet: false, verbose: false } });

      const after = await readConfig(configPath);
      const settingsEnv = (after.settings as { env?: Record<string, string> } | undefined)?.env;
      expect(settingsEnv?.GITHUB_TOKEN).toBeDefined();
      // Encrypted in place — plaintext is gone, ciphertext is an enc: envelope.
      expect(settingsEnv!.GITHUB_TOKEN).not.toBe("ghp_realtokenvalue1234567890");
      expect(isEncrypted(settingsEnv!.GITHUB_TOKEN)).toBe(true);
    });

    test("exits 0 when no secrets are detected", async () => {
      dir = await createTestDir("am-secret-scan-exit-clean-");
      const configDir = dir.path;
      await initRepo(configDir);
      const configPath = join(configDir, "config.toml");
      // A server with no secret-shaped env keys and no inline credentials.
      const config: Config = {
        settings: { default_profile: "default" },
        servers: {
          memory: {
            command: "bunx",
            args: ["@modelcontextprotocol/server-memory"],
            transport: "stdio",
            enabled: true,
            env: { LOG_LEVEL: "info" },
          },
        },
        profiles: { default: { description: "Default profile" } },
      };
      await writeConfig(configPath, config);
      process.env.AM_CONFIG_DIR = configDir;

      const scan = await resolveScan();
      process.exitCode = 0;
      capture();
      await scan.run({ args: { fix: false, json: false, quiet: false, verbose: false } });

      expect(process.exitCode).toBe(0);
    });
  });

  describe("wrong key", () => {
    test("decrypt fails with wrong key", async () => {
      dir = await createTestDir("am-secret-wrongkey-");
      const base64A = await generateKey();
      const base64B = await generateKey();
      const keyA = await importKey(base64A);
      const keyB = await importKey(base64B);

      const { encryptValue } = await import("../../src/core/secrets");
      const encrypted = await encryptValue("secret", keyA);

      // Decrypting with wrong key should throw
      await expect(decryptValue(encrypted, keyB)).rejects.toThrow();
    });

    // UX polish (ws4-6fd2): a wrong-key decrypt must surface an actionable
    // AmError naming the key-path remedy — NOT a raw WebCrypto `OperationError`
    // ("Cipher job failed"). The message must never echo ciphertext or key
    // material.
    test("decrypt with wrong key throws an actionable AmError, not raw WebCrypto noise", async () => {
      dir = await createTestDir("am-secret-wrongkey-amerror-");
      const keyA = await importKey(await generateKey());
      const keyB = await importKey(await generateKey());

      const { encryptValue } = await import("../../src/core/secrets");
      const { AmError } = await import("../../src/lib/errors");
      const plaintext = "sk-live-supersecret";
      const encrypted = await encryptValue(plaintext, keyA);

      let caught: unknown;
      try {
        await decryptValue(encrypted, keyB);
      } catch (e) {
        caught = e;
      }

      expect(caught).toBeInstanceOf(AmError);
      const err = caught as InstanceType<typeof AmError>;
      expect(err.code).toBe("SECRET_DECRYPT_FAILED");
      expect(err.message).toContain("does not match this envelope");
      // Names the key-path remedy.
      expect(err.suggestion).toContain(process.env.AM_KEY_PATH!);
      expect(err.suggestion).toContain("am secret generate-key");
      // NEVER leaks the plaintext, the ciphertext body, or key material.
      const combined = `${err.message} ${err.suggestion ?? ""}`;
      expect(combined).not.toContain(plaintext);
      expect(combined).not.toContain(encrypted.slice("enc:v1:".length));
    });
  });
});
