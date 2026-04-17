import { mkdir, readFile, stat, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { atomicWriteFile } from "./atomic-write";
import type { Config } from "./schema";

// --- Encryption constants ---
const ALGO = "AES-GCM";
const PREFIX = "enc:v1:";
const KEY_LENGTH = 256;
const IV_LENGTH = 12;

// --- Key storage path resolution ---

/**
 * Return the OS-appropriate data directory path for the AES master key.
 *
 * The key lives OUTSIDE the agent-manager config dir (which is a git repo)
 * so that `commitAll` cannot stage and push it alongside the ciphertext it
 * protects.
 *
 * - macOS:   ~/Library/Application Support/agent-manager/key
 * - Linux:   $XDG_DATA_HOME/agent-manager/key
 *            (default ~/.local/share/agent-manager/key)
 * - Windows: %APPDATA%/agent-manager/key
 * - Other:   ~/.local/share/agent-manager/key (XDG fallback)
 *
 * Respects `AM_KEY_PATH` env var as an absolute override for tests/advanced use.
 */
export function resolveKeyPath(): string {
  // Explicit override (tests, advanced users)
  if (process.env.AM_KEY_PATH) {
    return process.env.AM_KEY_PATH;
  }

  const platform = process.platform;
  const home = homedir();

  if (platform === "darwin") {
    return join(home, "Library", "Application Support", "agent-manager", "key");
  }

  if (platform === "win32") {
    const appData = process.env.APPDATA ?? join(home, "AppData", "Roaming");
    return join(appData, "agent-manager", "key");
  }

  // Linux + other POSIX: XDG_DATA_HOME or ~/.local/share
  const xdgDataHome = process.env.XDG_DATA_HOME ?? join(home, ".local", "share");
  return join(xdgDataHome, "agent-manager", "key");
}

/** Return the legacy (insecure) key path inside the config dir. */
export function legacyKeyPath(configDir: string): string {
  return join(configDir, ".agent-manager", "key.txt");
}

/** Check if a path exists (non-throwing). */
async function pathExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Result of a key-path migration attempt.
 * - `migrated`: moved legacy → new
 * - `none`:     no legacy present, no action needed
 * - `conflict`: both existed, new kept, legacy left in place with warning
 */
export type MigrationResult =
  | { kind: "none" }
  | { kind: "migrated"; from: string; to: string }
  | { kind: "conflict"; legacy: string; current: string };

/**
 * If a legacy key exists in the git-tracked config dir but the new OS-data-dir
 * key does not, move it. If both exist, keep the new one and flag a conflict
 * so the caller can warn the user.
 *
 * Safe to call every time `loadKey`/`saveKey` runs.
 */
export async function migrateLegacyKey(configDir: string): Promise<MigrationResult> {
  const legacy = legacyKeyPath(configDir);
  const current = resolveKeyPath();

  const legacyExists = await pathExists(legacy);
  if (!legacyExists) return { kind: "none" };

  const currentExists = await pathExists(current);
  if (currentExists) {
    // Both present — new wins; leave legacy for user to delete, warn via result.
    return { kind: "conflict", legacy, current };
  }

  // Move: read legacy, write new with 0600, unlink legacy.
  const contents = await readFile(legacy, "utf-8");
  await mkdir(dirname(current), { recursive: true });
  await atomicWriteFile(current, contents, { mode: 0o600 });
  try {
    await unlink(legacy);
  } catch {
    // If unlink fails (e.g., permissions), new is in place — still a win.
  }
  return { kind: "migrated", from: legacy, to: current };
}

// --- Encryption functions ---

/** Generate a 256-bit AES key, return as base64 string. */
export async function generateKey(): Promise<string> {
  const key = await crypto.subtle.generateKey({ name: ALGO, length: KEY_LENGTH }, true, [
    "encrypt",
    "decrypt",
  ]);
  const raw = await crypto.subtle.exportKey("raw", key);
  return btoa(String.fromCharCode(...new Uint8Array(raw)));
}

/** Import a base64 string as a CryptoKey. */
export async function importKey(base64: string): Promise<CryptoKey> {
  const raw = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  return crypto.subtle.importKey("raw", raw, { name: ALGO }, true, ["encrypt", "decrypt"]);
}

/**
 * Load the encryption key.
 *
 * Priority:
 *   1. `AM_ENCRYPTION_KEY` env var (takes absolute precedence)
 *   2. OS data-dir key (`resolveKeyPath()`)
 *   3. Legacy `configDir/.agent-manager/key.txt` (auto-migrated if found alone)
 *
 * Migration: if the legacy path exists and the new path does not, the legacy
 * key is moved to the new path (mode 0600) and the legacy file is deleted.
 * One info line is emitted to stderr to notify the user.
 */
export async function loadKey(configDir: string): Promise<CryptoKey | null> {
  // Priority: env var > file
  const envKey = process.env.AM_ENCRYPTION_KEY;
  if (envKey) {
    return importKey(envKey.trim());
  }

  // Attempt migration first (no-op if nothing to migrate).
  const migration = await migrateLegacyKey(configDir);
  if (migration.kind === "migrated") {
    // One-line info; avoid stdout so JSON-mode callers aren't polluted.
    console.error(
      `info: Migrated master key out of config dir — do not commit ${migration.from} if you still see it.`,
    );
  } else if (migration.kind === "conflict") {
    console.error(
      `warning: Master key found in BOTH ${migration.current} (active) and legacy ${migration.legacy}. The legacy file is ignored; delete it and ensure it is not committed.`,
    );
  }

  const keyPath = resolveKeyPath();
  try {
    const contents = await readFile(keyPath, "utf-8");
    return importKey(contents.trim());
  } catch {
    return null;
  }
}

/**
 * Write base64 key to the OS-appropriate data-dir path (NOT the git-tracked
 * config dir). Creates parent directories as needed and enforces mode 0600.
 *
 * The `configDir` parameter is retained for API compatibility but is no
 * longer used to locate the key — `resolveKeyPath()` is the source of truth.
 */
export async function saveKey(_configDir: string, base64Key: string): Promise<void> {
  const keyPath = resolveKeyPath();
  await mkdir(dirname(keyPath), { recursive: true });
  await atomicWriteFile(keyPath, `${base64Key}\n`, { mode: 0o600 });
}

/** AES-256-GCM encrypt a plaintext string. Returns "enc:v1:nonce_b64:ciphertext_b64". */
export async function encryptValue(plaintext: string, key: CryptoKey): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
  const encoded = new TextEncoder().encode(plaintext);
  const ciphertext = await crypto.subtle.encrypt({ name: ALGO, iv }, key, encoded);
  const ivB64 = btoa(String.fromCharCode(...iv));
  const ctB64 = btoa(String.fromCharCode(...new Uint8Array(ciphertext)));
  return `${PREFIX}${ivB64}:${ctB64}`;
}

/** Decrypt an "enc:v1:..." value. Passes through non-encrypted strings unchanged. */
export async function decryptValue(encrypted: string, key: CryptoKey): Promise<string> {
  if (!isEncrypted(encrypted)) return encrypted;
  const payload = encrypted.slice(PREFIX.length);
  const colonIdx = payload.indexOf(":");
  const ivB64 = payload.slice(0, colonIdx);
  const ctB64 = payload.slice(colonIdx + 1);
  const iv = Uint8Array.from(atob(ivB64), (c) => c.charCodeAt(0));
  const ct = Uint8Array.from(atob(ctB64), (c) => c.charCodeAt(0));
  const plaintext = await crypto.subtle.decrypt({ name: ALGO, iv }, key, ct);
  return new TextDecoder().decode(plaintext);
}

/** Check if a string is an encrypted value (starts with "enc:v1:"). */
export function isEncrypted(value: string): boolean {
  return value.startsWith(PREFIX);
}

// --- Interpolation ---

export interface InterpolateOptions {
  strict?: boolean;
  extraEnv?: Record<string, string>;
}

export interface InterpolateResult {
  config: Config;
  warnings: string[];
}

// Matches ${VAR} but not $${VAR} (escaped)
const VAR_PATTERN = /\$\$\{[^}]+\}|\$\{([^}]+)\}/g;

/**
 * Deep-walk all string values in config, resolving `${VAR}` references.
 *
 * - `${VAR}` resolves from extraEnv first, then process.env
 * - `$${VAR}` escapes to the literal string `${VAR}`
 * - Unresolved variables: warn (non-strict) or throw (strict)
 */
export function interpolateEnv(
  config: Config,
  options: InterpolateOptions = {},
): InterpolateResult {
  const { strict = false, extraEnv = {} } = options;
  const warnings: string[] = [];

  function resolveValue(value: string): string {
    return value.replace(VAR_PATTERN, (match, varName?: string) => {
      // Escaped: $${VAR} -> literal ${VAR}
      if (match.startsWith("$$")) {
        return match.slice(1); // drop first $
      }

      // Resolve from extraEnv first (explicit overrides), then process.env
      const resolved = extraEnv[varName!] ?? process.env[varName!];
      if (resolved !== undefined) {
        return resolved;
      }

      // Unresolved
      const msg = `Unresolved variable: \${${varName}}`;
      if (strict) {
        throw new Error(msg);
      }
      warnings.push(msg);
      return match; // leave as-is
    });
  }

  function walkValue(value: unknown): unknown {
    if (typeof value === "string") {
      return resolveValue(value);
    }
    if (Array.isArray(value)) {
      return value.map(walkValue);
    }
    if (value !== null && typeof value === "object") {
      return walkObject(value as Record<string, unknown>);
    }
    return value;
  }

  function walkObject(obj: Record<string, unknown>): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(obj)) {
      result[key] = walkValue(val);
    }
    return result;
  }

  const interpolated = walkObject(config as Record<string, unknown>) as Config;
  return { config: interpolated, warnings };
}

/**
 * Async interpolation that also decrypts `enc:v1:` values.
 * Performs variable interpolation first, then walks all strings to decrypt.
 */
export async function interpolateEnvAsync(
  config: Config,
  options: InterpolateOptions & { encryptionKey?: CryptoKey } = {},
): Promise<InterpolateResult> {
  const { encryptionKey, ...interpolateOpts } = options;
  const result = interpolateEnv(config, interpolateOpts);

  if (!encryptionKey) return result;

  // Walk the interpolated config and decrypt any enc:v1: values
  async function walkDecrypt(value: unknown): Promise<unknown> {
    if (typeof value === "string" && isEncrypted(value)) {
      return decryptValue(value, encryptionKey!);
    }
    if (Array.isArray(value)) {
      return Promise.all(value.map(walkDecrypt));
    }
    if (value !== null && typeof value === "object") {
      const obj = value as Record<string, unknown>;
      const entries = await Promise.all(
        Object.entries(obj).map(async ([k, v]) => [k, await walkDecrypt(v)] as const),
      );
      return Object.fromEntries(entries);
    }
    return value;
  }

  const decrypted = (await walkDecrypt(result.config)) as Config;
  return { config: decrypted, warnings: result.warnings };
}
