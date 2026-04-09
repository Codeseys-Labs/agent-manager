import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Config } from "./schema";

// --- Encryption constants ---
const ALGO = "AES-GCM";
const PREFIX = "enc:v1:";
const KEY_LENGTH = 256;
const IV_LENGTH = 12;

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

/** Load the encryption key from AM_ENCRYPTION_KEY env var or .agent-manager/key.txt file. */
export async function loadKey(configDir: string): Promise<CryptoKey | null> {
  // Priority: env var > file
  const envKey = process.env.AM_ENCRYPTION_KEY;
  if (envKey) {
    return importKey(envKey.trim());
  }

  try {
    const keyPath = join(configDir, ".agent-manager", "key.txt");
    const contents = await readFile(keyPath, "utf-8");
    return importKey(contents.trim());
  } catch {
    return null;
  }
}

/** Write base64 key to .agent-manager/key.txt. */
export async function saveKey(configDir: string, base64Key: string): Promise<void> {
  const keyPath = join(configDir, ".agent-manager", "key.txt");
  await writeFile(keyPath, `${base64Key}\n`, { encoding: "utf-8", mode: 0o600 });
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
 * - `${VAR}` resolves from process.env first, then extraEnv
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
