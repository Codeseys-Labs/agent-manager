/**
 * Format-aware secret-envelope decoder (P0-3 fix).
 *
 * The apply pipeline (`controller.ts` → `interpolateEnvAsync`) and
 * `am secret get` historically only understood the legacy `enc:v1:`
 * AES-GCM envelope. Anything else — including the ADR-0042 age envelope
 * `enc:v2:age:...` — was *passed through unchanged*, so an age-migrated
 * secret landed verbatim as ciphertext in the user's native IDE config.
 * That is silent data corruption presented as success (audit
 * `secrets-and-security.md`, CRITICAL).
 *
 * This module is the single chokepoint that:
 *   1. CLASSIFIES an envelope by its `enc:` prefix (`classifyEnvelope`),
 *   2. DISPATCHES decryption to the correct backend (`decodeEnvelope`),
 *   3. FAILS LOUD on an unknown `enc:` prefix (`UnknownEnvelopeError`) or a
 *      missing backend (`MissingBackendError`) — it NEVER returns ciphertext
 *      verbatim. A value that is not an envelope at all is returned unchanged
 *      (plaintext `${VAR}`-expanded strings flow through untouched).
 *
 * The fail-loud contract is the whole point: writing `enc:v99:...` into a
 * native config is strictly worse than refusing the apply.
 */

import { decryptValue, isLegacyV1Envelope } from "./secrets";
import type { SecretsBackend } from "./secrets-backend";

/** age (ADR-0042) envelope prefix. */
const AGE_PREFIX = "enc:v2:age:";
/** Any value beginning with this is *meant* to be an encrypted envelope. */
const ENVELOPE_SENTINEL = "enc:";

/**
 * Recognised envelope formats. `unknown-envelope` means the value starts
 * with the `enc:` sentinel but matches no backend we can decrypt —
 * decoding it MUST fail rather than leak. `plaintext` means the value is
 * not an envelope at all and should be returned unchanged.
 */
export type EnvelopeKind = "v1-aes-gcm" | "v2-age" | "unknown-envelope" | "plaintext";

/**
 * Thrown when a value carries the `enc:` sentinel but no known backend
 * recognises its format. Surfacing this aborts the apply instead of
 * writing ciphertext to disk.
 */
export class UnknownEnvelopeError extends Error {
  readonly prefix: string;
  constructor(value: string) {
    // Show only the prefix (up to the third colon or 24 chars) so the
    // ciphertext body is never echoed into logs/errors.
    const prefix = extractEnvelopePrefix(value);
    super(
      `Unknown encrypted-envelope format "${prefix}". This value carries the "enc:" sentinel but no registered secrets backend can decrypt it. Refusing to write it verbatim (that would leak ciphertext as a plaintext secret). If this is an age envelope, ensure settings.secrets.backend = "age" and the age identity is unlocked; otherwise the value may be corrupt or produced by a newer am version.`,
    );
    this.name = "UnknownEnvelopeError";
    this.prefix = prefix;
  }
}

/**
 * Thrown when a value is a recognised envelope format but the backend
 * needed to decrypt it was not supplied to `decodeEnvelope`.
 */
export class MissingBackendError extends Error {
  readonly kind: EnvelopeKind;
  constructor(kind: EnvelopeKind, hint: string) {
    super(
      `Cannot decrypt a ${kind} envelope: no decryption backend available. ${hint} Refusing to pass the ciphertext through (that would leak it as a plaintext secret).`,
    );
    this.name = "MissingBackendError";
    this.kind = kind;
  }
}

/** Return the leading prefix of an `enc:`-shaped value for safe logging. */
function extractEnvelopePrefix(value: string): string {
  // Take through the third colon (e.g. "enc:v2:age:") or fall back to a
  // short, body-free slice. Never include the ciphertext payload.
  let colons = 0;
  for (let i = 0; i < value.length && i < 64; i++) {
    if (value[i] === ":") {
      colons++;
      if (colons === 3) return value.slice(0, i + 1);
    }
  }
  // Fewer than three colons: take up to the second colon, else 16 chars.
  const secondColon = value.indexOf(":", value.indexOf(":") + 1);
  if (secondColon !== -1) return value.slice(0, secondColon + 1);
  return value.slice(0, 16);
}

/**
 * Classify a value by its envelope prefix WITHOUT attempting decryption.
 *
 * - `enc:v1:` → `v1-aes-gcm`
 * - `enc:v2:age:` → `v2-age`
 * - any other `enc:...` → `unknown-envelope` (caller MUST fail loud)
 * - anything else → `plaintext`
 */
export function classifyEnvelope(value: unknown): EnvelopeKind {
  if (typeof value !== "string") return "plaintext";
  if (value.startsWith(AGE_PREFIX)) return "v2-age";
  if (isLegacyV1Envelope(value)) return "v1-aes-gcm";
  if (value.startsWith(ENVELOPE_SENTINEL)) return "unknown-envelope";
  return "plaintext";
}

/** Backends/keys made available to {@link decodeEnvelope}. */
export interface DecodeBackends {
  /**
   * Imported AES-GCM key for `enc:v1:` envelopes. When omitted, a v1
   * envelope cannot be decrypted and decode FAILS LOUD.
   */
  legacyKey?: CryptoKey | null;
  /**
   * A loaded age backend (or any `SecretsBackend` whose `decrypt` handles
   * `enc:v2:age:`). When omitted, a v2 envelope FAILS LOUD.
   */
  ageBackend?: SecretsBackend | null;
  /**
   * Legacy graceful-degradation switch (ADR-0012 behavior). When true AND no
   * `legacyKey` is configured, a `v1-aes-gcm` envelope is returned UNCHANGED
   * instead of throwing — i.e. "the user simply hasn't set up secrets yet", so
   * the encrypted literal flows through exactly as it did pre-P0-3. This does
   * NOT relax the v2/unknown fail-loud rules (those were the real leak).
   *
   * The sole producer of this flag is `interpolateEnvAsync`, which sets it to
   * `!encryptionKey` unconditionally and exposes no override. Consequently the
   * apply path (`controller.ts` → `interpolateEnvAsync`) ALSO passes a v1
   * envelope through verbatim when no AES key is loaded — this is the documented
   * ADR-0012 graceful-degradation behavior, NOT a regression: the value is AES
   * ciphertext (not a plaintext leak), and a v1 envelope only exists at all if
   * a key was once present, so "key missing on apply" means "operator hasn't
   * brought the key to this machine yet" rather than "in-use secret is being
   * silently dropped". Once a key IS loaded, v1 envelopes decrypt normally; if
   * decryption then fails (wrong key, corrupt payload) it still throws. The
   * v2/unknown fail-loud rules — the actual P0-3 leak class — are unaffected by
   * this flag. See `test/integration/secret-pipeline.test.ts` ("v1 + no key →
   * graceful passthrough") for the contract test.
   */
  allowV1PassthroughWithoutKey?: boolean;
}

/**
 * Decode a single value, dispatching by envelope format.
 *
 * Contract:
 *   - plaintext → returned unchanged
 *   - `enc:v1:` → decrypted with `legacyKey` (else `MissingBackendError`)
 *   - `enc:v2:age:` → decrypted with `ageBackend` (else `MissingBackendError`)
 *   - unknown `enc:` prefix → `UnknownEnvelopeError`
 *
 * Never returns an `enc:...` string verbatim.
 */
export async function decodeEnvelope(value: string, backends: DecodeBackends): Promise<string> {
  const kind = classifyEnvelope(value);

  switch (kind) {
    case "plaintext":
      return value;

    case "v1-aes-gcm": {
      if (!backends.legacyKey) {
        // Legacy graceful degradation (ADR-0012): with NO key configured at
        // all, a v1 envelope passes through unchanged — the user hasn't set up
        // secrets, and the value is AES ciphertext (not plaintext). This is the
        // documented pre-P0-3 behavior and is scoped to v1 only; v2/unknown
        // still fail loud below. The apply path (`interpolateEnvAsync`) sets
        // this flag to `!encryptionKey`, so it ALSO passes v1 through when no
        // key is loaded — graceful degradation per ADR-0012, not a leak.
        if (backends.allowV1PassthroughWithoutKey) return value;
        throw new MissingBackendError(
          "v1-aes-gcm",
          "No AES-256-GCM key is loaded — run `am secret generate-key` or set AM_ENCRYPTION_KEY.",
        );
      }
      return decryptValue(value, backends.legacyKey);
    }

    case "v2-age": {
      if (!backends.ageBackend) {
        throw new MissingBackendError(
          "v2-age",
          'Set settings.secrets.backend = "age" (or AM_SECRETS_BACKEND=age) and ensure the age identity is unlocked (AM_AGE_PASSPHRASE or keychain).',
        );
      }
      return backends.ageBackend.decrypt(value);
    }

    default:
      throw new UnknownEnvelopeError(value);
  }
}
