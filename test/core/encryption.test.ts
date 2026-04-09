import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Config } from "../../src/core/schema";
import {
  decryptValue,
  encryptValue,
  generateKey,
  importKey,
  interpolateEnvAsync,
  isEncrypted,
  loadKey,
  saveKey,
} from "../../src/core/secrets";
import { type TestDir, createTestDir } from "../helpers/tmp";

describe("encryption", () => {
  describe("generateKey", () => {
    test("produces valid base64 string", async () => {
      const key = await generateKey();
      expect(typeof key).toBe("string");
      // Base64 of 32 bytes = 44 chars
      expect(key.length).toBe(44);
      // Should decode to 32 bytes
      const decoded = Uint8Array.from(atob(key), (c) => c.charCodeAt(0));
      expect(decoded.length).toBe(32);
    });

    test("generates unique keys each time", async () => {
      const key1 = await generateKey();
      const key2 = await generateKey();
      expect(key1).not.toBe(key2);
    });
  });

  describe("importKey", () => {
    test("roundtrips with generateKey", async () => {
      const base64 = await generateKey();
      const cryptoKey = await importKey(base64);
      expect(cryptoKey).toBeDefined();
      expect(cryptoKey.algorithm).toMatchObject({ name: "AES-GCM" });
      expect(cryptoKey.usages).toContain("encrypt");
      expect(cryptoKey.usages).toContain("decrypt");
    });
  });

  describe("encryptValue + decryptValue", () => {
    test("roundtrips plaintext", async () => {
      const base64 = await generateKey();
      const key = await importKey(base64);
      const plaintext = "sk-live-abc123def456";

      const encrypted = await encryptValue(plaintext, key);
      const decrypted = await decryptValue(encrypted, key);

      expect(decrypted).toBe(plaintext);
    });

    test("encrypted value has enc:v1: prefix", async () => {
      const base64 = await generateKey();
      const key = await importKey(base64);
      const encrypted = await encryptValue("test", key);

      expect(encrypted.startsWith("enc:v1:")).toBe(true);
      // Format: enc:v1:nonce_b64:ciphertext_b64
      const parts = encrypted.split(":");
      expect(parts.length).toBe(4); // enc, v1, nonce, ciphertext
    });

    test("encrypts differently each time (unique nonce)", async () => {
      const base64 = await generateKey();
      const key = await importKey(base64);
      const plaintext = "same-value";

      const enc1 = await encryptValue(plaintext, key);
      const enc2 = await encryptValue(plaintext, key);

      expect(enc1).not.toBe(enc2); // different nonces
      // But both decrypt to same value
      expect(await decryptValue(enc1, key)).toBe(plaintext);
      expect(await decryptValue(enc2, key)).toBe(plaintext);
    });

    test("handles empty string", async () => {
      const base64 = await generateKey();
      const key = await importKey(base64);
      const encrypted = await encryptValue("", key);
      expect(await decryptValue(encrypted, key)).toBe("");
    });

    test("handles unicode", async () => {
      const base64 = await generateKey();
      const key = await importKey(base64);
      const plaintext = "secret-with-emoji-\u{1F512}-and-CJK-\u5BC6\u7801";
      const encrypted = await encryptValue(plaintext, key);
      expect(await decryptValue(encrypted, key)).toBe(plaintext);
    });
  });

  describe("decryptValue passthrough", () => {
    test("passes through non-encrypted values", async () => {
      const base64 = await generateKey();
      const key = await importKey(base64);

      expect(await decryptValue("plain-text", key)).toBe("plain-text");
      expect(await decryptValue("${VAR}", key)).toBe("${VAR}");
      expect(await decryptValue("", key)).toBe("");
    });
  });

  describe("isEncrypted", () => {
    test("detects enc:v1: prefix", () => {
      expect(isEncrypted("enc:v1:abc:def")).toBe(true);
      expect(isEncrypted("enc:v1:")).toBe(true);
    });

    test("rejects non-encrypted strings", () => {
      expect(isEncrypted("plain-text")).toBe(false);
      expect(isEncrypted("")).toBe(false);
      expect(isEncrypted("enc:v2:abc:def")).toBe(false);
      expect(isEncrypted("ENC:V1:abc")).toBe(false);
    });
  });

  describe("loadKey", () => {
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

    test("reads from AM_ENCRYPTION_KEY env var", async () => {
      dir = await createTestDir("am-loadkey-");
      const base64 = await generateKey();
      setEnv("AM_ENCRYPTION_KEY", base64);

      const key = await loadKey(dir.path);
      expect(key).not.toBeNull();

      // Verify it works for encryption/decryption
      const encrypted = await encryptValue("test", key!);
      expect(await decryptValue(encrypted, key!)).toBe("test");
    });

    test("reads from .agent-manager/key.txt file", async () => {
      dir = await createTestDir("am-loadkey-");
      process.env.AM_ENCRYPTION_KEY = undefined;
      origEnv.AM_ENCRYPTION_KEY = undefined;

      const base64 = await generateKey();
      await mkdir(join(dir.path, ".agent-manager"), { recursive: true });
      await writeFile(join(dir.path, ".agent-manager", "key.txt"), `${base64}\n`);

      const key = await loadKey(dir.path);
      expect(key).not.toBeNull();

      const encrypted = await encryptValue("test", key!);
      expect(await decryptValue(encrypted, key!)).toBe("test");
    });

    test("env var takes priority over file", async () => {
      dir = await createTestDir("am-loadkey-");
      const envBase64 = await generateKey();
      const fileBase64 = await generateKey();

      setEnv("AM_ENCRYPTION_KEY", envBase64);
      await mkdir(join(dir.path, ".agent-manager"), { recursive: true });
      await writeFile(join(dir.path, ".agent-manager", "key.txt"), fileBase64);

      const key = await loadKey(dir.path);
      expect(key).not.toBeNull();

      // Encrypt with the loaded key, decrypt with the env key — should work
      const envKey = await importKey(envBase64);
      const encrypted = await encryptValue("test", key!);
      expect(await decryptValue(encrypted, envKey)).toBe("test");
    });

    test("returns null when no key available", async () => {
      dir = await createTestDir("am-loadkey-");
      process.env.AM_ENCRYPTION_KEY = undefined;
      origEnv.AM_ENCRYPTION_KEY = undefined;

      const key = await loadKey(dir.path);
      expect(key).toBeNull();
    });
  });

  describe("saveKey", () => {
    let dir: TestDir;

    afterEach(async () => {
      if (dir) await dir.cleanup();
    });

    test("writes key to .agent-manager/key.txt", async () => {
      dir = await createTestDir("am-savekey-");
      await mkdir(join(dir.path, ".agent-manager"), { recursive: true });

      const base64 = await generateKey();
      await saveKey(dir.path, base64);

      const contents = await dir.read(".agent-manager/key.txt");
      expect(contents.trim()).toBe(base64);
    });
  });

  describe("interpolateEnvAsync with encryption", () => {
    const origEnv: Record<string, string | undefined> = {};

    function setEnv(key: string, value: string) {
      origEnv[key] = process.env[key];
      process.env[key] = value;
    }

    afterEach(() => {
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

    test("decrypts encrypted values when key provided", async () => {
      const base64 = await generateKey();
      const key = await importKey(base64);
      const encrypted = await encryptValue("my-secret-token", key);

      const config: Config = {
        servers: {
          s: {
            command: "server",
            transport: "stdio",
            enabled: true,
            env: { API_KEY: encrypted },
          },
        },
      };

      const { config: result } = await interpolateEnvAsync(config, {
        encryptionKey: key,
      });

      expect(result.servers?.s.env?.API_KEY).toBe("my-secret-token");
    });

    test("leaves non-encrypted values unchanged", async () => {
      const base64 = await generateKey();
      const key = await importKey(base64);

      setEnv("AM_TEST_VAL", "resolved");

      const config: Config = {
        servers: {
          s: {
            command: "server",
            transport: "stdio",
            enabled: true,
            env: { PLAIN: "plain-value", INTERPOLATED: "${AM_TEST_VAL}" },
          },
        },
      };

      const { config: result } = await interpolateEnvAsync(config, {
        encryptionKey: key,
      });

      expect(result.servers?.s.env?.PLAIN).toBe("plain-value");
      expect(result.servers?.s.env?.INTERPOLATED).toBe("resolved");
    });

    test("works without encryption key (no decryption)", async () => {
      const config: Config = {
        servers: {
          s: {
            command: "server",
            transport: "stdio",
            enabled: true,
            env: { KEEP: "enc:v1:fake:data" },
          },
        },
      };

      const { config: result } = await interpolateEnvAsync(config);

      // Without a key, encrypted values pass through
      expect(result.servers?.s.env?.KEEP).toBe("enc:v1:fake:data");
    });
  });
});
