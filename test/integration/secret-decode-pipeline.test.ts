/**
 * P0-3 regression suite — the age-secrets apply CORRUPTION bug.
 *
 * Before this fix, the apply decrypt walk (`interpolateEnvAsync`) only
 * understood `enc:v1:` and PASSED THROUGH anything else unchanged. An
 * `am secrets migrate --to age` followed by `am apply` therefore wrote the
 * literal ciphertext string `enc:v2:age:...` into native IDE configs instead
 * of the decrypted secret — silent data corruption presented as success.
 *
 * This is the integration test whose ABSENCE let the bug ship. It proves:
 *   1. encrypt → decode round-trips for BOTH `enc:v1:` and `enc:v2:age:`,
 *   2. the SAME apply chokepoint (`interpolateEnvAsync`) decrypts both,
 *   3. an unknown `enc:v99:` prefix THROWS instead of leaking ciphertext,
 *   4. `applyResolved` FAILS LOUD (no verbatim ciphertext) when it meets a
 *      v2 envelope it cannot decrypt.
 */

import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The age backend's scrypt identity wrap/unwrap is 8-9s per op under CI
// coverage and slower on the Windows 2-vcpu runner. The 5s default fires
// mid-operation for the v2 round-trip + applyResolved cases below; a killed
// async test leaks global process.env/state into sibling tests because bun runs
// every file in ONE process. Mirrors test/core/secrets-age.test.ts (Wave CI).
setDefaultTimeout(30_000);
import { writeConfig } from "../../src/core/config";
import { applyResolved } from "../../src/core/controller";
import { initRepo } from "../../src/core/git";
import type { Config } from "../../src/core/schema";
import { encryptValue, generateKey, importKey, interpolateEnvAsync } from "../../src/core/secrets";
import { AgeSecretsBackend, type KeychainAdapter } from "../../src/core/secrets-age";
import {
  MissingBackendError,
  UnknownEnvelopeError,
  classifyEnvelope,
  decodeEnvelope,
} from "../../src/core/secrets-decode";
import { type TestDir, createTestDir } from "../helpers/tmp";

// In-memory keychain so age tests never touch the OS keychain.
function makeMemKeychain(): KeychainAdapter {
  const store = new Map<string, string>();
  const key = (s: string, a: string) => `${s}::${a}`;
  return {
    async getPassword(service, account) {
      return store.get(key(service, account)) ?? null;
    },
    async setPassword(service, account, password) {
      store.set(key(service, account), password);
    },
    async deletePassword(service, account) {
      store.delete(key(service, account));
    },
  };
}

describe("P0-3: format-aware decode (classify + dispatch)", () => {
  test("classifyEnvelope tags each format", () => {
    expect(classifyEnvelope("enc:v1:aXY=:Y3Q=")).toBe("v1-aes-gcm");
    expect(classifyEnvelope("enc:v2:age:QQQQ")).toBe("v2-age");
    expect(classifyEnvelope("enc:v99:whatever")).toBe("unknown-envelope");
    expect(classifyEnvelope("plain text")).toBe("plaintext");
    expect(classifyEnvelope("${API_KEY}")).toBe("plaintext");
    expect(classifyEnvelope(42)).toBe("plaintext");
  });

  test("decodeEnvelope returns plaintext unchanged", async () => {
    expect(await decodeEnvelope("just a value", {})).toBe("just a value");
    expect(await decodeEnvelope("${VAR}", {})).toBe("${VAR}");
  });

  test("decodeEnvelope throws UnknownEnvelopeError on unknown prefix (never leaks)", async () => {
    await expect(decodeEnvelope("enc:v99:c2VjcmV0", {})).rejects.toBeInstanceOf(
      UnknownEnvelopeError,
    );
    // The error message must NOT contain the ciphertext body.
    try {
      await decodeEnvelope("enc:v99:SUPERSECRETCIPHERTEXT", {});
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(UnknownEnvelopeError);
      expect((err as Error).message).not.toContain("SUPERSECRETCIPHERTEXT");
    }
  });

  test("decodeEnvelope throws MissingBackendError when backend absent (never leaks)", async () => {
    await expect(decodeEnvelope("enc:v1:aXY=:Y3Q=", {})).rejects.toBeInstanceOf(
      MissingBackendError,
    );
    await expect(decodeEnvelope("enc:v2:age:QQQQ", {})).rejects.toBeInstanceOf(MissingBackendError);
  });
});

describe("P0-3: encrypt → apply-decode round-trip for v1 AND v2", () => {
  const origKeyPath = process.env.AM_KEY_PATH;
  const origIdDir = process.env.AM_AGE_IDENTITY_DIR;
  const origPass = process.env.AM_AGE_PASSPHRASE;
  let keyDir: TestDir;
  let ageDir: string;

  beforeEach(async () => {
    keyDir = await createTestDir("am-decode-keydir-");
    process.env.AM_KEY_PATH = join(keyDir.path, "key");
    ageDir = await mkdtemp(join(tmpdir(), "am-decode-age-"));
    process.env.AM_AGE_IDENTITY_DIR = ageDir;
    process.env.AM_AGE_PASSPHRASE = "correct horse battery staple";
  });

  afterEach(async () => {
    if (keyDir) await keyDir.cleanup();
    await rm(ageDir, { recursive: true, force: true }).catch(() => {});
    restore("AM_KEY_PATH", origKeyPath);
    restore("AM_AGE_IDENTITY_DIR", origIdDir);
    restore("AM_AGE_PASSPHRASE", origPass);
  });

  function restore(name: string, val: string | undefined) {
    if (val === undefined) delete process.env[name];
    else process.env[name] = val;
  }

  test("interpolateEnvAsync decrypts an enc:v1: envelope (the apply chokepoint)", async () => {
    const aesKey = await importKey(await generateKey());
    const v1 = await encryptValue("v1-plaintext-secret", aesKey);

    const config = {
      servers: { s: { command: "x", env: { API_KEY: v1 } } },
    } as unknown as Config;

    const { config: out } = await interpolateEnvAsync(config, { encryptionKey: aesKey });
    expect((out as Config).servers!.s.env!.API_KEY).toBe("v1-plaintext-secret");
  });

  test("interpolateEnvAsync decrypts an enc:v2:age: envelope (was the corruption bug)", async () => {
    const backend = new AgeSecretsBackend({
      identityPath: join(ageDir, "identity.age"),
      recipientsDir: join(ageDir, "recipients"),
      passphraseProvider: async () => "correct horse battery staple",
      keychain: makeMemKeychain(),
    });
    const v2 = await backend.encrypt("v2-age-plaintext-secret");
    expect(v2.startsWith("enc:v2:age:")).toBe(true);

    const config = {
      servers: { s: { command: "x", env: { API_KEY: v2 } } },
    } as unknown as Config;

    const { config: out } = await interpolateEnvAsync(config, { ageBackend: backend });
    expect((out as Config).servers!.s.env!.API_KEY).toBe("v2-age-plaintext-secret");
    // The verbatim ciphertext must NOT survive into the resolved config.
    expect((out as Config).servers!.s.env!.API_KEY).not.toContain("enc:v2:age:");
  });

  test("interpolateEnvAsync decrypts a MIXED v1+v2 config in one walk", async () => {
    const aesKey = await importKey(await generateKey());
    const v1 = await encryptValue("legacy", aesKey);
    const backend = new AgeSecretsBackend({
      identityPath: join(ageDir, "identity.age"),
      recipientsDir: join(ageDir, "recipients"),
      passphraseProvider: async () => "correct horse battery staple",
      keychain: makeMemKeychain(),
    });
    const v2 = await backend.encrypt("modern");

    const config = {
      settings: { env: { LEGACY: v1 } },
      servers: { s: { command: "x", env: { MODERN: v2 } } },
    } as unknown as Config;

    const { config: out } = await interpolateEnvAsync(config, {
      encryptionKey: aesKey,
      ageBackend: backend,
    });
    expect((out as Config).settings!.env!.LEGACY).toBe("legacy");
    expect((out as Config).servers!.s.env!.MODERN).toBe("modern");
  });

  test("interpolateEnvAsync THROWS on an unknown enc:v99: prefix instead of leaking", async () => {
    const aesKey = await importKey(await generateKey());
    const config = {
      servers: { s: { command: "x", env: { API_KEY: "enc:v99:LEAKME" } } },
    } as unknown as Config;

    await expect(interpolateEnvAsync(config, { encryptionKey: aesKey })).rejects.toBeInstanceOf(
      UnknownEnvelopeError,
    );
  });

  test("interpolateEnvAsync THROWS when a v2 envelope appears but no age backend supplied", async () => {
    const aesKey = await importKey(await generateKey());
    const config = {
      servers: { s: { command: "x", env: { API_KEY: "enc:v2:age:QQQQ" } } },
    } as unknown as Config;

    // legacy key only — must fail loud, NOT pass the ciphertext through.
    await expect(interpolateEnvAsync(config, { encryptionKey: aesKey })).rejects.toBeInstanceOf(
      MissingBackendError,
    );
  });
});

describe("P0-3: applyResolved fails loud instead of writing ciphertext verbatim", () => {
  let dir: TestDir | undefined;
  // Variable-keyed env mutation (biome's noDelete allows a dynamic key).
  function setEnv(name: string, val: string | undefined) {
    if (val === undefined) delete process.env[name];
    else process.env[name] = val;
  }
  const orig: Record<string, string | undefined> = {
    AM_CONFIG_DIR: process.env.AM_CONFIG_DIR,
    AM_AGE_IDENTITY_DIR: process.env.AM_AGE_IDENTITY_DIR,
    AM_AGE_PASSPHRASE: process.env.AM_AGE_PASSPHRASE,
  };

  beforeEach(async () => {
    dir = await createTestDir("am-apply-decode-");
    process.env.AM_CONFIG_DIR = dir.path;
    await initRepo(dir.path);
  });

  afterEach(async () => {
    for (const [name, val] of Object.entries(orig)) setEnv(name, val);
    if (dir) await dir.cleanup();
    dir = undefined;
  });

  test("applyResolved refuses a v2 envelope it cannot decrypt (no age identity)", async () => {
    if (!dir) throw new Error("setup failed");
    // Point the age identity dir at an empty location and DON'T supply a
    // passphrase, so the age backend cannot unlock. The apply must throw
    // during the decode walk rather than write `enc:v2:age:...` to any
    // native config.
    setEnv("AM_AGE_IDENTITY_DIR", join(dir.path, "no-such-identity"));
    setEnv("AM_AGE_PASSPHRASE", undefined);

    await writeConfig(join(dir.path, "config.toml"), {
      settings: { default_profile: "default" },
      servers: {
        fetch: {
          command: "uvx",
          args: ["mcp-server-fetch"],
          transport: "stdio",
          enabled: true,
          // A v2 envelope present in config even though backend is default (v1).
          env: { API_KEY: "enc:v2:age:QQQQ" },
        },
      },
    } as unknown as Config);

    // dryRun still runs the decode walk first, so the failure surfaces.
    await expect(applyResolved(dir.path, { dryRun: true })).rejects.toThrow();
  });

  test("applyResolved refuses an unknown enc:v99: envelope (fail loud)", async () => {
    if (!dir) throw new Error("setup failed");
    await writeConfig(join(dir.path, "config.toml"), {
      settings: { default_profile: "default" },
      servers: {
        fetch: {
          command: "uvx",
          args: ["mcp-server-fetch"],
          transport: "stdio",
          enabled: true,
          env: { API_KEY: "enc:v99:WOULD-LEAK" },
        },
      },
    } as unknown as Config);

    await expect(applyResolved(dir.path, { dryRun: true })).rejects.toBeInstanceOf(
      UnknownEnvelopeError,
    );
  });
});
