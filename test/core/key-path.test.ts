import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  generateKey,
  importKey,
  legacyKeyPath,
  loadKey,
  migrateLegacyKey,
  resolveKeyPath,
  saveKey,
} from "../../src/core/secrets";
import { type TestDir, createTestDir } from "../helpers/tmp";

/**
 * Unit tests for the Wave 1.C key-storage hardening:
 *
 *   - resolveKeyPath() returns the OS-appropriate data-dir path
 *   - legacy key at ~/.config/.../.agent-manager/key.txt is migrated out
 *   - loadKey happy path + env var precedence
 */

// Helper: track env overrides and restore after each test.
function envSandbox() {
  const saved: Record<string, string | undefined> = {};
  return {
    set(key: string, value: string | undefined) {
      if (!(key in saved)) saved[key] = process.env[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    },
    restore() {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      for (const key of Object.keys(saved)) delete saved[key];
    },
  };
}

describe("resolveKeyPath", () => {
  const env = envSandbox();
  const origPlatform = process.platform;

  function setPlatform(platform: NodeJS.Platform) {
    // `process.platform` is a non-writable getter on some runtimes —
    // redefine it for the test and restore after.
    Object.defineProperty(process, "platform", {
      value: platform,
      configurable: true,
    });
  }

  afterEach(() => {
    env.restore();
    setPlatform(origPlatform);
  });

  test("AM_KEY_PATH override takes precedence on all platforms", () => {
    env.set("AM_KEY_PATH", "/tmp/override/key");
    setPlatform("darwin");
    expect(resolveKeyPath()).toBe("/tmp/override/key");
    setPlatform("linux");
    expect(resolveKeyPath()).toBe("/tmp/override/key");
    setPlatform("win32");
    expect(resolveKeyPath()).toBe("/tmp/override/key");
  });

  test("macOS: returns ~/Library/Application Support/agent-manager/key", () => {
    env.set("AM_KEY_PATH", undefined);
    setPlatform("darwin");
    const expected = join(homedir(), "Library", "Application Support", "agent-manager", "key");
    expect(resolveKeyPath()).toBe(expected);
  });

  test("Linux: uses XDG_DATA_HOME when set", () => {
    env.set("AM_KEY_PATH", undefined);
    env.set("XDG_DATA_HOME", "/custom/xdg-data");
    setPlatform("linux");
    expect(resolveKeyPath()).toBe("/custom/xdg-data/agent-manager/key");
  });

  test("Linux: falls back to ~/.local/share when XDG_DATA_HOME unset", () => {
    env.set("AM_KEY_PATH", undefined);
    env.set("XDG_DATA_HOME", undefined);
    setPlatform("linux");
    const expected = join(homedir(), ".local", "share", "agent-manager", "key");
    expect(resolveKeyPath()).toBe(expected);
  });

  test("Windows: uses %APPDATA% when set", () => {
    env.set("AM_KEY_PATH", undefined);
    env.set("APPDATA", "C:\\Users\\Test\\AppData\\Roaming");
    setPlatform("win32");
    expect(resolveKeyPath()).toBe(
      join("C:\\Users\\Test\\AppData\\Roaming", "agent-manager", "key"),
    );
  });

  test("Windows: falls back to ~/AppData/Roaming when APPDATA unset", () => {
    env.set("AM_KEY_PATH", undefined);
    env.set("APPDATA", undefined);
    setPlatform("win32");
    const expected = join(homedir(), "AppData", "Roaming", "agent-manager", "key");
    expect(resolveKeyPath()).toBe(expected);
  });

  test("Unknown platform: falls back to XDG-style path", () => {
    env.set("AM_KEY_PATH", undefined);
    env.set("XDG_DATA_HOME", undefined);
    setPlatform("freebsd" as NodeJS.Platform);
    const expected = join(homedir(), ".local", "share", "agent-manager", "key");
    expect(resolveKeyPath()).toBe(expected);
  });

  test("never points inside a typical config dir", () => {
    env.set("AM_KEY_PATH", undefined);
    const p = resolveKeyPath();
    // Regression: the whole point of Wave 1.C is that the key is NOT under
    // ~/.config/agent-manager (which is the default config dir and a git repo).
    expect(p).not.toContain(".config/agent-manager");
  });
});

describe("legacyKeyPath", () => {
  test("returns configDir/.agent-manager/key.txt", () => {
    expect(legacyKeyPath("/tmp/am-config")).toBe("/tmp/am-config/.agent-manager/key.txt");
  });
});

describe("migrateLegacyKey", () => {
  const env = envSandbox();
  let configDir: TestDir;
  let keyDir: TestDir;

  beforeEach(async () => {
    configDir = await createTestDir("am-migrate-cfg-");
    keyDir = await createTestDir("am-migrate-key-");
    env.set("AM_KEY_PATH", join(keyDir.path, "key"));
    env.set("AM_ENCRYPTION_KEY", undefined);
  });

  afterEach(async () => {
    await configDir.cleanup();
    await keyDir.cleanup();
    env.restore();
  });

  test("kind='none' when no legacy file exists", async () => {
    const result = await migrateLegacyKey(configDir.path);
    expect(result.kind).toBe("none");
  });

  test("migrates when legacy exists and new does not", async () => {
    // Seed legacy file.
    const base64 = await generateKey();
    const legacyPath = legacyKeyPath(configDir.path);
    await mkdir(join(legacyPath, ".."), { recursive: true });
    await writeFile(legacyPath, `${base64}\n`);

    const result = await migrateLegacyKey(configDir.path);
    expect(result.kind).toBe("migrated");
    if (result.kind !== "migrated") throw new Error("unreachable");
    expect(result.from).toBe(legacyPath);
    expect(result.to).toBe(resolveKeyPath());

    // New file exists with expected contents.
    const contents = await readFile(resolveKeyPath(), "utf-8");
    expect(contents.trim()).toBe(base64);

    // Legacy file was removed.
    await expect(stat(legacyPath)).rejects.toThrow();
  });

  test("migrated file is mode 0600", async () => {
    // Skip on Windows where chmod semantics differ.
    if (process.platform === "win32") return;

    const base64 = await generateKey();
    const legacyPath = legacyKeyPath(configDir.path);
    await mkdir(join(legacyPath, ".."), { recursive: true });
    await writeFile(legacyPath, `${base64}\n`, { mode: 0o644 });

    await migrateLegacyKey(configDir.path);
    const st = await stat(resolveKeyPath());
    // Lower 9 bits = permission bits; 0o600 = rw-------.
    expect(st.mode & 0o777).toBe(0o600);
  });

  test("conflict: both exist → new wins, legacy untouched, result flags conflict", async () => {
    const legacyBase64 = await generateKey();
    const newBase64 = await generateKey();
    expect(legacyBase64).not.toBe(newBase64);

    const legacyPath = legacyKeyPath(configDir.path);
    await mkdir(join(legacyPath, ".."), { recursive: true });
    await writeFile(legacyPath, `${legacyBase64}\n`);

    const newPath = resolveKeyPath();
    await mkdir(join(newPath, ".."), { recursive: true });
    await writeFile(newPath, `${newBase64}\n`);

    const result = await migrateLegacyKey(configDir.path);
    expect(result.kind).toBe("conflict");
    if (result.kind !== "conflict") throw new Error("unreachable");
    expect(result.legacy).toBe(legacyPath);
    expect(result.current).toBe(newPath);

    // Both files still exist.
    await expect(stat(legacyPath)).resolves.toBeDefined();
    await expect(stat(newPath)).resolves.toBeDefined();

    // New content unchanged.
    const newContents = await readFile(newPath, "utf-8");
    expect(newContents.trim()).toBe(newBase64);
    // Legacy content unchanged.
    const legacyContents = await readFile(legacyPath, "utf-8");
    expect(legacyContents.trim()).toBe(legacyBase64);

    // loadKey should pick the new one.
    const loaded = await loadKey(configDir.path);
    expect(loaded).not.toBeNull();
    const expectedKey = await importKey(newBase64);
    expect(loaded!.algorithm).toEqual(expectedKey.algorithm);
  });
});

describe("loadKey happy path (Wave 1.C storage)", () => {
  const env = envSandbox();
  let configDir: TestDir;
  let keyDir: TestDir;

  beforeEach(async () => {
    configDir = await createTestDir("am-loadkey-happy-cfg-");
    keyDir = await createTestDir("am-loadkey-happy-key-");
    env.set("AM_KEY_PATH", join(keyDir.path, "key"));
    env.set("AM_ENCRYPTION_KEY", undefined);
  });

  afterEach(async () => {
    await configDir.cleanup();
    await keyDir.cleanup();
    env.restore();
  });

  test("saveKey → loadKey roundtrip at AM_KEY_PATH location", async () => {
    const base64 = await generateKey();
    await saveKey(configDir.path, base64);

    // File lives at AM_KEY_PATH, NOT in the config dir.
    const keyPath = process.env.AM_KEY_PATH!;
    await expect(stat(keyPath)).resolves.toBeDefined();

    // The legacy location must remain empty.
    await expect(stat(legacyKeyPath(configDir.path))).rejects.toThrow();

    const loaded = await loadKey(configDir.path);
    expect(loaded).not.toBeNull();
  });

  test("loadKey migrates legacy key on first read", async () => {
    // Seed legacy key only — no new-path key.
    const base64 = await generateKey();
    const legacyPath = legacyKeyPath(configDir.path);
    await mkdir(join(legacyPath, ".."), { recursive: true });
    await writeFile(legacyPath, `${base64}\n`);

    const loaded = await loadKey(configDir.path);
    expect(loaded).not.toBeNull();

    // After loadKey, legacy is gone and new path has the key.
    await expect(stat(legacyPath)).rejects.toThrow();
    const contents = await readFile(resolveKeyPath(), "utf-8");
    expect(contents.trim()).toBe(base64);
  });

  test("returns null when no key anywhere", async () => {
    const loaded = await loadKey(configDir.path);
    expect(loaded).toBeNull();
  });

  test("saveKey enforces mode 0600 at AM_KEY_PATH", async () => {
    if (process.platform === "win32") return;
    const base64 = await generateKey();
    await saveKey(configDir.path, base64);
    const st = await stat(process.env.AM_KEY_PATH!);
    expect(st.mode & 0o777).toBe(0o600);
  });
});
