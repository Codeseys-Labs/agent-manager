/**
 * AgeSecretsBackend — ADR-0042 per-machine age identity backend.
 *
 * See ADR-0042 (Universal secrets strategy). This backend:
 *
 *   1. Generates a per-machine X25519 age identity (`AGE-SECRET-KEY-1...`)
 *      via `age-encryption`'s `generateIdentity()`.
 *   2. Stores the identity passphrase-wrapped at
 *      `~/.config/agent-manager/identities/identity.age`. The wrapping
 *      uses age's built-in scrypt recipient (so the on-disk file is a
 *      normal passphrase-encrypted age file, loadable by any age
 *      implementation).
 *   3. Caches the passphrase in the OS keychain via `cross-keychain`
 *      (macOS Keychain / libsecret / Windows Credential Manager) so
 *      subsequent invocations unlock silently. If the keychain is
 *      unavailable, callers fall back to a passphrase provider.
 *   4. Implements `SecretsBackend.encrypt` / `decrypt` that produce and
 *      consume the ADR-0042 v2 envelope format: `enc:v2:age:<base64>`,
 *      where the base64 payload is an age ciphertext against either
 *      this machine's own recipient or an explicit recipient list.
 *   5. Maintains a sidecar `recipients/` directory of `.pub` files —
 *      each file contains a single `age1...` recipient line plus an
 *      optional `# comment` line. `addRecipient` / `removeRecipient` /
 *      `listRecipients` read and mutate that directory; `rewrap`
 *      re-encrypts an existing envelope to a new recipient set.
 *
 * **Passphrase input.** This module never prompts the user directly.
 * Callers inject a `PassphraseProvider` — a function that returns the
 * master passphrase (typically wiring a readline prompt or `AM_AGE_PASSPHRASE`
 * env var). That keeps this file free of UI concerns and makes it
 * trivially testable.
 */

import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, stat, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { Decrypter, Encrypter, generateIdentity, identityToRecipient } from "age-encryption";
import { atomicWriteFile } from "./atomic-write";
import type { RecipientInfo, SecretEnvelope, SecretsBackend } from "./secrets-backend";
import { registerBackend } from "./secrets-backend";

// --- Constants ---------------------------------------------------------

const ENVELOPE_PREFIX = "enc:v2:age:";

/** OS keychain service identifier for the cached passphrase. */
const KEYCHAIN_SERVICE = "agent-manager";

/**
 * OS keychain account identifier. ADR-0042 calls for
 * `<identity-fingerprint>` but Wave 1 uses a fixed account name so the
 * cached credential is addressable before the identity exists; a
 * future rotation pass can migrate to fingerprint-keyed entries.
 */
const KEYCHAIN_ACCOUNT = "identity-passphrase";

/** Name of the identity file written inside the identities directory. */
const IDENTITY_FILENAME = "identity.age";

/** Name of the recipients directory, sibling to the identity file. */
const RECIPIENTS_DIRNAME = "recipients";

/** Suffix used for recipient public-key files. */
const RECIPIENT_FILE_SUFFIX = ".pub";

/** Recipient lines in a `.pub` file MUST start with `age1`. */
const RECIPIENT_PREFIX = "age1";

// --- Paths -------------------------------------------------------------

/**
 * Resolve the identity directory. Defaults to
 * `~/.config/agent-manager/identities` per ADR-0042. Overridable via
 * `AM_AGE_IDENTITY_DIR` for tests and non-standard layouts.
 */
export function resolveIdentityDir(): string {
  if (process.env.AM_AGE_IDENTITY_DIR) {
    return process.env.AM_AGE_IDENTITY_DIR;
  }
  const xdgConfigHome = process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config");
  return join(xdgConfigHome, "agent-manager", "identities");
}

/** Absolute path to the passphrase-wrapped age identity file. */
export function resolveIdentityPath(): string {
  return join(resolveIdentityDir(), IDENTITY_FILENAME);
}

/**
 * Default recipients directory — a `recipients/` subdir sibling to the
 * identity file. Callers may override via the backend options.
 */
export function resolveRecipientsDir(): string {
  return join(resolveIdentityDir(), RECIPIENTS_DIRNAME);
}

// --- File helpers ------------------------------------------------------

async function pathExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

// --- Passphrase provider -----------------------------------------------

/**
 * Strategy for obtaining the master passphrase. Implementations may
 * read an env var, prompt on stdin, query a password manager, etc.
 *
 * `kind` lets the implementation distinguish between an initial setup
 * prompt (where it should ideally confirm the passphrase) and a normal
 * unlock prompt.
 */
export type PassphraseProvider = (kind: "create" | "unlock") => Promise<string>;

/**
 * A trivial env-var-backed passphrase provider. Returns
 * `process.env[varName]` or throws a descriptive error if unset. Useful
 * for CI, non-interactive workflows, and tests.
 */
export function envPassphraseProvider(varName = "AM_AGE_PASSPHRASE"): PassphraseProvider {
  return async () => {
    const v = process.env[varName];
    if (!v || v.length === 0) {
      throw new Error(
        `AgeSecretsBackend: ${varName} is unset — provide a passphrase provider or export ${varName}.`,
      );
    }
    return v;
  };
}

// --- Keychain adapter --------------------------------------------------

/**
 * Minimal keychain surface this module depends on. The shape matches
 * `cross-keychain`'s top-level `getPassword` / `setPassword` helpers;
 * tests may substitute an in-memory implementation.
 */
export interface KeychainAdapter {
  getPassword(service: string, account: string): Promise<string | null>;
  setPassword(service: string, account: string, password: string): Promise<void>;
  deletePassword?(service: string, account: string): Promise<void>;
}

/**
 * Wrap a keychain call so transient errors (keychain locked, D-Bus not
 * running, Windows policy denied) degrade gracefully to "cache miss"
 * rather than blowing up the whole operation. ADR-0042 is explicit
 * that the keychain is a cache, not a primary vault — the passphrase
 * provider is the source of truth.
 */
async function keychainGetSafe(
  kc: KeychainAdapter,
  service: string,
  account: string,
): Promise<string | null> {
  try {
    return await kc.getPassword(service, account);
  } catch {
    return null;
  }
}

async function keychainSetSafe(
  kc: KeychainAdapter,
  service: string,
  account: string,
  password: string,
): Promise<void> {
  try {
    await kc.setPassword(service, account, password);
  } catch {
    // Non-fatal: user will be re-prompted next run. ADR-0042 §"Unlock cache".
  }
}

/**
 * Lazy-load `cross-keychain`. The module performs platform detection
 * work on first use; we import it dynamically so test environments
 * that never touch the keychain don't pay the cost (and so builds
 * targeting constrained runtimes can tree-shake it out if unused).
 */
async function defaultKeychain(): Promise<KeychainAdapter> {
  const mod = await import("cross-keychain");
  return {
    getPassword: mod.getPassword,
    setPassword: mod.setPassword,
    deletePassword: mod.deletePassword,
  };
}

// --- Backend options ---------------------------------------------------

export interface AgeSecretsBackendOptions {
  /**
   * Absolute path to the passphrase-wrapped identity file. Defaults
   * to `resolveIdentityPath()`.
   */
  identityPath?: string;
  /**
   * Absolute path to the recipients directory (holds `*.pub` files).
   * Defaults to `<identityDir>/recipients`.
   */
  recipientsDir?: string;
  /**
   * Supplies the master passphrase on first use or when the keychain
   * cache is cold. Required.
   */
  passphraseProvider: PassphraseProvider;
  /**
   * Keychain backend for passphrase caching. Defaults to the
   * `cross-keychain` top-level helpers.
   */
  keychain?: KeychainAdapter;
  /**
   * Keychain service name. Defaults to `"agent-manager"`.
   */
  keychainService?: string;
  /**
   * Keychain account name. Defaults to `"identity-passphrase"`.
   */
  keychainAccount?: string;
}

// --- Backend -----------------------------------------------------------

/**
 * Age-based secrets backend. Supports multi-recipient encryption via
 * a sidecar `recipients/` directory of `.pub` files. By default,
 * `encrypt` targets the union of the local identity's recipient and
 * any recipients in `recipientsDir`; callers may pass an explicit list
 * to override.
 */
export class AgeSecretsBackend implements SecretsBackend {
  readonly name = "age" as const;
  readonly version = 2;

  readonly #identityPath: string;
  readonly #recipientsDir: string;
  readonly #passphraseProvider: PassphraseProvider;
  readonly #keychain: KeychainAdapter | Promise<KeychainAdapter>;
  readonly #keychainService: string;
  readonly #keychainAccount: string;

  /** Plaintext `AGE-SECRET-KEY-1...` string, once unlocked. */
  #identity: string | null = null;
  /** Derived `age1...` public recipient, cached after first use. */
  #recipient: string | null = null;

  constructor(opts: AgeSecretsBackendOptions) {
    this.#identityPath = opts.identityPath ?? resolveIdentityPath();
    this.#recipientsDir =
      opts.recipientsDir ?? join(dirname(this.#identityPath), RECIPIENTS_DIRNAME);
    this.#passphraseProvider = opts.passphraseProvider;
    this.#keychain = opts.keychain ?? defaultKeychain();
    this.#keychainService = opts.keychainService ?? KEYCHAIN_SERVICE;
    this.#keychainAccount = opts.keychainAccount ?? KEYCHAIN_ACCOUNT;
  }

  /**
   * Ensure a local identity exists and is unlocked.
   *
   * Flow:
   *   1. If the identity file does not exist → generate a new age
   *      identity, prompt for a passphrase ("create"), write it
   *      passphrase-wrapped, cache the passphrase in the keychain.
   *   2. Otherwise → try the keychain-cached passphrase first; on
   *      miss, prompt ("unlock") and re-cache on success.
   *
   * Idempotent: subsequent calls are no-ops once `#identity` is set.
   */
  async initialize(): Promise<void> {
    if (this.#identity) return;

    const exists = await pathExists(this.#identityPath);
    if (!exists) {
      await this.#createNewIdentity();
      return;
    }

    await this.#unlockExistingIdentity();
  }

  /** Return the public age recipient (`age1...`) for this identity. */
  async getRecipient(): Promise<string> {
    await this.initialize();
    if (!this.#recipient) {
      this.#recipient = await identityToRecipient(this.#identity!);
    }
    return this.#recipient;
  }

  /**
   * Encrypt `plaintext` to an age envelope.
   *
   * If `recipients` is omitted, encrypts to the union of the local
   * identity's recipient and any `.pub` files in `recipientsDir` — so
   * the local machine can always decrypt its own envelopes, and any
   * committed recipient can decrypt them too.
   *
   * If `recipients` is provided, encrypts only to those recipients.
   * The caller is responsible for including the local recipient if it
   * wants the envelope to be locally decryptable.
   */
  async encrypt(plaintext: string, recipients?: readonly string[]): Promise<SecretEnvelope> {
    await this.initialize();

    const targets =
      recipients !== undefined ? [...recipients] : await this.#defaultEncryptRecipients();

    if (targets.length === 0) {
      throw new Error("AgeSecretsBackend: encrypt called with no recipients.");
    }

    const encrypter = new Encrypter();
    for (const r of targets) {
      validateRecipient(r);
      encrypter.addRecipient(r);
    }
    const ciphertext = await encrypter.encrypt(plaintext);

    return `${ENVELOPE_PREFIX}${bytesToBase64(ciphertext)}`;
  }

  async decrypt(envelope: SecretEnvelope): Promise<string> {
    if (!envelope.startsWith(ENVELOPE_PREFIX)) {
      throw new Error(
        `AgeSecretsBackend: envelope does not start with "${ENVELOPE_PREFIX}" — got "${envelope.slice(0, 20)}...".`,
      );
    }
    await this.initialize();

    const payload = envelope.slice(ENVELOPE_PREFIX.length);
    const ciphertext = base64ToBytes(payload);

    const decrypter = new Decrypter();
    decrypter.addIdentity(this.#identity!);
    return decrypter.decrypt(ciphertext, "text");
  }

  // --- Recipient management -------------------------------------------

  /**
   * Register a new recipient. Writes `<recipientsDir>/<id>.pub` with
   * the `age1...` public key and an optional `# <comment>` line.
   *
   * The `id` defaults to a 10-hex-char fingerprint of the public key
   * so different callers agree on filenames. Callers may override via
   * `pub.id` — e.g. hostname-based ids like `laptop-alice`.
   *
   * Re-adding an existing recipient (by `id`) overwrites the file;
   * the operation is idempotent.
   */
  async addRecipient(pub: RecipientInfo): Promise<void> {
    validateRecipient(pub.publicKey);
    const id = pub.id && pub.id.length > 0 ? pub.id : fingerprintOf(pub.publicKey);
    const safeId = sanitiseRecipientId(id);
    await mkdir(this.#recipientsDir, { recursive: true });
    const body = renderRecipientFile(pub.publicKey, pub.addedAt, id);
    const target = join(this.#recipientsDir, `${safeId}${RECIPIENT_FILE_SUFFIX}`);
    await atomicWriteFile(target, body, { mode: 0o644 });
  }

  /**
   * Remove the recipient whose id *or* public-key matches `idOrKey`.
   *
   * Lookup order: file whose basename (sans `.pub`) equals `idOrKey`;
   * otherwise any file whose payload line equals `idOrKey` (for
   * callers that only know the `age1...` value).
   *
   * No-op if no such recipient is registered — idempotent remove.
   */
  async removeRecipient(idOrKey: string): Promise<void> {
    if (!(await pathExists(this.#recipientsDir))) return;

    // Direct id → filename match.
    const safeId = sanitiseRecipientId(idOrKey);
    const direct = join(this.#recipientsDir, `${safeId}${RECIPIENT_FILE_SUFFIX}`);
    if (await pathExists(direct)) {
      await unlink(direct);
      return;
    }

    // Fall back to scanning by public-key value.
    const entries = await this.#readRecipientFiles();
    for (const { path, info } of entries) {
      if (info.publicKey === idOrKey || info.id === idOrKey) {
        await unlink(path);
        return;
      }
    }
  }

  /**
   * List all recipients currently registered in `recipientsDir`.
   * Results are sorted by id for stable output. Returns `[]` if the
   * directory does not exist.
   */
  async listRecipients(): Promise<RecipientInfo[]> {
    const entries = await this.#readRecipientFiles();
    const infos = entries.map((e) => e.info);
    infos.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    return infos;
  }

  /**
   * Re-encrypt `envelope` to a new recipient set.
   *
   * If `newRecipients` is omitted, targets are re-derived from the
   * current identity + `recipientsDir` — i.e. "rewrap to whatever
   * addRecipient/removeRecipient left behind". The local identity
   * must still be able to decrypt the input envelope.
   */
  async rewrap(
    envelope: SecretEnvelope,
    newRecipients?: readonly string[],
  ): Promise<SecretEnvelope> {
    const plaintext = await this.decrypt(envelope);
    return this.encrypt(plaintext, newRecipients);
  }

  // --- internals -------------------------------------------------------

  async #defaultEncryptRecipients(): Promise<string[]> {
    const own = await this.getRecipient();
    const extras = await this.listRecipients();
    const set = new Set<string>([own]);
    for (const r of extras) set.add(r.publicKey);
    return Array.from(set);
  }

  async #readRecipientFiles(): Promise<Array<{ path: string; info: RecipientInfo }>> {
    if (!(await pathExists(this.#recipientsDir))) return [];
    let names: string[];
    try {
      names = await readdir(this.#recipientsDir);
    } catch {
      return [];
    }
    const out: Array<{ path: string; info: RecipientInfo }> = [];
    for (const name of names) {
      if (!name.endsWith(RECIPIENT_FILE_SUFFIX)) continue;
      const path = join(this.#recipientsDir, name);
      let text: string;
      try {
        text = await readFile(path, "utf8");
      } catch {
        continue;
      }
      const info = parseRecipientFile(text, name);
      if (info) out.push({ path, info });
    }
    return out;
  }

  async #createNewIdentity(): Promise<void> {
    const identity = await generateIdentity();
    const passphrase = await this.#passphraseProvider("create");
    if (passphrase.length === 0) {
      throw new Error("AgeSecretsBackend: passphrase must be non-empty.");
    }

    const encrypter = new Encrypter();
    encrypter.setPassphrase(passphrase);
    const wrapped = await encrypter.encrypt(identity);

    await mkdir(dirname(this.#identityPath), { recursive: true });
    await atomicWriteFile(this.#identityPath, Buffer.from(wrapped), { mode: 0o600 });

    const kc = await this.#resolveKeychain();
    await keychainSetSafe(kc, this.#keychainService, this.#keychainAccount, passphrase);

    this.#identity = identity;
    this.#recipient = await identityToRecipient(identity);
  }

  async #unlockExistingIdentity(): Promise<void> {
    const wrapped = await readFile(this.#identityPath);
    const kc = await this.#resolveKeychain();

    // 1. Try keychain-cached passphrase.
    const cached = await keychainGetSafe(kc, this.#keychainService, this.#keychainAccount);
    if (cached) {
      const identity = await tryDecryptIdentity(wrapped, cached);
      if (identity) {
        this.#identity = identity;
        return;
      }
      // Cached passphrase is stale; fall through to prompt.
    }

    // 2. Prompt for passphrase.
    const passphrase = await this.#passphraseProvider("unlock");
    const identity = await tryDecryptIdentity(wrapped, passphrase);
    if (!identity) {
      throw new Error(
        "AgeSecretsBackend: failed to decrypt identity file — passphrase incorrect or file corrupt.",
      );
    }
    this.#identity = identity;

    // Refresh the keychain cache with the now-known-good passphrase.
    await keychainSetSafe(kc, this.#keychainService, this.#keychainAccount, passphrase);
  }

  async #resolveKeychain(): Promise<KeychainAdapter> {
    return this.#keychain instanceof Promise ? await this.#keychain : this.#keychain;
  }
}

// --- Helpers -----------------------------------------------------------

/**
 * Attempt to decrypt a passphrase-wrapped age identity file. Returns
 * the unwrapped identity string or `null` if the passphrase is wrong.
 * Any other error (corrupt file, unsupported format) is rethrown.
 */
async function tryDecryptIdentity(wrapped: Uint8Array, passphrase: string): Promise<string | null> {
  const decrypter = new Decrypter();
  decrypter.addPassphrase(passphrase);
  try {
    return await decrypter.decrypt(wrapped, "text");
  } catch (err) {
    // age-encryption throws on wrong passphrase; we can't reliably
    // distinguish that from a malformed file without parsing the
    // error message. Treat any failure as "wrong passphrase" — the
    // caller will re-prompt or surface a descriptive error.
    const msg = err instanceof Error ? err.message : String(err);
    // age-encryption surfaces "no identity matched any of the file's
    // recipients" on a wrong passphrase, and throws other messages
    // ("HMAC mismatch", "decryption failed", etc.) on derived failures.
    // Treat any of these as "wrong passphrase"; the caller re-prompts
    // or surfaces a descriptive error.
    if (/passphrase|decrypt|mac|authentic|no identity matched/i.test(msg)) {
      return null;
    }
    throw err;
  }
}

/**
 * Validate that a string looks like an `age1...` recipient. Throws a
 * descriptive error otherwise — the age library also rejects bad
 * recipients, but a pre-check produces clearer error messages.
 */
function validateRecipient(r: string): void {
  if (typeof r !== "string" || !r.startsWith(RECIPIENT_PREFIX)) {
    throw new Error(
      `AgeSecretsBackend: invalid recipient — expected an "${RECIPIENT_PREFIX}..." public key, got "${String(r).slice(0, 20)}".`,
    );
  }
}

/** Deterministic short fingerprint used as a default recipient id. */
function fingerprintOf(publicKey: string): string {
  return createHash("sha256").update(publicKey).digest("hex").slice(0, 10);
}

/**
 * Restrict recipient ids to a filesystem-safe subset so callers can't
 * accidentally produce path traversal or weird filenames.
 */
function sanitiseRecipientId(id: string): string {
  const cleaned = id.replace(/[^A-Za-z0-9._-]/g, "_");
  return cleaned.length > 0 ? cleaned : "recipient";
}

/**
 * Render a recipient `.pub` file. Format:
 *
 *   # id: <id>
 *   # added: <iso8601>
 *   age1...
 *
 * Comment lines are optional and ignored on read (except that we use
 * them to round-trip `id` and `addedAt` when present).
 */
function renderRecipientFile(publicKey: string, addedAt?: string, id?: string): string {
  const lines: string[] = [];
  if (id) lines.push(`# id: ${id}`);
  if (addedAt) lines.push(`# added: ${addedAt}`);
  lines.push(publicKey);
  return `${lines.join("\n")}\n`;
}

/**
 * Parse a recipient `.pub` file. The first `age1...` line is the
 * public key; `# id: ...` / `# added: ...` comment headers contribute
 * metadata. If neither is present, the filename (sans suffix) seeds
 * `id` and `addedAt` defaults to the empty string.
 */
function parseRecipientFile(text: string, fileName: string): RecipientInfo | null {
  let publicKey: string | null = null;
  let id: string | null = null;
  let addedAt: string | null = null;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0) continue;
    if (line.startsWith("#")) {
      const body = line.slice(1).trim();
      const idMatch = /^id\s*:\s*(.+)$/i.exec(body);
      if (idMatch) {
        id = idMatch[1]!.trim();
        continue;
      }
      const addedMatch = /^added\s*:\s*(.+)$/i.exec(body);
      if (addedMatch) {
        addedAt = addedMatch[1]!.trim();
        continue;
      }
      continue;
    }
    if (line.startsWith(RECIPIENT_PREFIX)) {
      publicKey = line;
      break;
    }
  }
  if (!publicKey) return null;
  const basename = fileName.endsWith(RECIPIENT_FILE_SUFFIX)
    ? fileName.slice(0, -RECIPIENT_FILE_SUFFIX.length)
    : fileName;
  return {
    id: id ?? basename,
    publicKey,
    addedAt: addedAt ?? "",
  };
}

function bytesToBase64(bytes: Uint8Array): string {
  // Chunked to avoid call-stack overflow on very large buffers. Age
  // ciphertexts are small (KBs) so this is mostly defensive.
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

// --- Registry wiring ---------------------------------------------------

/** Optional config accepted by `AgeSecretsBackendFactory.load`. */
export interface AgeSecretsBackendConfig extends Partial<AgeSecretsBackendOptions> {
  /**
   * If `passphraseProvider` is omitted, the factory falls back to
   * `envPassphraseProvider()` (reads `AM_AGE_PASSPHRASE`). Callers
   * that want a prompt-based flow must supply their own provider.
   */
  passphraseProvider?: PassphraseProvider;
}

/**
 * Side-effect registration. Importing `core/secrets-age` registers
 * the `age` factory with the global `SecretsBackend` registry. The
 * factory does *not* call `initialize()` — lazy initialization lets
 * callers instantiate the backend in contexts where prompting isn't
 * yet desirable (e.g. parsing a config file to discover the backend).
 */
registerBackend({
  name: "age",
  async load(config: unknown): Promise<SecretsBackend> {
    const cfg = (config ?? {}) as AgeSecretsBackendConfig;
    const opts: AgeSecretsBackendOptions = {
      passphraseProvider: cfg.passphraseProvider ?? envPassphraseProvider(),
      ...(cfg.identityPath !== undefined && { identityPath: cfg.identityPath }),
      ...(cfg.recipientsDir !== undefined && { recipientsDir: cfg.recipientsDir }),
      ...(cfg.keychain !== undefined && { keychain: cfg.keychain }),
      ...(cfg.keychainService !== undefined && { keychainService: cfg.keychainService }),
      ...(cfg.keychainAccount !== undefined && { keychainAccount: cfg.keychainAccount }),
    };
    return new AgeSecretsBackend(opts);
  },
});
