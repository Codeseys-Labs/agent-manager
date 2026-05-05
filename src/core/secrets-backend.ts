/**
 * SecretsBackend — pluggable encryption backend interface.
 *
 * See ADR-0042 (Universal secrets strategy). The envelope wire format
 * (`enc:v1:<iv>:<ct>`) is fixed by ADR-0012 and shared across backends;
 * each backend may interpret the payload differently so long as it
 * round-trips its own envelopes.
 *
 * Today only `aes-gcm-legacy` is implemented (adapter over the existing
 * module-level `encryptValue` / `decryptValue` in `./secrets.ts`). The
 * `age`, `kms-aws`, `kms-gcp`, `vault`, `1password`, and `bitwarden`
 * backends are future work and are gated on the verification criteria
 * enumerated in ADR-0042.
 *
 * This module is *scaffolding only* — it is not yet wired into apply
 * paths. Callers continue to use the module-level functions in
 * `./secrets.ts`. The adapter class allows future callers to depend on
 * the interface without churning on the concrete implementation.
 */

/**
 * Canonical encrypted-value envelope.
 *
 * Format: `enc:v1:<base64 iv>:<base64 ciphertext>` for the legacy
 * AES-GCM backend. Other backends share the `enc:v1:` prefix but may
 * use a backend-specific payload layout.
 */
export type SecretEnvelope = string;

/**
 * Public-key material for a recipient authorised to decrypt envelopes
 * produced by a multi-recipient backend (age, KMS grants, etc.).
 *
 * Not meaningful for single-key backends like `aes-gcm-legacy`.
 */
export interface RecipientInfo {
  /** Stable recipient identifier — hostname, `web:<fingerprint>`, KMS grant id, etc. */
  id: string;
  /** Public key material — `age1...`, a KMS key ARN, an OAuth principal, etc. */
  publicKey: string;
  /** ISO-8601 timestamp when the recipient was added. */
  addedAt: string;
}

/** Name tag for a supported backend implementation. */
export type SecretsBackendName =
  | "age"
  | "aes-gcm-legacy"
  | "kms-aws"
  | "kms-gcp"
  | "vault"
  | "1password"
  | "bitwarden";

/**
 * A loaded, ready-to-use secrets backend instance.
 *
 * Single-key backends (`aes-gcm-legacy`) implement only `encrypt` and
 * `decrypt`. Multi-recipient backends (`age`, KMS) SHOULD implement
 * the optional recipient-management methods.
 */
export interface SecretsBackend {
  readonly name: SecretsBackendName;
  readonly version: number;

  encrypt(plaintext: string): Promise<SecretEnvelope>;
  decrypt(envelope: SecretEnvelope): Promise<string>;

  /**
   * Re-encrypt an existing envelope — for recipient rotation (age) or
   * KMS grant changes. Returning the envelope unchanged is a valid
   * no-op for single-key backends.
   */
  rewrap?(envelope: SecretEnvelope): Promise<SecretEnvelope>;
  addRecipient?(pub: RecipientInfo): Promise<void>;
  removeRecipient?(id: string): Promise<void>;
  listRecipients?(): Promise<RecipientInfo[]>;
}

/**
 * Factory that loads a backend from its TOML-shaped config block
 * (e.g. the `[backend]` table in `.am-secrets.toml`). The `config`
 * shape is backend-specific; each factory is responsible for its own
 * validation.
 */
export interface SecretsBackendFactory {
  readonly name: SecretsBackendName;
  load(config: unknown): Promise<SecretsBackend>;
}

// --- Registry ---

const _registry = new Map<string, SecretsBackendFactory>();

/** Register a backend factory. Later registrations for the same name overwrite. */
export function registerBackend(factory: SecretsBackendFactory): void {
  _registry.set(factory.name, factory);
}

/** Look up a registered factory by name. */
export function getBackend(name: string): SecretsBackendFactory | undefined {
  return _registry.get(name);
}

/** Snapshot of registered backend names (insertion order). */
export function listBackends(): string[] {
  return Array.from(_registry.keys());
}
