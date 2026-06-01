import { mkdir, readFile, stat, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { atomicWriteFile } from "./atomic-write";
import type { Config } from "./schema";
import type { SecretEnvelope, SecretsBackend } from "./secrets-backend";
import { getBackend, registerBackend } from "./secrets-backend";
import { type DecodeBackends, decodeEnvelope } from "./secrets-decode";

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
 * Async interpolation that also decrypts encrypted envelopes.
 *
 * Performs variable interpolation first, then walks all strings to decrypt.
 *
 * Decoding is **format-aware and fail-loud** (P0-3 fix): every envelope is
 * dispatched through `decodeEnvelope`, which routes `enc:v1:` to the AES-GCM
 * key, `enc:v2:age:` to the age backend, and THROWS on any unrecognised
 * `enc:` prefix. It never passes ciphertext through verbatim — that was the
 * bug that let age-migrated secrets leak as plaintext into native configs.
 *
 * - Pass `encryptionKey` to decrypt legacy `enc:v1:` envelopes.
 * - Pass `ageBackend` to decrypt `enc:v2:age:` envelopes.
 * - If an envelope is encountered without a backend that can decrypt it
 *   (e.g. a v2 envelope with no `ageBackend`, or any envelope with no key),
 *   decode THROWS (MissingBackendError) — the apply aborts rather than
 *   corrupting configs.
 * - An unknown `enc:` prefix THROWS (UnknownEnvelopeError).
 *
 * Plaintext (including `${VAR}`-expanded strings) always flows through
 * untouched. The walk ALWAYS runs — there is deliberately no "no backend →
 * skip decryption" shortcut, because that shortcut was the exact bug that let
 * `enc:v2:age:` / unknown envelopes leak verbatim into native configs.
 */
export async function interpolateEnvAsync(
  config: Config,
  options: InterpolateOptions & {
    encryptionKey?: CryptoKey;
    ageBackend?: SecretsBackend | null;
  } = {},
): Promise<InterpolateResult> {
  const { encryptionKey, ageBackend, ...interpolateOpts } = options;
  const result = interpolateEnv(config, interpolateOpts);

  const backends: DecodeBackends = {
    legacyKey: encryptionKey ?? null,
    ageBackend: ageBackend ?? null,
  };

  // Walk the interpolated config and decode any encrypted envelopes via the
  // format-aware, fail-loud dispatcher. `decodeEnvelope` returns plaintext
  // unchanged and only acts on (or throws for) `enc:`-prefixed values.
  async function walkDecrypt(value: unknown): Promise<unknown> {
    // Route every `enc:`-prefixed string through the fail-loud dispatcher —
    // known envelopes decrypt, unknown ones throw, ciphertext never leaks.
    if (typeof value === "string" && value.startsWith("enc:")) {
      return decodeEnvelope(value, backends);
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

// --- SecretsBackend adapter (ADR-0042 scaffolding) ---
//
// Thin wrapper over `encryptValue`/`decryptValue` that conforms to the
// `SecretsBackend` interface. Today's behaviour is unchanged — the
// adapter is additive scaffolding that future apply/decrypt paths can
// depend on without committing to a particular implementation.
//
// Not yet wired into any caller. Recipient-management methods are
// intentionally omitted because AES-GCM is single-key.

/** Optional shape accepted by `AesGcmLegacyBackendFactory.load`. */
export interface AesGcmLegacyBackendConfig {
  /** Pre-imported key. If omitted, must be set via `setKey` before use. */
  key?: CryptoKey;
}

/**
 * Adapter implementing `SecretsBackend` over the legacy module-level
 * AES-256-GCM primitives. Single-key, single-recipient.
 */
export class AesGcmLegacyBackend implements SecretsBackend {
  readonly name = "aes-gcm-legacy" as const;
  readonly version = 1;

  #key: CryptoKey | null;

  constructor(key: CryptoKey | null = null) {
    this.#key = key;
  }

  /** Install or replace the active CryptoKey. */
  setKey(key: CryptoKey): void {
    this.#key = key;
  }

  /** Whether a key has been installed. */
  hasKey(): boolean {
    return this.#key !== null;
  }

  async encrypt(plaintext: string): Promise<SecretEnvelope> {
    if (!this.#key) {
      throw new Error(
        "AesGcmLegacyBackend: no key loaded — call setKey() or pass one to the constructor.",
      );
    }
    return encryptValue(plaintext, this.#key);
  }

  async decrypt(envelope: SecretEnvelope): Promise<string> {
    if (!this.#key) {
      throw new Error(
        "AesGcmLegacyBackend: no key loaded — call setKey() or pass one to the constructor.",
      );
    }
    return decryptValue(envelope, this.#key);
  }
}

// Side-effect registration: importing `core/secrets` registers the
// legacy backend under the name `aes-gcm-legacy`. The factory accepts
// `{ key?: CryptoKey }`; callers that do not supply a key must install
// one via `backend.setKey(key)` before calling `encrypt`/`decrypt`.
registerBackend({
  name: "aes-gcm-legacy",
  async load(config: unknown): Promise<SecretsBackend> {
    const cfg = (config ?? {}) as AesGcmLegacyBackendConfig;
    return new AesGcmLegacyBackend(cfg.key ?? null);
  },
});

// --- Backend selection (ADR-0042) --------------------------------------

/**
 * Name of the backend used when NEW envelopes are produced. Reading
 * legacy `enc:v1:` envelopes always delegates to `AesGcmLegacyBackend`
 * regardless of this value — this only controls the write-side choice.
 */
export type SelectableBackendName = "age" | "aes-gcm-legacy";

/**
 * Inspect a `Config` (from `config.toml` or a merged resolved config)
 * and return the configured default backend name. Falls back to
 * `aes-gcm-legacy` when unset or unrecognised.
 *
 * Priority order:
 *   1. `AM_SECRETS_BACKEND` env var (`age` or `aes-gcm-legacy`)
 *   2. `config.settings.secrets.backend`
 *   3. `"aes-gcm-legacy"` (default)
 */
export function selectBackendName(config: Config | null | undefined): SelectableBackendName {
  const envChoice = process.env.AM_SECRETS_BACKEND?.trim().toLowerCase();
  if (envChoice === "age" || envChoice === "aes-gcm-legacy") {
    return envChoice;
  }
  const cfgChoice = (config?.settings as { secrets?: { backend?: string } } | undefined)?.secrets
    ?.backend;
  if (cfgChoice === "age" || cfgChoice === "aes-gcm-legacy") {
    return cfgChoice;
  }
  return "aes-gcm-legacy";
}

/**
 * Options accepted by `getDefaultBackend`. Most callers can pass `{}`
 * — the loader resolves the config, imports the legacy key, and wires
 * the `age` backend with an env-var passphrase provider by default.
 */
export interface GetDefaultBackendOptions {
  /** Override the config read from disk (useful for tests). */
  config?: Config | null;
  /**
   * Force a specific backend regardless of config. Still falls back to
   * the legacy backend if `"age"` is requested but the age module has
   * not been imported (registered) yet.
   */
  override?: SelectableBackendName;
  /**
   * Passphrase provider for the `age` backend. Defaults to the env-var
   * provider reading `AM_AGE_PASSPHRASE`. Not used when the selected
   * backend is `aes-gcm-legacy`.
   */
  passphraseProvider?: (kind: "create" | "unlock") => Promise<string>;
}

/**
 * Resolve the active `SecretsBackend` for a given config directory.
 *
 * - Reads `config.toml` to discover `settings.secrets.backend`.
 * - If `"age"` is selected, dynamically imports `./secrets-age` (which
 *   self-registers the factory), then loads it with a passphrase
 *   provider (env-var by default).
 * - Otherwise loads the legacy AES-GCM backend with the machine key
 *   resolved via `loadKey`. Throws a descriptive error when the key
 *   is missing so callers can surface a clear message.
 *
 * Callers should not cache the result across config edits — the
 * selection can change when `settings.secrets.backend` is flipped.
 */
export async function getDefaultBackend(
  configDir: string,
  options: GetDefaultBackendOptions = {},
): Promise<SecretsBackend> {
  let config: Config | null | undefined = options.config;
  if (config === undefined) {
    // Lazy import to avoid a cycle (`core/config` pulls `core/secrets`).
    const { tryReadConfig } = await import("./config");
    config = await tryReadConfig(join(configDir, "config.toml"));
  }

  const chosen = options.override ?? selectBackendName(config ?? null);

  if (chosen === "age") {
    // Side-effect import registers the `age` factory.
    const ageModule = await import("./secrets-age");
    const factory = getBackend("age");
    if (!factory) {
      throw new Error(
        "getDefaultBackend: `age` backend selected but its factory is not registered — check that `src/core/secrets-age.ts` is importable.",
      );
    }
    // Thread Argon2id overrides from `settings.secrets.argon2` into
    // the factory. Validation happens inside the AgeSecretsBackend
    // constructor — a bad override fails loudly here.
    const argon2Override = (
      config?.settings as
        | { secrets?: { argon2?: Partial<import("./secrets-age").Argon2idParams> } }
        | undefined
    )?.secrets?.argon2;
    return factory.load({
      passphraseProvider: options.passphraseProvider ?? ageModule.envPassphraseProvider(),
      ...(argon2Override !== undefined && { argon2: argon2Override }),
    });
  }

  // Legacy AES-GCM. Load the machine key up front so encrypt/decrypt
  // don't fail with a vague "no key loaded" message.
  const key = await loadKey(configDir);
  if (!key) {
    throw new Error(
      "getDefaultBackend: aes-gcm-legacy selected but no encryption key is available — run `am secret generate-key` or set AM_ENCRYPTION_KEY.",
    );
  }
  return new AesGcmLegacyBackend(key);
}

/**
 * Return `true` when `envelope` is an ADR-0012 v1 AES-GCM envelope
 * (`enc:v1:<iv>:<ct>`). Anything else — including the ADR-0042 v2 age
 * envelope (`enc:v2:age:...`) — returns `false`.
 *
 * Used by migration logic to decide whether a value should be piped
 * through `AesGcmLegacyBackend` for a forward-port to the current
 * backend.
 */
export function isLegacyV1Envelope(value: string): boolean {
  return typeof value === "string" && value.startsWith(PREFIX);
}

/**
 * Return `true` when `envelope` is any recognised encrypted envelope
 * (v1 legacy or v2 age). Useful for generic scans that don't care
 * about the backend.
 */
export function isAnyEnvelope(value: string): boolean {
  if (typeof value !== "string") return false;
  return value.startsWith(PREFIX) || value.startsWith("enc:v2:age:");
}
