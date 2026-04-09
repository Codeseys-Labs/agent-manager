import { afterEach, describe, expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
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
  const origEnv: Record<string, string | undefined> = {};

  function setEnv(key: string, value: string) {
    origEnv[key] = process.env[key];
    process.env[key] = value;
  }

  afterEach(async () => {
    if (dir) await dir.cleanup();
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
    test("creates key file in .agent-manager/key.txt", async () => {
      dir = await createTestDir("am-secret-genkey-");
      await initRepo(dir.path);

      const base64 = await generateKey();
      await saveKey(dir.path, base64);

      const loaded = await loadKey(dir.path);
      expect(loaded).not.toBeNull();

      const keyContents = await dir.read(".agent-manager/key.txt");
      expect(keyContents.trim()).toBe(base64);
    });
  });

  describe("import-key", () => {
    test("copies key file to config dir", async () => {
      dir = await createTestDir("am-secret-importkey-");
      await initRepo(dir.path);

      // Create a source key file
      const base64 = await generateKey();
      const sourcePath = join(dir.path, "external-key.txt");
      await Bun.write(sourcePath, `${base64}\n`);

      // Import by copying
      const { copyFile } = await import("node:fs/promises");
      const destPath = join(dir.path, ".agent-manager", "key.txt");
      await copyFile(sourcePath, destPath);

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
  });
});
