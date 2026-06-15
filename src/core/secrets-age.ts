/**
 * AgeSecretsBackend — ADR-0042 per-machine age identity backend.
 *
 * See ADR-0042 (Universal secrets strategy). This backend:
 *
 *   1. Generates a per-machine X25519 age identity (`AGE-SECRET-KEY-1...`)
 *      via `age-encryption`'s `generateIdentity()`.
 *   2. Stores the identity passphrase-wrapped at
 *      `<os-data-dir>/agent-manager/identities/identity.age` (e.g.
 *      `~/.local/share/agent-manager/identities/identity.age` on Linux —
 *      see `resolveIdentityDir`). SECURITY (e737): this lives in the OS
 *      DATA dir, NOT the git-tracked config dir, so the wrapped private
 *      key is never staged/pushed by `commitAll`. The wrapping uses
 *      age's built-in scrypt recipient (so the on-disk file is a normal
 *      passphrase-encrypted age file, loadable by any age
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
import { dirname, join, resolve } from "node:path";
import { Decrypter, Encrypter, generateIdentity, identityToRecipient } from "age-encryption";
import { atomicWriteFile } from "./atomic-write";
import { resolveDataDir } from "./secrets";
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

/**
 * Filename used to back up the previous identity file during a
 * grace-period rotation (ADR-0051 §Decision). The old file is kept
 * on-disk so the old identity can still decrypt historical ciphertext
 * until `--finalize` drops it.
 */
const IDENTITY_OLD_FILENAME = "identity.age.old";

/**
 * Filename of the sidecar recipient `.pub` emitted for the OLD
 * identity during a rotation. Kept inside `recipientsDir/` so the
 * normal recipient-discovery flow picks it up for dual-encryption,
 * and dropped at `--finalize`.
 */
const OLD_RECIPIENT_FILENAME = "_rotation-old.pub";

/**
 * Sidecar metadata file recording an in-progress rotation. Stored in
 * the identities directory (sibling to `identity.age`) because the
 * rotation is per-machine state, not config-repo state. ADR-0051
 * Phase 1 keeps this minimal; Phase 2 may migrate into a signed
 * structure.
 */
const ROTATION_STATE_FILENAME = ".am-rotation-state.json";

// --- Argon2id parameters (ADR-0042 §KDF, Lens-C L-C1) ------------------

/**
 * Argon2id work-factor parameters used when wrapping the per-machine
 * identity passphrase.
 *
 * Today the on-disk `identity.age` file is produced by
 * `age-encryption`'s `Encrypter.setPassphrase()` which internally uses
 * scrypt per the age spec, so these params are not yet consumed by the
 * wrap path. They ARE exposed so that:
 *
 *   1. The config schema can carry the intended Argon2id work factor
 *      (tracking OWASP 2025 / RFC 9106 guidance) ahead of the
 *      Argon2id-WASM integration called for in ADR-0042 Phase 2 and
 *      the lens-age-sota research doc.
 *   2. The browser decrypt path (hosted UI, argon2-browser) can read
 *      the same values from committed config so CLI and web agree on
 *      the KDF cost for any passphrase-derived KEK.
 *   3. Tests have a stable surface to assert the default floor
 *      against without hitting real KDF work.
 *
 * Unit of `memoryKiB` is KiB (Argon2 convention): 131072 KiB = 128 MiB.
 */
export interface Argon2idParams {
  /** Memory cost in KiB. OWASP 2025 floor for credential stores: 131072 (128 MiB). */
  memoryKiB: number;
  /** Iteration count (`t`). RFC 9106 interactive recommendation: 3. */
  time: number;
  /** Lanes / parallelism (`p`). Capped at 16 to match argon2-browser. */
  parallelism: number;
}

/**
 * Default Argon2id parameters, aligned with OWASP 2025 / RFC 9106 for
 * credential-wrapping on a 2026-era dev laptop.
 *
 * Historical note: the initial ADR-0042 research doc (May 2026) cited
 * `m=64 MiB, t=3, p=4`. L-C1 raised the default memory floor to 128 MiB
 * per the updated OWASP guidance (Password Storage Cheat Sheet 2025).
 * Users may override via `settings.secrets.argon2` in `config.toml`.
 */
export const DEFAULT_ARGON2ID_PARAMS: Readonly<Argon2idParams> = Object.freeze({
  memoryKiB: 131072, // 128 MiB — raised from 64 MiB floor (L-C1)
  time: 3,
  parallelism: 4,
});

/** Validation lower bound: schema enforces this; keep the two in sync. */
export const ARGON2ID_MIN_MEMORY_KIB = 8192; // 8 MiB

/**
 * Clamp / validate a partial Argon2id override against the invariants
 * enforced by the config schema. Returns a fully-populated params
 * object with defaults filled in.
 *
 * Throws a descriptive error on violations rather than silently
 * clamping — callers should surface these to the user so a typo'd
 * `memoryKiB = 1` fails loudly instead of degrading security.
 */
export function resolveArgon2idParams(override?: Partial<Argon2idParams>): Argon2idParams {
  const params: Argon2idParams = {
    memoryKiB: override?.memoryKiB ?? DEFAULT_ARGON2ID_PARAMS.memoryKiB,
    time: override?.time ?? DEFAULT_ARGON2ID_PARAMS.time,
    parallelism: override?.parallelism ?? DEFAULT_ARGON2ID_PARAMS.parallelism,
  };
  if (!Number.isInteger(params.memoryKiB) || params.memoryKiB < ARGON2ID_MIN_MEMORY_KIB) {
    throw new Error(
      `AgeSecretsBackend: argon2.memoryKiB must be an integer >= ${ARGON2ID_MIN_MEMORY_KIB} (got ${params.memoryKiB}).`,
    );
  }
  if (!Number.isInteger(params.time) || params.time < 1) {
    throw new Error(`AgeSecretsBackend: argon2.time must be an integer >= 1 (got ${params.time}).`);
  }
  if (!Number.isInteger(params.parallelism) || params.parallelism < 1 || params.parallelism > 16) {
    throw new Error(
      `AgeSecretsBackend: argon2.parallelism must be an integer in [1, 16] (got ${params.parallelism}).`,
    );
  }
  return params;
}

// --- Paths -------------------------------------------------------------

/**
 * Resolve the identity directory — where the passphrase-wrapped age
 * PRIVATE identity (`identity.age`), its rotation sidecars, and the
 * `recipients/` directory live.
 *
 * SECURITY (e737): the identity MUST live OUTSIDE the agent-manager
 * config dir, which is a git repo that `commitAll` stages-and-pushes
 * wholesale. The old default (`~/.config/agent-manager/identities`)
 * resolved under the SAME tree as `resolveConfigDir()`, so the wrapped
 * private key was committed and pushed to the config remote. We now
 * resolve to the OS DATA dir, mirroring `resolveKeyPath()` in
 * `core/secrets.ts` exactly, so the identity is physically outside the
 * repo regardless of `AM_CONFIG_DIR` / `XDG_CONFIG_HOME` layout.
 *
 * M15: the darwin/win32/XDG platform switch is factored into the shared
 * `resolveDataDir()` helper in `core/secrets.ts` and reused by BOTH this
 * function and `resolveKeyPath()`. The AES master key and the age identity
 * are the same class of per-machine private material; sharing one switch
 * guarantees they can never drift to inconsistent OS locations again.
 *
 * - macOS:   ~/Library/Application Support/agent-manager/identities
 * - Linux:   $XDG_DATA_HOME/agent-manager/identities
 *            (default ~/.local/share/agent-manager/identities)
 * - Windows: %APPDATA%/agent-manager/identities
 * - Other:   ~/.local/share/agent-manager/identities (XDG fallback)
 *
 * Overridable via `AM_AGE_IDENTITY_DIR` (absolute) for tests and
 * non-standard layouts — that override is checked FIRST, ahead of the
 * shared helper, so the identity keeps its own independent override.
 */
export function resolveIdentityDir(): string {
  if (process.env.AM_AGE_IDENTITY_DIR) {
    return process.env.AM_AGE_IDENTITY_DIR;
  }

  return resolveDataDir("agent-manager/identities");
}

/**
 * Resolve the LEGACY identity directory inside the git-tracked config
 * dir. Pre-e737 installs wrote `identity.age` here (under
 * `~/.config/agent-manager/identities`, the SAME tree as the config
 * repo), which leaked the wrapped private key into the committed/pushed
 * tree. `migrateLegacyIdentityDir()` moves any such files out to the
 * data-dir location returned by `resolveIdentityDir()`.
 *
 * Honours the historical `XDG_CONFIG_HOME` → `~/.config` resolution so
 * an upgrade-in-place finds the old file where the old code wrote it.
 */
export function legacyIdentityDir(): string {
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

/**
 * Result of a legacy-identity-dir migration attempt.
 * - `migrated`: moved one or more files from the legacy config-dir
 *   location to the data-dir location.
 * - `none`:     no legacy identity present, no action needed.
 * - `conflict`: a data-dir identity already exists; the legacy copy is
 *   left in place (the data-dir one wins) so the caller can warn. Surfaced
 *   by `AgeSecretsBackend.initialize()` as a stderr warning telling the
 *   user to delete the stale legacy copy.
 * - `skipped`:  legacy and target resolve to the SAME directory (e.g.
 *   `AM_AGE_IDENTITY_DIR` points at the legacy location, or a custom
 *   layout) — nothing to move.
 */
export type IdentityMigrationResult =
  | { kind: "none" }
  | { kind: "skipped" }
  | { kind: "migrated"; from: string; to: string; files: string[] }
  | { kind: "conflict"; legacy: string; current: string };

/**
 * Files this module owns inside the identity directory. Migration moves
 * exactly these (when present) — never an unbounded glob — so a stray
 * unrelated file in the legacy dir is left alone.
 */
const IDENTITY_DIR_FILES = [
  IDENTITY_FILENAME,
  IDENTITY_OLD_FILENAME,
  ROTATION_STATE_FILENAME,
] as const;

/**
 * SECURITY (e737) migration shim — mirrors `migrateLegacyKey()` in
 * `core/secrets.ts`. If a pre-e737 install wrote `identity.age` (and its
 * rotation sidecars / `recipients/` dir) into the git-tracked config dir
 * and the new data-dir location has no identity yet, MOVE them out so
 * the private key stops living inside the repo. Idempotent and
 * best-effort: safe to call on every backend `initialize()`.
 *
 * Conflict handling matches `migrateLegacyKey`: if a data-dir identity
 * already exists, the data-dir copy wins and the legacy copy is left in
 * place (flagged via `conflict`) for the user to delete — we never
 * clobber a live key.
 *
 * @param targetDir defaults to `resolveIdentityDir()`. Passed explicitly
 *   by the backend so a custom `identityPath`/`recipientsDir` is
 *   respected (and so the legacy==target no-op is detectable).
 */
export async function migrateLegacyIdentityDir(
  targetDir: string = resolveIdentityDir(),
): Promise<IdentityMigrationResult> {
  // Only the DEFAULT install layout ever leaked the identity into the config
  // dir (because `resolveIdentityDir` used to derive from XDG_CONFIG_HOME).
  // When `AM_AGE_IDENTITY_DIR` is set, the caller/test is managing its own
  // layout — we must NOT reach into the real user's `~/.config` and relocate
  // their identity into a custom/test directory (data-loss + test pollution).
  if (process.env.AM_AGE_IDENTITY_DIR) {
    return { kind: "skipped" };
  }

  const legacy = legacyIdentityDir();

  // Same directory → nothing to do (override points at the legacy location, or
  // a custom layout collapses the two). Compare normalised absolute paths.
  if (resolveAbs(legacy) === resolveAbs(targetDir)) {
    return { kind: "skipped" };
  }

  const legacyIdentity = join(legacy, IDENTITY_FILENAME);
  if (!(await pathExists(legacyIdentity))) {
    return { kind: "none" };
  }

  const targetIdentity = join(targetDir, IDENTITY_FILENAME);
  if (await pathExists(targetIdentity)) {
    // Data-dir identity already exists — it wins. Leave legacy for the
    // user to delete; never clobber a live key.
    return { kind: "conflict", legacy, current: targetDir };
  }

  await mkdir(targetDir, { recursive: true });
  const moved: string[] = [];

  // Move the owned top-level files.
  for (const name of IDENTITY_DIR_FILES) {
    const src = join(legacy, name);
    if (!(await pathExists(src))) continue;
    const dst = join(targetDir, name);
    // Preserve 0600 on the private-key files; rotation-state is also
    // per-machine state — 0600 is fine.
    const buf = await readFile(src);
    await atomicWriteFile(dst, Buffer.from(buf), { mode: 0o600 });
    try {
      await unlink(src);
    } catch {
      // If unlink fails the new copy is still in place — the leak is
      // closed (the data-dir copy is authoritative). The stale legacy
      // copy is covered by the .gitignore defence-in-depth entries.
    }
    moved.push(name);
  }

  // Move the recipients/ directory contents (public keys — not secret,
  // but they belong next to the identity).
  const legacyRecipients = join(legacy, RECIPIENTS_DIRNAME);
  if (await pathExists(legacyRecipients)) {
    const targetRecipients = join(targetDir, RECIPIENTS_DIRNAME);
    await mkdir(targetRecipients, { recursive: true });
    let names: string[] = [];
    try {
      names = await readdir(legacyRecipients);
    } catch {
      names = [];
    }
    for (const name of names) {
      const src = join(legacyRecipients, name);
      const dst = join(targetRecipients, name);
      try {
        const buf = await readFile(src);
        await atomicWriteFile(dst, Buffer.from(buf), { mode: 0o644 });
        await unlink(src);
      } catch {
        // Best-effort per-file; the identity itself (the secret) has
        // already been relocated above.
      }
    }
    if (names.length > 0) moved.push(`${RECIPIENTS_DIRNAME}/`);
  }

  return { kind: "migrated", from: legacy, to: targetDir, files: moved };
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

/**
 * Normalise a path to an absolute, separator-canonical form for safe
 * equality comparison (used by `migrateLegacyIdentityDir` to detect a
 * legacy==target no-op). `resolve` collapses `.`/`..` and applies the
 * cwd to relative inputs.
 */
function resolveAbs(p: string): string {
  return resolve(p);
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
  /**
   * Argon2id work-factor parameters used when wrapping the identity
   * passphrase. See `DEFAULT_ARGON2ID_PARAMS` for the 2026 defaults
   * (128 MiB / t=3 / p=4). Partial overrides are merged with the
   * defaults; invalid values throw at construction time.
   *
   * These are not yet consumed by the on-disk wrap path — age's
   * `setPassphrase()` uses scrypt per the age spec — but the backend
   * carries them so future Argon2id-WASM integration, the browser
   * decrypt path (argon2-browser), and `am secrets` tooling can read a
   * single source of truth.
   */
  argon2?: Partial<Argon2idParams>;
}

// --- Backend -----------------------------------------------------------

/**
 * Persistent state recorded during an in-progress identity rotation
 * (ADR-0051 Phase 1). Written to `identities/.am-rotation-state.json`
 * at `rotateIdentity()` time and consumed by `finalizeRotation()` /
 * `am secrets rotate --finalize` to know what to drop.
 *
 * All timestamps are ISO 8601 UTC. `grace_until` equals
 * `started_at + grace_period_days` and is stored explicitly so a clock
 * change between rotate and finalize doesn't shift the deadline.
 */
export interface RotationState {
  /** Old `age1...` recipient — still encrypted-to until finalize. */
  old_recipient: string;
  /** New `age1...` recipient — installed by rotateIdentity(). */
  new_recipient: string;
  /** ISO 8601 timestamp when rotation started. */
  started_at: string;
  /** ISO 8601 timestamp at which the grace window closes. */
  grace_until: string;
  /** Grace period in days, copied from settings.secrets.rotation. */
  grace_period_days: number;
}

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
  readonly #argon2: Argon2idParams;

  /** Plaintext `AGE-SECRET-KEY-1...` string, once unlocked. */
  #identity: string | null = null;
  /** Derived `age1...` public recipient, cached after first use. */
  #recipient: string | null = null;

  /**
   * Additional identities the decrypter should consult — populated by
   * `rotateIdentity()` with the OLD identity so envelopes encrypted to
   * the previous recipient can still be decrypted during the rotation
   * grace window. Cleared by `finalizeRotation()`. ADR-0051 §Phase-1.
   */
  #legacyIdentities: string[] = [];

  constructor(opts: AgeSecretsBackendOptions) {
    this.#identityPath = opts.identityPath ?? resolveIdentityPath();
    this.#recipientsDir =
      opts.recipientsDir ?? join(dirname(this.#identityPath), RECIPIENTS_DIRNAME);
    this.#passphraseProvider = opts.passphraseProvider;
    this.#keychain = opts.keychain ?? defaultKeychain();
    this.#keychainService = opts.keychainService ?? KEYCHAIN_SERVICE;
    this.#keychainAccount = opts.keychainAccount ?? KEYCHAIN_ACCOUNT;
    // Resolve + validate Argon2id params now so a bad config fails at
    // construction time rather than on the first encrypt.
    this.#argon2 = resolveArgon2idParams(opts.argon2);
  }

  /**
   * Return the effective Argon2id parameters for this backend. Useful
   * for tests, `am secrets status`, and the hosted-UI bundle which
   * must use identical params when deriving the browser-side KEK.
   */
  getArgon2idParams(): Readonly<Argon2idParams> {
    return { ...this.#argon2 };
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

    // SECURITY (e737): one-shot best-effort migration. If a pre-e737
    // install left the wrapped private identity inside the git-tracked
    // config dir, move it out to the data-dir location BEFORE we decide
    // whether an identity exists — so an upgrade-in-place transparently
    // relocates the leaked key (and a fresh create lands in the safe
    // location). Best-effort: a migration failure must never block
    // unlock/create of a perfectly good local identity.
    try {
      const migration = await migrateLegacyIdentityDir(dirname(this.#identityPath));
      // Surface the `conflict` outcome: a data-dir identity already exists,
      // so the leaky legacy copy in the git-tracked config dir was left in
      // place (we never clobber a live key). Warn so the user deletes it —
      // mirrors `loadKey`'s conflict warning in core/secrets.ts. stderr (not
      // stdout) so JSON-mode callers aren't polluted; the active identity is
      // perfectly usable regardless.
      if (migration.kind === "conflict") {
        console.error(
          `warning: age identity found in BOTH ${migration.current} (active) and legacy ${migration.legacy}. The legacy copy is ignored; delete it and ensure it is not committed.`,
        );
      }
    } catch {
      // Non-fatal — fall through to the normal create/unlock flow.
    }

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
    // ADR-0051 grace window: legacy identities (added by rotateIdentity)
    // remain decrypt-only so envelopes encrypted to the OLD recipient
    // continue to decrypt until rewrap completes / finalize fires.
    for (const legacy of this.#legacyIdentities) {
      decrypter.addIdentity(legacy);
    }
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

  // --- Rotation (ADR-0051) --------------------------------------------

  /** Absolute path to the active identity file. Useful for tests + tooling. */
  getIdentityPath(): string {
    return this.#identityPath;
  }

  /** Absolute path to the recipients directory. */
  getRecipientsDir(): string {
    return this.#recipientsDir;
  }

  /** Absolute path to the rotation-state sidecar (may not exist). */
  getRotationStatePath(): string {
    return join(dirname(this.#identityPath), ROTATION_STATE_FILENAME);
  }

  /**
   * Read the rotation-state sidecar, or `null` if no rotation is in
   * progress (file does not exist).
   *
   * Fail-closed: if the file exists but cannot be parsed into a valid
   * RotationState (malformed JSON, missing required fields, or
   * recipients that don't look like age keys), this method throws a
   * descriptive error so callers do not silently start a second
   * rotation over a partial/corrupt one.
   */
  async readRotationState(): Promise<RotationState | null> {
    const path = this.getRotationStatePath();
    if (!(await pathExists(path))) return null;

    let raw: string;
    try {
      raw = await readFile(path, "utf8");
    } catch (err) {
      throw new Error(
        `Failed to read rotation-state file (${path}): ${String(err)}. Remove the file manually if you are sure no rotation is in progress.`,
      );
    }

    let parsed: Partial<RotationState>;
    try {
      parsed = JSON.parse(raw) as Partial<RotationState>;
    } catch (err) {
      throw new Error(
        `Rotation-state file (${path}) contains invalid JSON: ${String(err)}. Remove the file manually if you are sure no rotation is in progress.`,
      );
    }

    if (
      typeof parsed.old_recipient !== "string" ||
      typeof parsed.new_recipient !== "string" ||
      typeof parsed.started_at !== "string"
    ) {
      throw new Error(
        `Rotation-state file (${path}) is missing required fields (old_recipient, new_recipient, started_at). Remove the file manually if you are sure no rotation is in progress.`,
      );
    }

    if (!parsed.old_recipient.startsWith("age1") || !parsed.new_recipient.startsWith("age1")) {
      throw new Error(
        `Rotation-state file (${path}) contains invalid age recipient(s). Remove the file manually if you are sure no rotation is in progress.`,
      );
    }

    return {
      old_recipient: parsed.old_recipient,
      new_recipient: parsed.new_recipient,
      started_at: parsed.started_at,
      grace_until: typeof parsed.grace_until === "string" ? parsed.grace_until : "",
      grace_period_days:
        typeof parsed.grace_period_days === "number" ? parsed.grace_period_days : 14,
    };
  }

  /**
   * ADR-0051 Phase 1 — generate a NEW age identity, archive the old
   * one to `identities/identity.age.old`, register the new identity
   * as the active one, AND keep the old recipient registered (sidecar
   * `_rotation-old.pub`) so subsequent encrypts/rewraps target both
   * recipients during the grace window.
   *
   * Writes the rotation-state sidecar (`.am-rotation-state.json`) so
   * `--finalize` later knows what to drop.
   *
   * Calls a passphrase provider with `kind: "create"` for the NEW
   * passphrase (ADR-0051 §"New passphrase is a load-bearing user
   * artifact"). The OLD identity must already be unlocked.
   *
   * Returns the rotation state for the caller to surface.
   */
  async rotateIdentity(opts: { gracePeriodDays: number }): Promise<RotationState> {
    if (!Number.isInteger(opts.gracePeriodDays) || opts.gracePeriodDays < 0) {
      throw new Error(
        `AgeSecretsBackend.rotateIdentity: gracePeriodDays must be a non-negative integer (got ${opts.gracePeriodDays}).`,
      );
    }

    // Unlock the existing identity first — we need it for archiving
    // (the on-disk file) and for proving we can decrypt-then-rewrap.
    await this.initialize();
    const oldIdentity = this.#identity!;
    const oldRecipient = await this.getRecipient();
    const oldWrapped = await readFile(this.#identityPath);

    // 1. Archive the OLD identity file. Atomic write so a crash
    // mid-rotation can't corrupt the .old copy.
    const oldPath = join(dirname(this.#identityPath), IDENTITY_OLD_FILENAME);
    await atomicWriteFile(oldPath, Buffer.from(oldWrapped), { mode: 0o600 });

    // 2. Generate the NEW identity + prompt for a NEW passphrase.
    const newIdentity = await generateIdentity();
    const newRecipient = await identityToRecipient(newIdentity);
    const newPassphrase = await this.#passphraseProvider("create");
    if (newPassphrase.length === 0) {
      throw new Error("AgeSecretsBackend.rotateIdentity: new passphrase must be non-empty.");
    }
    const encrypter = new Encrypter();
    encrypter.setPassphrase(newPassphrase);
    const newWrapped = await encrypter.encrypt(newIdentity);

    // 3. Persist the rotation-state sidecar BEFORE swapping the active
    //    identity. Crash-recovery invariant: if .am-rotation-state.json
    //    exists on disk, the on-disk identity may be either old or new
    //    (we don't yet know which) — the state file tells subsequent
    //    runs that a rotation is in flight and which recipients to
    //    target. ADR-0051 §crash-recovery (cross-family review fix).
    const startedAt = new Date();
    const graceUntil =
      opts.gracePeriodDays > 0
        ? new Date(startedAt.getTime() + opts.gracePeriodDays * 86_400_000).toISOString()
        : startedAt.toISOString();
    const state: RotationState = {
      old_recipient: oldRecipient,
      new_recipient: newRecipient,
      started_at: startedAt.toISOString(),
      grace_until: graceUntil,
      grace_period_days: opts.gracePeriodDays,
    };
    await atomicWriteFile(this.getRotationStatePath(), `${JSON.stringify(state, null, 2)}\n`, {
      mode: 0o600,
    });

    // 4. Register the OLD recipient as a sidecar so the standard
    // rewrap/encrypt flow targets both. Skipped when grace is 0
    // (immediate cutover).
    if (opts.gracePeriodDays > 0) {
      await mkdir(this.#recipientsDir, { recursive: true });
      const body = renderRecipientFile(oldRecipient, startedAt.toISOString(), "_rotation-old");
      await atomicWriteFile(join(this.#recipientsDir, OLD_RECIPIENT_FILENAME), body, {
        mode: 0o644,
      });
    }

    // 5. Atomically replace the active identity file with the new one.
    //    From this point on, fresh CLI processes will load the NEW key.
    //    The state file written at step 3 ensures #hydrateLegacyIdentities
    //    will read identity.age.old + dual-decrypt during the window.
    await atomicWriteFile(this.#identityPath, Buffer.from(newWrapped), { mode: 0o600 });

    // 6. Refresh in-memory state so subsequent calls use the new identity.
    //    Push the OLD identity onto the legacy-decrypt list so envelopes
    //    encrypted to the old recipient remain decryptable until rewrap
    //    completes (ADR-0051 grace window).
    this.#identity = newIdentity;
    this.#recipient = newRecipient;
    this.#legacyIdentities.push(oldIdentity);

    // 7. Refresh keychain cache to the new passphrase (best-effort).
    const kc = await this.#resolveKeychain();
    await keychainSetSafe(kc, this.#keychainService, this.#keychainAccount, newPassphrase);

    return state;
  }

  /**
   * ADR-0051 Phase 1 — Stage 1 of the safe two-stage finalize flow
   * (gpt-5.5 Phase-8 must-fix #1). Reads + validates rotation state and
   * removes ONLY the OLD recipient sidecar so the very next
   * `rewrap`/`encrypt` walk targets the NEW recipient set exclusively.
   *
   * What this method intentionally does NOT do:
   *   - delete `identities/identity.age.old`
   *   - delete the `.am-rotation-state.json` sidecar
   *   - clear the in-memory legacy-decrypt list
   *
   * Keeping those artifacts in place is what makes the operation
   * recoverable. If the subsequent rewrap pass fails (corrupt envelope,
   * disk full, kill -9), the caller can call `restoreOldRecipient(state)`
   * to put the sidecar back, leaving the rotation in the same
   * dual-encrypt state it was in before finalize was attempted. Only
   * after rewrap fully succeeds should the caller invoke
   * `finalizeRotationCommit()` to drop the archive + state file.
   *
   * Returns the rotation state, or `null` if no rotation is in
   * progress (caller should treat that as a no-op error).
   */
  async finalizeRotationPrepare(): Promise<RotationState | null> {
    const state = await this.readRotationState();
    if (!state) return null;

    // Drop the OLD recipient sidecar so #defaultEncryptRecipients() no
    // longer includes the old key. Idempotent: missing file is fine.
    const oldRecipientFile = join(this.#recipientsDir, OLD_RECIPIENT_FILENAME);
    if (await pathExists(oldRecipientFile)) {
      await unlink(oldRecipientFile);
    }

    return state;
  }

  /**
   * ADR-0051 Phase 1 — recovery hook for the safe two-stage finalize
   * flow. If `finalizeRotationPrepare()` succeeded but the subsequent
   * rewrap pass reported any failure, callers MUST invoke this with the
   * state returned by prepare to restore the OLD recipient sidecar so
   * the rotation reverts to the dual-encrypted grace state. The
   * archived identity + state file are still on disk (prepare did not
   * touch them), so this restores full pre-finalize behaviour.
   */
  async restoreOldRecipient(state: RotationState): Promise<void> {
    await mkdir(this.#recipientsDir, { recursive: true });
    const body = renderRecipientFile(state.old_recipient, state.started_at, "_rotation-old");
    await atomicWriteFile(join(this.#recipientsDir, OLD_RECIPIENT_FILENAME), body, {
      mode: 0o644,
    });
  }

  /**
   * ADR-0051 Phase 1 — Stage 2 of the safe two-stage finalize flow.
   * Deletes the archived OLD identity (`identity.age.old`), the
   * rotation-state sidecar, and clears the in-memory legacy-decrypt
   * list. MUST be called only after `finalizeRotationPrepare()` AND a
   * fully-successful rewrap pass that re-encrypted every envelope to
   * the NEW recipient set. After this call, envelopes encrypted to the
   * OLD recipient are no longer decryptable — that's the whole point
   * of finalize.
   */
  async finalizeRotationCommit(): Promise<void> {
    // Drop the archived OLD identity file (idempotent).
    const oldIdentity = join(dirname(this.#identityPath), IDENTITY_OLD_FILENAME);
    if (await pathExists(oldIdentity)) {
      await unlink(oldIdentity);
    }

    // Drop the rotation-state sidecar.
    if (await pathExists(this.getRotationStatePath())) {
      await unlink(this.getRotationStatePath());
    }

    // Clear the in-memory legacy-decrypt list. After finalize, envelopes
    // encrypted to the OLD recipient should NO LONGER decrypt.
    this.#legacyIdentities = [];
  }

  /**
   * ADR-0051 Phase 1 — legacy single-shot finalize. Equivalent to
   * `finalizeRotationPrepare()` followed by `finalizeRotationCommit()`
   * with NO recovery in between. Unsafe for callers that follow up
   * with a rewrap pass: a rewrap failure leaves envelopes orphaned
   * with no path back. Retained for the grace=0 immediate-cutover
   * path inside `runRotate()` (where rewrap has already completed
   * before this is called) and for backward compatibility with
   * existing tests.
   *
   * @deprecated Prefer the explicit prepare/commit pair when the caller
   *   does a rewrap pass between the two stages.
   */
  async finalizeRotation(): Promise<RotationState | null> {
    const state = await this.finalizeRotationPrepare();
    if (!state) return null;
    await this.finalizeRotationCommit();
    return state;
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

    // ADR-0051 grace window: if a rotation is in progress on disk
    // (state file exists AND identity.age.old exists), hydrate the
    // legacy-decrypt list so envelopes encrypted to the OLD recipient
    // remain decryptable across CLI process boundaries. Without this,
    // every fresh `am secrets <verb>` process starts with an empty
    // legacy list and old-recipient envelopes fail to decrypt during
    // the grace window.
    await this.#hydrateLegacyIdentities();
  }

  /**
   * Read .am-rotation-state.json (if present) + identity.age.old (if
   * present) and populate #legacyIdentities so the decrypter can
   * decrypt envelopes still encrypted to the OLD recipient. Best-effort:
   * silently no-ops when no rotation is in progress, when the archived
   * identity is missing, or when the new passphrase fails to unlock the
   * archive (in which case the user's already had to enter the new
   * passphrase to reach this point — the OLD passphrase is unknown to
   * us). ADR-0051 cross-process grace-window fix.
   */
  async #hydrateLegacyIdentities(): Promise<void> {
    const state = await this.readRotationState();
    if (!state) return;

    const oldIdentityPath = join(dirname(this.#identityPath), IDENTITY_OLD_FILENAME);
    if (!(await pathExists(oldIdentityPath))) return;

    // Try the keychain-cached NEW passphrase first (works when user
    // kept the same passphrase across rotation). Then try the OLD
    // passphrase env var. Without one of those we silently give up;
    // decrypt of old envelopes will fail with the standard error.
    const oldWrapped = await readFile(oldIdentityPath);
    const kc = await this.#resolveKeychain();
    const candidates: string[] = [];
    const cachedNew = await keychainGetSafe(kc, this.#keychainService, this.#keychainAccount);
    if (cachedNew) candidates.push(cachedNew);
    if (process.env.AM_AGE_OLD_PASSPHRASE) candidates.push(process.env.AM_AGE_OLD_PASSPHRASE);
    if (process.env.AM_AGE_PASSPHRASE) candidates.push(process.env.AM_AGE_PASSPHRASE);

    for (const pass of candidates) {
      const oldId = await tryDecryptIdentity(oldWrapped, pass);
      if (oldId) {
        this.#legacyIdentities.push(oldId);
        return;
      }
    }
    // Couldn't unlock the old identity with available passphrases.
    // Decrypt of old-recipient envelopes will fail noisily — that's the
    // correct fail-mode (rather than silently corrupting state).
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
  /**
   * Argon2id override, typically threaded through from
   * `settings.secrets.argon2` in `config.toml`. Validated at
   * construction time; omit for the 128 MiB / t=3 / p=4 defaults.
   */
  argon2?: Partial<Argon2idParams>;
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
      ...(cfg.argon2 !== undefined && { argon2: cfg.argon2 }),
    };
    return new AgeSecretsBackend(opts);
  },
});
