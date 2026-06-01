/**
 * Tests for ADR-0042 Wave 3 integration:
 *   - `selectBackendName` config / env-var resolution
 *   - `getDefaultBackend` factory behaviour for both backends
 *   - `isLegacyV1Envelope` / `isAnyEnvelope` helpers
 *   - end-to-end `secrets-migrate` walk (legacy -> age round-trip)
 */

import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as TOML from "@iarna/toml";

// The `age` backend's scrypt identity wrap/unwrap is 8-9s per op under CI
// coverage (and slower still on the Windows runner). The 5s default would time
// out the age round-trip + secrets-migrate cases below — and because bun runs
// every test file in ONE process, a timed-out async test leaks global env/state
// into the sibling getDefaultBackend(aes-gcm-legacy) cases, failing them too.
// Mirrors test/core/secrets-age.test.ts (Wave CI / P0-5).
setDefaultTimeout(30_000);
import {
  AesGcmLegacyBackend,
  type SelectableBackendName,
  encryptValue,
  generateKey,
  getDefaultBackend,
  importKey,
  isAnyEnvelope,
  isLegacyV1Envelope,
  saveKey,
  selectBackendName,
} from "../../src/core/secrets";
import "../../src/core/secrets-age"; // side-effect: register `age` factory

// --- selectBackendName ------------------------------------------------

describe("selectBackendName", () => {
  const origEnv = process.env.AM_SECRETS_BACKEND;
  afterEach(() => {
    // Windows portability: `process.env.X = undefined` coerces to the STRING
    // "undefined" on Windows (POSIX Bun deletes it). A leaked "undefined" then
    // poisons `selectBackendName`/`loadKey`. `Reflect.deleteProperty` genuinely
    // unsets on every platform and satisfies Biome's noDelete rule.
    if (origEnv === undefined) Reflect.deleteProperty(process.env, "AM_SECRETS_BACKEND");
    else process.env.AM_SECRETS_BACKEND = origEnv;
  });

  test("defaults to aes-gcm-legacy when nothing is configured", () => {
    Reflect.deleteProperty(process.env, "AM_SECRETS_BACKEND");
    expect(selectBackendName(null)).toBe("aes-gcm-legacy");
    expect(selectBackendName({})).toBe("aes-gcm-legacy");
    expect(selectBackendName({ settings: {} })).toBe("aes-gcm-legacy");
  });

  test("honours settings.secrets.backend when set to a known value", () => {
    Reflect.deleteProperty(process.env, "AM_SECRETS_BACKEND");
    const cfg = { settings: { secrets: { backend: "age" } } } as unknown as Parameters<
      typeof selectBackendName
    >[0];
    expect(selectBackendName(cfg)).toBe("age");
  });

  test("ignores settings.secrets.backend with an unknown value", () => {
    Reflect.deleteProperty(process.env, "AM_SECRETS_BACKEND");
    const cfg = { settings: { secrets: { backend: "bogus" } } } as unknown as Parameters<
      typeof selectBackendName
    >[0];
    expect(selectBackendName(cfg)).toBe("aes-gcm-legacy");
  });

  test("AM_SECRETS_BACKEND env var overrides config", () => {
    process.env.AM_SECRETS_BACKEND = "age";
    const cfg = { settings: { secrets: { backend: "aes-gcm-legacy" } } } as unknown as Parameters<
      typeof selectBackendName
    >[0];
    expect(selectBackendName(cfg)).toBe("age");
  });
});

// --- envelope helpers -------------------------------------------------

describe("envelope helpers", () => {
  test("isLegacyV1Envelope recognises enc:v1: only", () => {
    expect(isLegacyV1Envelope("enc:v1:aaa:bbb")).toBe(true);
    expect(isLegacyV1Envelope("enc:v2:age:xxx")).toBe(false);
    expect(isLegacyV1Envelope("plaintext")).toBe(false);
  });

  test("isAnyEnvelope recognises both v1 and v2:age", () => {
    expect(isAnyEnvelope("enc:v1:aaa:bbb")).toBe(true);
    expect(isAnyEnvelope("enc:v2:age:xxx")).toBe(true);
    expect(isAnyEnvelope("enc:v3:mystery")).toBe(false);
    expect(isAnyEnvelope("plaintext")).toBe(false);
  });
});

// --- getDefaultBackend ------------------------------------------------

async function makeTempConfigDir(): Promise<{ configDir: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), "am-backend-test-"));
  return {
    configDir: dir,
    cleanup: async () => rm(dir, { recursive: true, force: true }),
  };
}

describe("getDefaultBackend", () => {
  let tmp: { configDir: string; cleanup: () => Promise<void> };
  const origKeyPath = process.env.AM_KEY_PATH;
  const origEncKey = process.env.AM_ENCRYPTION_KEY;
  const origAgePp = process.env.AM_AGE_PASSPHRASE;
  const origAgeDir = process.env.AM_AGE_IDENTITY_DIR;
  const origBackendEnv = process.env.AM_SECRETS_BACKEND;

  beforeEach(async () => {
    tmp = await makeTempConfigDir();
    process.env.AM_KEY_PATH = join(tmp.configDir, "key");
    // `= undefined` would stringify to "undefined" on Windows and poison
    // `loadKey` (importKey("undefined") → atob throws "invalid characters",
    // masquerading as the wrong error AND leaking into spawned `am` subprocesses
    // that inherit process.env). Delete to genuinely unset on every platform.
    Reflect.deleteProperty(process.env, "AM_ENCRYPTION_KEY");
    Reflect.deleteProperty(process.env, "AM_SECRETS_BACKEND");
  });
  afterEach(async () => {
    if (origKeyPath === undefined) Reflect.deleteProperty(process.env, "AM_KEY_PATH");
    else process.env.AM_KEY_PATH = origKeyPath;
    if (origEncKey === undefined) Reflect.deleteProperty(process.env, "AM_ENCRYPTION_KEY");
    else process.env.AM_ENCRYPTION_KEY = origEncKey;
    if (origAgePp === undefined) Reflect.deleteProperty(process.env, "AM_AGE_PASSPHRASE");
    else process.env.AM_AGE_PASSPHRASE = origAgePp;
    if (origAgeDir === undefined) Reflect.deleteProperty(process.env, "AM_AGE_IDENTITY_DIR");
    else process.env.AM_AGE_IDENTITY_DIR = origAgeDir;
    if (origBackendEnv === undefined) Reflect.deleteProperty(process.env, "AM_SECRETS_BACKEND");
    else process.env.AM_SECRETS_BACKEND = origBackendEnv;
    await tmp.cleanup();
  });

  test("returns aes-gcm-legacy with a loaded key by default", async () => {
    const base64 = await generateKey();
    await saveKey(tmp.configDir, base64);

    const backend = await getDefaultBackend(tmp.configDir);
    expect(backend.name).toBe("aes-gcm-legacy");

    const envelope = await backend.encrypt("hello");
    expect(envelope.startsWith("enc:v1:")).toBe(true);
    expect(await backend.decrypt(envelope)).toBe("hello");
  });

  test("throws a descriptive error when aes-gcm-legacy has no key", async () => {
    await expect(getDefaultBackend(tmp.configDir)).rejects.toThrow(/no encryption key/i);
  });

  test("returns an age backend when settings.secrets.backend = 'age'", async () => {
    const ageDir = join(tmp.configDir, "age");
    process.env.AM_AGE_IDENTITY_DIR = ageDir;
    process.env.AM_AGE_PASSPHRASE = "test-pw";

    const backend = await getDefaultBackend(tmp.configDir, {
      config: { settings: { secrets: { backend: "age" } } } as NonNullable<
        Parameters<typeof getDefaultBackend>[1]
      >["config"],
    });
    expect(backend.name).toBe("age");

    // Round-trip via the factory-loaded backend.
    const envelope = await backend.encrypt("secret-via-age");
    expect(envelope.startsWith("enc:v2:age:")).toBe(true);
    expect(await backend.decrypt(envelope)).toBe("secret-via-age");
  });

  test("override option wins over config", async () => {
    // config says legacy, override forces age.
    const ageDir = join(tmp.configDir, "age2");
    process.env.AM_AGE_IDENTITY_DIR = ageDir;
    process.env.AM_AGE_PASSPHRASE = "pw";

    const backend = await getDefaultBackend(tmp.configDir, {
      config: { settings: { secrets: { backend: "aes-gcm-legacy" } } } as NonNullable<
        Parameters<typeof getDefaultBackend>[1]
      >["config"],
      override: "age" as SelectableBackendName,
    });
    expect(backend.name).toBe("age");
  });
});

// --- secrets-migrate integration --------------------------------------

describe("secrets migrate — walk + re-encrypt", () => {
  let tmp: { configDir: string; cleanup: () => Promise<void> };
  const origKeyPath = process.env.AM_KEY_PATH;
  const origAgePp = process.env.AM_AGE_PASSPHRASE;
  const origAgeDir = process.env.AM_AGE_IDENTITY_DIR;

  beforeEach(async () => {
    tmp = await makeTempConfigDir();
    process.env.AM_KEY_PATH = join(tmp.configDir, "key");
    process.env.AM_AGE_IDENTITY_DIR = join(tmp.configDir, "age-identity");
    process.env.AM_AGE_PASSPHRASE = "migrate-pw";
  });
  afterEach(async () => {
    if (origKeyPath === undefined) Reflect.deleteProperty(process.env, "AM_KEY_PATH");
    else process.env.AM_KEY_PATH = origKeyPath;
    if (origAgePp === undefined) Reflect.deleteProperty(process.env, "AM_AGE_PASSPHRASE");
    else process.env.AM_AGE_PASSPHRASE = origAgePp;
    if (origAgeDir === undefined) Reflect.deleteProperty(process.env, "AM_AGE_IDENTITY_DIR");
    else process.env.AM_AGE_IDENTITY_DIR = origAgeDir;
    await tmp.cleanup();
  });

  test("migrates enc:v1: envelopes in a config.toml to the age backend", async () => {
    // 1. Generate legacy key and encrypt a couple of values under it.
    const base64 = await generateKey();
    await saveKey(tmp.configDir, base64);
    const legacyKey = await importKey(base64);

    const encA = await encryptValue("value-a", legacyKey);
    const encB = await encryptValue("value-b", legacyKey);

    const configPath = join(tmp.configDir, "config.toml");
    const initial = TOML.stringify({
      settings: {
        env: { FOO: encA },
        secrets: { backend: "age" },
      },
      servers: {
        alpha: {
          command: "/bin/true",
          env: { BAR: encB },
        },
      },
    } as unknown as TOML.JsonMap);
    await writeFile(configPath, initial);

    // 2. Invoke the command module directly. We bypass the CLI layer and
    //    drive the run() closure to keep the test hermetic.
    const { secretsMigrateCommand } = await import("../../src/commands/secrets-migrate");

    // citty `run` expects a `{ args, rawArgs, cmd }` shape. We only
    // touch `args`, so a cast suffices.
    const configDirBefore = process.env.AM_CONFIG_DIR;
    process.env.AM_CONFIG_DIR = tmp.configDir;
    try {
      await (
        secretsMigrateCommand.run as (ctx: {
          args: Record<string, unknown>;
        }) => Promise<void>
      )({
        args: {
          "dry-run": false,
          "no-backup": false,
          file: configPath,
          json: false,
          quiet: true,
          verbose: false,
        },
      });
    } finally {
      if (configDirBefore === undefined) Reflect.deleteProperty(process.env, "AM_CONFIG_DIR");
      else process.env.AM_CONFIG_DIR = configDirBefore;
    }

    // 3. The rewritten config should contain v2:age envelopes now, and
    //    the legacy backend should no longer be able to decrypt them.
    const afterRaw = await readFile(configPath, "utf-8");
    const after = TOML.parse(afterRaw) as {
      settings: { env: { FOO: string } };
      servers: { alpha: { env: { BAR: string } } };
    };
    expect(after.settings.env.FOO.startsWith("enc:v2:age:")).toBe(true);
    expect(after.servers.alpha.env.BAR.startsWith("enc:v2:age:")).toBe(true);

    // 4. Backup file was produced.
    const backupRaw = await readFile(`${configPath}.bak`, "utf-8");
    expect(backupRaw).toBe(initial);

    // 5. Round-trip through the age backend to verify the content is
    //    still "value-a"/"value-b".
    const ageBackend = await getDefaultBackend(tmp.configDir, {
      config: { settings: { secrets: { backend: "age" } } } as NonNullable<
        Parameters<typeof getDefaultBackend>[1]
      >["config"],
    });
    expect(await ageBackend.decrypt(after.settings.env.FOO)).toBe("value-a");
    expect(await ageBackend.decrypt(after.servers.alpha.env.BAR)).toBe("value-b");

    // 6. The legacy backend's decrypt passes non-v1 strings through
    //    unchanged (see decryptValue: !isEncrypted(value) → return as-is).
    //    Confirm that behaviour rather than expecting a throw — what
    //    matters is that the v2 envelope is NOT misinterpreted as a v1
    //    payload that decrypts to plaintext "value-a".
    const legacy = new AesGcmLegacyBackend(legacyKey);
    const passthrough = await legacy.decrypt(after.settings.env.FOO);
    expect(passthrough).toBe(after.settings.env.FOO);
    expect(passthrough).not.toBe("value-a");
  });

  test("dry-run reports envelopes without modifying the file", async () => {
    const base64 = await generateKey();
    await saveKey(tmp.configDir, base64);
    const legacyKey = await importKey(base64);

    const enc = await encryptValue("hello", legacyKey);
    const configPath = join(tmp.configDir, "config.toml");
    const initial = TOML.stringify({
      settings: { env: { HELLO: enc }, secrets: { backend: "age" } },
    } as unknown as TOML.JsonMap);
    await writeFile(configPath, initial);

    const { secretsMigrateCommand } = await import("../../src/commands/secrets-migrate");

    await (
      secretsMigrateCommand.run as (ctx: {
        args: Record<string, unknown>;
      }) => Promise<void>
    )({
      args: {
        "dry-run": true,
        "no-backup": false,
        file: configPath,
        json: false,
        quiet: true,
        verbose: false,
      },
    });

    // File is unchanged.
    const after = await readFile(configPath, "utf-8");
    expect(after).toBe(initial);
    // No backup was created.
    await expect(readFile(`${configPath}.bak`, "utf-8")).rejects.toThrow();
  });
});
