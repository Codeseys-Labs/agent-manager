/**
 * Coverage: POST /api/servers — the secret-encryption branch
 * (src/web/server.ts ~261-276).
 *
 * The existing POST /api/servers tests only add secret-free servers, so the
 * scan → key-gen → substitute → encrypt branch never runs. This file POSTs a
 * server whose env contains an inline secret and asserts:
 *   - the stored config.toml has the env value replaced by `${VAR}`,
 *   - settings.env[VAR] holds an `enc:` envelope (NOT the plaintext),
 *   - the master key was LAZILY generated when none existed (the
 *     `if (!key) { generateKey(); saveKey(); }` branch),
 *   - and the round-trip decrypt recovers the original plaintext.
 *
 * Uses the real adapter registry — no mocking. Builds a real temp config dir +
 * git repo + app, and redirects AM_KEY_PATH to a temp path so the real OS key
 * dir is never touched and the lazy-generation branch is observable.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as TOML from "@iarna/toml";
import { initRepo } from "../../src/core/git";
import { decryptValue, loadKey } from "../../src/core/secrets";
import { createApp, ensureAuthToken } from "../../src/web/server";

let tmpDir: string;
let keyPath: string;
let authToken: string;
const originalConfigDir = process.env.AM_CONFIG_DIR;
const originalKeyPath = process.env.AM_KEY_PATH;
const originalEncKey = process.env.AM_ENCRYPTION_KEY;
const originalBackend = process.env.AM_SECRETS_BACKEND;

async function readConfigToml(): Promise<TOML.JsonMap> {
  const raw = await readFile(join(tmpDir, "config.toml"), "utf-8");
  return TOML.parse(raw);
}

async function fileExists(p: string): Promise<boolean> {
  return readFile(p, "utf-8").then(
    () => true,
    () => false,
  );
}

beforeAll(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "am-web-secret-"));
  keyPath = join(tmpDir, "key-data", "key");
  await initRepo(tmpDir);

  await writeFile(
    join(tmpDir, "config.toml"),
    TOML.stringify({
      settings: { default_profile: "default" },
      servers: {},
      profiles: { default: { description: "Default profile" } },
    } as TOML.JsonMap),
  );

  process.env.AM_CONFIG_DIR = tmpDir;
  // Lazy key-gen is only observable if no key exists yet AND no env key
  // short-circuits loadKey().
  process.env.AM_KEY_PATH = keyPath;
  Reflect.deleteProperty(process.env, "AM_ENCRYPTION_KEY");
  Reflect.deleteProperty(process.env, "AM_SECRETS_BACKEND");

  authToken = ensureAuthToken(tmpDir);
});

afterAll(async () => {
  if (originalConfigDir === undefined) Reflect.deleteProperty(process.env, "AM_CONFIG_DIR");
  else process.env.AM_CONFIG_DIR = originalConfigDir;
  if (originalKeyPath === undefined) Reflect.deleteProperty(process.env, "AM_KEY_PATH");
  else process.env.AM_KEY_PATH = originalKeyPath;
  if (originalEncKey === undefined) Reflect.deleteProperty(process.env, "AM_ENCRYPTION_KEY");
  else process.env.AM_ENCRYPTION_KEY = originalEncKey;
  if (originalBackend === undefined) Reflect.deleteProperty(process.env, "AM_SECRETS_BACKEND");
  else process.env.AM_SECRETS_BACKEND = originalBackend;
  await rm(tmpDir, { recursive: true, force: true });
});

describe("POST /api/servers — secret-encryption branch", () => {
  it("scans, substitutes ${VAR}, encrypts to settings.env, and lazily generates a key", async () => {
    // Precondition: no master key on disk → the handler must generate one.
    expect(await fileExists(keyPath)).toBe(false);

    const secretValue = "sk-realisticlookingkey-0123456789ABCDEFabcdef0123456789";

    const app = await createApp();
    const res = await app.request("/api/servers", {
      method: "POST",
      headers: { "Content-Type": "application/json", authorization: `Bearer ${authToken}` },
      body: JSON.stringify({
        name: "openai-srv",
        command: "node",
        args: ["server.js"],
        // OPENAI_API_KEY matches tier-1 key-name patterns deterministically.
        env: { OPENAI_API_KEY: secretValue },
      }),
    });
    expect(res.status).toBe(201);
    const data = (await res.json()) as { action: string; server: string };
    expect(data.action).toBe("add");
    expect(data.server).toBe("openai-srv");

    const cfg = (await readConfigToml()) as {
      settings?: { env?: Record<string, string> };
      servers?: Record<string, { env?: Record<string, string> }>;
    };

    // 1. The server env value was replaced by the ${VAR} reference (the
    //    suggested env var for a key-name hit is the original key name).
    expect(cfg.servers?.["openai-srv"]?.env?.OPENAI_API_KEY).toBe("${OPENAI_API_KEY}");

    // 2. settings.env holds an `enc:` envelope, NOT the plaintext.
    const stored = cfg.settings?.env?.OPENAI_API_KEY ?? "";
    expect(stored.startsWith("enc:")).toBe(true);
    expect(stored).not.toContain(secretValue);

    // 3. No plaintext secret survives anywhere in the serialized config.
    expect(JSON.stringify(cfg)).not.toContain(secretValue);

    // 4. The master key was lazily generated at AM_KEY_PATH.
    expect(await fileExists(keyPath)).toBe(true);

    // 5. The envelope decrypts back to the original plaintext.
    const key = await loadKey(tmpDir);
    expect(key).not.toBeNull();
    if (key) {
      expect(await decryptValue(stored, key)).toBe(secretValue);
    }
  });

  it("reuses the existing key on a second secret-bearing POST (no regeneration)", async () => {
    // After the first test a key exists; capture it, POST another secret, and
    // assert the SAME key still decrypts — i.e. the `if (!key)` branch was NOT
    // taken a second time.
    const keyBefore = await readFile(keyPath, "utf-8");
    const secretValue = "ghp_anotherRealisticLookingToken0123456789abcdef0123";

    const app = await createApp();
    const res = await app.request("/api/servers", {
      method: "POST",
      headers: { "Content-Type": "application/json", authorization: `Bearer ${authToken}` },
      body: JSON.stringify({
        name: "github-srv",
        command: "node",
        args: ["gh.js"],
        env: { GITHUB_TOKEN: secretValue },
      }),
    });
    expect(res.status).toBe(201);

    const keyAfter = await readFile(keyPath, "utf-8");
    expect(keyAfter).toBe(keyBefore);

    const cfg = (await readConfigToml()) as {
      settings?: { env?: Record<string, string> };
      servers?: Record<string, { env?: Record<string, string> }>;
    };
    expect(cfg.servers?.["github-srv"]?.env?.GITHUB_TOKEN).toBe("${GITHUB_TOKEN}");
    const stored = cfg.settings?.env?.GITHUB_TOKEN ?? "";
    expect(stored.startsWith("enc:")).toBe(true);

    const key = await loadKey(tmpDir);
    expect(key).not.toBeNull();
    if (key) {
      expect(await decryptValue(stored, key)).toBe(secretValue);
    }
  });
});
