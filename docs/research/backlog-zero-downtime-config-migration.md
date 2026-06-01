# Safe coexistence of two secret-envelope formats (`enc:v1:` AES-GCM + `enc:v2:age:`)

**Status:** research / fix plan
**Date:** 2026-05-31
**Scope:** the apply/decrypt path in agent-manager (`am`) only recognises the legacy
`enc:v1:` AES-256-GCM envelope. Values written by the ADR-0042 `age` backend
(`enc:v2:age:…`) pass through `interpolateEnvAsync` **verbatim**, so an `am apply`
will write a literal `enc:v2:age:AAAA…` string into `~/.claude.json`, `.mcp.json`,
`AGENTS.md`, etc. instead of the decrypted secret. This is a correctness + (mild)
data-integrity bug: the agent gets a garbage token, and the ciphertext is now
copied into many native config files outside the catalog.

This document (a) pins down exactly where the leak is, (b) surveys how
sops / age / git-crypt / chezmoi / 1Password handle multi-format / multi-key
coexistence and lossless migration, (c) gives a copy-adaptable
format-aware decode dispatcher, and (d) gives a concrete fix plan plus an
integration test that proves `encrypt → apply → decrypt` round-trips for **both**
formats.

---

## 1. The bug, precisely located

### 1.1 What recognises what

`src/core/secrets.ts`:

```ts
const PREFIX = "enc:v1:";

export function isEncrypted(value: string): boolean {
  return value.startsWith(PREFIX);          // <-- v1 ONLY
}

export async function decryptValue(encrypted: string, key: CryptoKey): Promise<string> {
  if (!isEncrypted(encrypted)) return encrypted;   // v2 -> early return, leaks verbatim
  // ... AES-GCM only
}
```

There is already a helper that knows about both:

```ts
export function isAnyEnvelope(value: string): boolean {
  return value.startsWith(PREFIX) || value.startsWith("enc:v2:age:");
}
```

…but it is **not used on the apply path.**

### 1.2 The leaking call site

`src/core/controller.ts` (the single `applyResolved` pipeline shared by CLI,
MCP `am_apply`, and the web `POST /api/apply`):

```ts
const encryptionKey = await loadKey(configDir);            // AES key only
const { config: interpolated } = await interpolateEnvAsync(config, {
  encryptionKey: encryptionKey ?? undefined,
});
```

`interpolateEnvAsync` (in `secrets.ts`) walks every string and decrypts only when
`isEncrypted(value)` (== `enc:v1:`) is true. For an `enc:v2:age:` value, the walk
hits the early `return value` and the ciphertext flows straight into
`buildResolvedConfig` → `adapter.export()` → disk.

Same pattern leaks in two more places:

- **`src/commands/secret.ts`** (`am secret get`): `await decryptValue(value, key)` —
  prints the v2 ciphertext verbatim. `am secret list` calls `isEncrypted` so it
  *under-reports* (won't list v2 secrets at all).
- **`src/mcp/server.ts`** (`am_apply` / secret-read tools) imports the same
  `interpolateEnvAsync`, so the MCP gateway has the identical leak.

### 1.3 What already works

`AgeSecretsBackend.decrypt()` in `src/core/secrets-age.ts` correctly consumes
`enc:v2:age:` (strips the prefix, base64-decodes, runs `Decrypter` with the
machine identity + grace-window legacy identities). The registry
(`secrets-backend.ts`) and `getDefaultBackend()` already exist. **The only missing
wire is on the read/decrypt side of apply** — the write side (encrypt) and the
migration command (`am secrets migrate`) already dispatch correctly.

So the fix is *not* "implement v2 decryption" — it is "route the apply/decrypt
walk through a format-aware decoder that already exists per-backend."

---

## 2. How the ecosystem solves this

The single most important lesson across every tool surveyed: **separate
*format/version identification* (which decryptor) from *key availability* (which
key). Identify the format by a stable, cleartext discriminant at the head of the
blob; do integrity-check *after* unwrap; migrate by decrypt-to-plaintext +
re-encrypt, never by reinterpreting the same bytes under a new scheme.**

### 2.1 Acra — the closest analog: prefix → registry → handler

Cossack Labs Acra is the textbook match for the `enc:vN:` situation. Each
ciphertext carries an `EnvelopeID` header; a registry maps that ID to a handler:

- `crypto.InitRegistry(keyStore)` registers `{EnvelopeID → handler}`.
- `DeserializeEncryptedData` extracts the `EnvelopeID` (e.g.
  `AcraStructEnvelopeID`, `AcraBlockEnvelopeID`) from the serialized header.
- `GetHandlerByEnvelopeID(id)` looks up the handler; `DecryptWithHandler(...)`
  decrypts. `ReEncryptHandler` uses the *same* registry to decrypt one envelope
  and re-encrypt to another (their `AcraStruct → AcraBlock` migration).

Source: `cossacklabs/acra` `crypto/registry_handler*.go`, `crypto/envelope_detector.go`.
Pattern doc: <https://github.com/cossacklabs/acra/blob/master/crypto/registry_handler.go>

> **Takeaway for `am`:** map a *prefix* (`enc:v1:`, `enc:v2:age:`) to a registered
> backend, then dispatch. agent-manager already has the registry
> (`registerBackend`/`getBackend`) — it just isn't consulted at decode time.

### 2.2 Dapr `dapr.io/enc/v1` — version string as the first line

Dapr's encryption scheme makes the version a literal magic line at the top of the
payload:

```
dapr.io/enc/v1
{"k":"mykey","kw":1,"wfk":"…base64…","cph":1,"np":"…base64…"}
<base64 HMAC-SHA-256 over the two lines above>
```

A decoder matches the first line against known scheme strings to dispatch, then
the JSON manifest carries the key-wrap algo (`kw`), AEAD cipher (`cph`), wrapped
file key (`wfk`), key name hint (`k`), nonce prefix (`np`). Crucial caveat: the
MAC must be verified against the manifest bytes **exactly as found** — re-encoding
the JSON reorders keys and breaks the MAC.

Source: <https://github.com/dapr/kit/blob/main/schemes/enc/v1/README.md>

> **Takeaway:** the version tag is a *dispatch discriminant first*, and crypto
> params second. `am`'s `enc:v1:` / `enc:v2:age:` prefixes already serve the
> first role; nothing parses them for dispatch yet.

### 2.3 sops — one format, try-each-key (key availability ≠ format)

sops uses envelope encryption: a random **data key** encrypts the values; the data
key is wrapped for *every* configured master key (age, PGP, KMS, Vault). On
decrypt sops iterates key groups and, within a group, tries each master key until
one succeeds (`Metadata.GetDataKeyWithKeyServices`,
`decryptKeyGroup`/`decryptKey`). Decryption order is configurable
(`--decryption-order` / `SOPS_DECRYPTION_ORDER`, default `age` then `pgp`); a MAC
over the plaintext is verified *after* the data key is recovered.

Migration / rekey is lossless and explicit:
- `sops updatekeys` — re-wrap the *same* data key for the new master-key set.
- `sops rotate` — generate a *new* data key, re-encrypt all values, re-wrap.
- Removing a recipient is paired with `rotate` so the removed party can't reuse the
  old data key.

Sources: <https://getsops.io/docs>, `getsops/sops` `decrypt/decrypt.go`,
`keyservice/server.go`; version lives in the `sops` metadata `Version` field and
is read for backward-compat (old numeric-vs-string version handling).

> **Takeaway:** sops *doesn't* prefix-dispatch — it's a single format with
> multiple wrapped keys. That's the **other** valid model. For `am` it maps onto a
> future "the age backend can hold *both* the new identity and the legacy AES key,
> try each" design — but today `am` has two genuinely different wire formats, so
> Acra/Dapr prefix-dispatch is the right model, with sops's *rotate vs updatekeys*
> distinction informing the migration command.

### 2.4 age — fixed header version + recipient stanzas

age files begin with the literal `age-encryption.org/v1`. The reference impl
guarantees v1 files decrypt under later v1 libraries; v2 may opt-in change
compatibility. Multiple recipients are normal (each recipient stanza wraps the
same file key); adding/removing recipients rewrites only the header + header MAC,
never the plaintext. Newer API (`ExtractHeader`, `DecryptHeader`) reinforces
"header is the discriminant + key-routing layer; payload decrypt is stage two."

Sources: `FiloSottile/age` `age.go`; the TS port `FiloSottile/typage`
(npm `age-encryption`) — the exact lib `am` already uses.

> **Takeaway:** the `enc:v2:age:` payload *internally* already does
> recipient-stanza routing for free (this is how ADR-0051 grace-window
> dual-decrypt works). `am`'s outer prefix only needs to pick "age backend"; age
> picks the identity.

### 2.5 chezmoi — configured backend + per-format suffix detection

chezmoi defines an `Encryption` interface (`Encrypt`/`Decrypt`/`DecryptToFile`/
`EncryptFile`/`EncryptedSuffix`) with implementations `AgeEncryption`,
`GPGEncryption`, `TransparentEncryption`, `NoEncryption`, `DebugEncryption`. The
active backend is chosen by config (`encryption = "age" | "gpg" | …`), with
auto-detection if unset (gpg-first for backwards compat). Encrypted files are
*detected by suffix* (`.age`, `.asc`/`.gpg`) returned by `EncryptedSuffix()`.

Source: `twpayne/chezmoi` `internal/cmd/config.go` `setEncryption()`, the
`Encryption` interface + DeepWiki "Encryption Systems".

> **Takeaway:** chezmoi's `Encryption` interface == `am`'s `SecretsBackend`
> interface. chezmoi routes on a *file suffix*; `am` routes on a *value prefix*.
> Same shape. The `DebugEncryption` wrapper and `NoEncryption` (errors loudly) are
> nice patterns to copy: a backend that *refuses* rather than silently
> passes-through is what would have caught this bug.

### 2.6 1Password / Bitwarden — runtime references, not at-rest envelopes

`op` uses `op://vault/item/field` secret references resolved at runtime by
`op run` / `op read` / `op inject` (scan env for the `op://` scheme, substitute).
Migration between managers is an *export→import* of plaintext (1pux/CSV/JSON),
i.e. decrypt-to-canonical + re-import — again the universal "never reinterpret
ciphertext" rule. Less directly applicable (these are references, not at-rest
ciphertext), but they confirm the prefix-scheme dispatch (`op://`) and
decrypt-then-reimport migration model.

Sources: <https://www.1password.dev/cli/secret-references>,
<https://bitwarden.com/help/releasenotes>.

---

## 3. The universal pattern (distilled)

| Concern | Rule | Tools |
|---|---|---|
| **Identify format** | Cleartext discriminant at the head (magic/prefix/suffix), matched *before* any parse | age (`age-encryption.org/v1`), git-crypt (`[GITCRYPT]`), Dapr (`dapr.io/enc/v1`), Acra (`EnvelopeID`), chezmoi (suffix) |
| **Route** | Discriminant → registered handler/backend; never a giant `if/else` that grows per format | Acra `GetHandlerByEnvelopeID`, chezmoi `Encryption` iface |
| **Key vs format** | Format says *how to parse*; recipient/key set says *who can unwrap*. Keep separate | sops (key groups), age (stanzas) |
| **Integrity** | AEAD/MAC verify *after* unwrap, before returning plaintext | sops MAC, age header MAC, git-crypt GCM tag |
| **Migrate** | decrypt → stable plaintext → re-encrypt new envelope. Never reinterpret bytes | sops `rotate`/`updatekeys`, git-crypt rekey, chezmoi backend switch, 1pw export/import |
| **Fail loud on unknown** | An unrecognised-but-`enc:`-looking value must **error**, not pass through | chezmoi `NoEncryption`, sops `MetadataNotFound` |

The last row is the one `am` violates today (silent pass-through).

---

## 4. Copy-adaptable fix: a format-aware decode dispatcher

agent-manager already has the registry and per-backend `decrypt()`. Add a thin
prefix→backend decoder and route `interpolateEnvAsync` (and `am secret get`)
through it.

### 4.1 New: `decodeEnvelope` in `src/core/secrets-decode.ts`

```ts
// src/core/secrets-decode.ts
import type { SecretsBackend } from "./secrets-backend";

const V1_PREFIX = "enc:v1:";
const V2_AGE_PREFIX = "enc:v2:age:";

/** Backends resolved once per apply, keyed by the prefix they own. */
export interface EnvelopeDecoders {
  /** Legacy AES-GCM backend (handles `enc:v1:`). May be null if no key. */
  v1?: SecretsBackend | null;
  /** age backend (handles `enc:v2:age:`). May be null if not configured/unlockable. */
  v2age?: SecretsBackend | null;
}

export type EnvelopeKind = "v1" | "v2age" | "plain";

/** Pure, allocation-free discriminant — matches the Acra/Dapr "identify first" rule. */
export function classifyEnvelope(value: string): EnvelopeKind {
  if (value.startsWith(V2_AGE_PREFIX)) return "v2age";
  if (value.startsWith(V1_PREFIX)) return "v1";
  return "plain";
}

export class UnknownEnvelopeError extends Error {
  constructor(public readonly sample: string) {
    super(
      `Unrecognised encrypted envelope: "${sample.slice(0, 24)}…". ` +
        `Expected enc:v1: (AES-GCM) or enc:v2:age:. ` +
        `Refusing to write ciphertext to a native config.`,
    );
    this.name = "UnknownEnvelopeError";
  }
}

export class MissingBackendError extends Error {
  constructor(kind: EnvelopeKind) {
    super(
      kind === "v2age"
        ? `Found an enc:v2:age: secret but the age backend is unavailable ` +
          `(no identity / passphrase). Run \`am secret unlock\` or set AM_AGE_PASSPHRASE.`
        : `Found an enc:v1: secret but no AES-GCM key is available. ` +
          `Run \`am secret generate-key\` or set AM_ENCRYPTION_KEY.`,
    );
    this.name = "MissingBackendError";
  }
}

/**
 * Format-aware decode. Routes the value to the backend that owns its prefix.
 * - plaintext -> returned unchanged
 * - recognised prefix, backend present -> decrypt
 * - recognised prefix, backend absent -> MissingBackendError (loud)
 * - `enc:` but unknown version -> UnknownEnvelopeError (loud) -- NEVER pass through
 */
export async function decodeEnvelope(
  value: string,
  decoders: EnvelopeDecoders,
): Promise<string> {
  const kind = classifyEnvelope(value);
  if (kind === "plain") {
    // Guard the silent-leak class of bugs: an `enc:`-looking value with an
    // unknown version must fail, not flow to disk.
    if (value.startsWith("enc:")) throw new UnknownEnvelopeError(value);
    return value;
  }
  const backend = kind === "v2age" ? decoders.v2age : decoders.v1;
  if (!backend) throw new MissingBackendError(kind);
  return backend.decrypt(value);
}
```

Why a registry rather than a `switch`: it keeps the Acra "register a handler per
envelope ID" shape, so `enc:v3:kms:` etc. drop in without touching call sites.
You can also derive `decoders` straight from the existing registry by mapping a
prefix table `{ "enc:v1:": "aes-gcm-legacy", "enc:v2:age:": "age" }` to
`getBackend(name)` if you prefer one source of truth.

### 4.2 Wire it into `interpolateEnvAsync`

Today `interpolateEnvAsync(config, { encryptionKey })` only does v1. Add a
backend-aware overload that the controller uses, keeping the old signature for
back-compat (and tests):

```ts
// secrets.ts — additive overload
export async function interpolateEnvAsync(
  config: Config,
  options: InterpolateOptions & {
    encryptionKey?: CryptoKey;          // legacy v1 path (kept)
    decoders?: EnvelopeDecoders;        // NEW: format-aware path
  } = {},
): Promise<InterpolateResult> {
  const { encryptionKey, decoders, ...interpolateOpts } = options;
  const result = interpolateEnv(config, interpolateOpts);
  if (!encryptionKey && !decoders) return result;

  async function walk(value: unknown): Promise<unknown> {
    if (typeof value === "string") {
      if (decoders) return decodeEnvelope(value, decoders);       // <-- both formats
      if (isEncrypted(value)) return decryptValue(value, encryptionKey!); // legacy fallback
      return value;
    }
    if (Array.isArray(value)) return Promise.all(value.map(walk));
    if (value && typeof value === "object") {
      const entries = await Promise.all(
        Object.entries(value as Record<string, unknown>)
          .map(async ([k, v]) => [k, await walk(v)] as const),
      );
      return Object.fromEntries(entries);
    }
    return value;
  }
  return { config: (await walk(result.config)) as Config, warnings: result.warnings };
}
```

### 4.3 Build the `decoders` in the controller (the actual fix)

`src/core/controller.ts`, replacing the leaking block:

```ts
import { interpolateEnvAsync, loadKey, AesGcmLegacyBackend, getDefaultBackend } from "./secrets";
import type { EnvelopeDecoders } from "./secrets-decode";

// inside applyResolved(), after loadResolvedConfig:
const decoders: EnvelopeDecoders = {};

// v1: legacy AES — present iff a machine key exists.
const aesKey = await loadKey(configDir);
if (aesKey) decoders.v1 = new AesGcmLegacyBackend(aesKey);

// v2: age — resolve lazily; only construct if the config or any value needs it.
// getDefaultBackend already self-registers + wires the passphrase provider.
// Wrap in try so a locked keychain doesn't break a v1-only apply.
try {
  const age = await getDefaultBackend(configDir, { override: "age" });
  decoders.v2age = age;
} catch {
  decoders.v2age = null; // decodeEnvelope -> MissingBackendError only if a v2 value is hit
}

const { config: interpolated } = await interpolateEnvAsync(config, { decoders });
```

Important nuances:

1. **Lazy age unlock.** Don't force an age passphrase prompt on every apply.
   Two good options: (a) pre-scan the resolved config with `classifyEnvelope`
   and only construct the age backend if at least one `v2age` value exists; or
   (b) make `decoders.v2age` a *thunk* `() => Promise<SecretsBackend>` resolved on
   first hit inside `decodeEnvelope`. Option (a) is simpler and matches the
   "identify first" rule:

   ```ts
   const needsAge = JSON.stringify(config).includes("enc:v2:age:");
   if (needsAge) { /* construct age backend, prompt/unlock */ }
   ```

2. **`getDefaultBackend(configDir, { override: "age" })`** ignores
   `settings.secrets.backend` so you can decode v2 even when the *write* default
   is still legacy (the mixed-migration window — exactly the coexistence case).

3. **Fix the two sibling leaks too:**
   - `src/commands/secret.ts` `get`: replace `decryptValue(value, key)` with
     `decodeEnvelope(value, decoders)`.
   - `am secret list`: replace `isEncrypted(v)` with `classifyEnvelope(v) !== "plain"`
     so v2 secrets are listed.
   - `src/mcp/server.ts`: it imports `interpolateEnvAsync` — pass `decoders` the
     same way the controller does (or just route MCP `am_apply` through
     `applyResolved`, which it largely already does).

### 4.4 The migration command — already correct, but align semantics

`am secrets migrate` already does decrypt-v1 → re-encrypt-to-current (the lossless
"never reinterpret" rule), writes a `.bak`, supports `--dry-run`/`--file`. Two
sops-informed refinements:

- Mirror sops's **`rotate` vs `updatekeys`** distinction in docs/flags: `migrate`
  is a *re-envelope* (v1→v2), which is sops-`rotate`-like (new scheme, new
  ciphertext). A future `am secrets rewrap` (already present for v2 recipient
  changes) is the sops-`updatekeys` analog.
- After the apply path can read v2, you can flip `settings.secrets.backend = "age"`
  and run `am secrets migrate` to retire v1 — and apply keeps working throughout
  the mixed window because the decoder handles both.

---

## 5. Integration test: prove `encrypt → apply → decrypt` for BOTH formats

Add `test/integration/dual-envelope-apply.test.ts`. The assertion that *would have
caught the bug*: after `applyResolved`, the native config contains the **plaintext
secret**, and contains **no `enc:`** substring.

```ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import * as TOML from "@iarna/toml";
import { applyResolved } from "../../src/core/controller";
import {
  AesGcmLegacyBackend, generateKey, importKey, saveKey,
} from "../../src/core/secrets";
import { getDefaultBackend } from "../../src/core/secrets";
import { type TestDir, createTestDir } from "../helpers/tmp";

describe("apply decrypts both enc:v1: and enc:v2:age: envelopes", () => {
  let cfg: TestDir, keyDir: TestDir, ageDir: TestDir, project: TestDir;
  const env = { ...process.env };

  beforeEach(async () => {
    cfg = await createTestDir("am-dual-cfg-");
    keyDir = await createTestDir("am-dual-key-");
    ageDir = await createTestDir("am-dual-age-");
    project = await createTestDir("am-dual-proj-");
    // Isolate ALL key material from the real machine.
    process.env.AM_CONFIG_DIR = cfg.path;
    process.env.AM_KEY_PATH = join(keyDir.path, "key");        // v1 AES key
    process.env.AM_AGE_IDENTITY_DIR = ageDir.path;             // v2 age identity
    process.env.AM_AGE_PASSPHRASE = "test-passphrase-123456";  // non-interactive unlock
  });

  afterEach(async () => {
    process.env = env;
    await Promise.all([cfg.cleanup(), keyDir.cleanup(), ageDir.cleanup(), project.cleanup()]);
  });

  test("v1 + v2 secrets both reach native config as plaintext", async () => {
    // --- arrange: produce one real v1 envelope and one real v2 envelope ---
    const aesB64 = await generateKey();
    await saveKey(cfg.path, aesB64);
    const aes = new AesGcmLegacyBackend(await importKey(aesB64));
    const v1 = await aes.encrypt("super-secret-v1");

    // age backend self-creates the identity on first encrypt.
    const age = await getDefaultBackend(cfg.path, { override: "age" });
    const v2 = await age.encrypt("super-secret-v2");

    expect(v1.startsWith("enc:v1:")).toBe(true);
    expect(v2.startsWith("enc:v2:age:")).toBe(true);

    // --- write a config.toml with one server whose env holds both ---
    const config = {
      servers: {
        demo: {
          command: "echo",
          env: { TOKEN_V1: "${TOKEN_V1}", TOKEN_V2: "${TOKEN_V2}" },
        },
      },
      settings: { env: { TOKEN_V1: v1, TOKEN_V2: v2 } },
    };
    // NOTE: TOKEN_* hold the *envelopes*; interpolation expands ${VAR} then decode runs.
    await Bun.write(join(cfg.path, "config.toml"), TOML.stringify(config as any));

    // --- act: run the real apply pipeline against a tmp project ---
    // (use a target adapter you can read back deterministically, e.g. claude-code)
    await applyResolved(cfg.path, { projectPath: project.path, target: "claude-code" });

    // --- assert: the native file has plaintext, NOT ciphertext ---
    const mcp = await readFile(join(project.path, ".mcp.json"), "utf-8");
    expect(mcp).toContain("super-secret-v1");   // v1 decrypted
    expect(mcp).toContain("super-secret-v2");   // v2 decrypted  <-- fails today
    expect(mcp).not.toContain("enc:v1:");       // no leaked ciphertext
    expect(mcp).not.toContain("enc:v2:age:");   // no leaked ciphertext  <-- fails today
  });

  test("unknown enc: version fails loud instead of leaking", async () => {
    const config = {
      servers: { demo: { command: "echo", env: { X: "${X}" } } },
      settings: { env: { X: "enc:v9:martian:AAAA" } },
    };
    await Bun.write(join(cfg.path, "config.toml"), TOML.stringify(config as any));
    await expect(
      applyResolved(cfg.path, { projectPath: project.path, target: "claude-code" }),
    ).rejects.toThrow(/Unrecognised encrypted envelope/);
  });
});
```

Test design notes (align with existing repo conventions in
`test/integration/secret-pipeline.test.ts`):

- **Isolate every key source** via env (`AM_CONFIG_DIR`, `AM_KEY_PATH`,
  `AM_AGE_IDENTITY_DIR`, `AM_AGE_PASSPHRASE`) so the test never touches `~/`.
  `AM_AGE_PASSPHRASE` is the supported non-interactive provider
  (`envPassphraseProvider()` in `secrets-age.ts`), which keeps the test headless.
- **Round-trip through the *real* `applyResolved`**, not a unit of `decryptValue`
  — the bug lives in the wiring, so a unit test of `decodeEnvelope` alone would
  pass while apply still leaks.
- The two negative assertions (`not.toContain("enc:…")`) are the regression
  guard: they are what's violated by the current code.
- Add a focused unit test for `decodeEnvelope`/`classifyEnvelope` too
  (plaintext / v1 / v2 / unknown / missing-backend), but the *integration* test is
  the one that proves the fix.

---

## 6. Concrete fix plan (ordered, low-risk)

1. **Add `src/core/secrets-decode.ts`** with `classifyEnvelope`, `decodeEnvelope`,
   `EnvelopeDecoders`, `UnknownEnvelopeError`, `MissingBackendError` (§4.1). Pure,
   fully unit-testable, no I/O.
2. **Extend `interpolateEnvAsync`** with an additive `{ decoders }` option that
   routes through `decodeEnvelope`; keep the `{ encryptionKey }` path for
   back-compat (§4.2). No call site breaks.
3. **Fix `applyResolved`** (controller.ts) to build `decoders` (v1 from
   `loadKey`, v2 via `getDefaultBackend(_, { override: "age" })`, lazily/guarded)
   and pass `{ decoders }` (§4.3). This closes the leak for CLI **and** MCP
   **and** web, since all three share the controller.
4. **Fix `am secret get` / `list`** in `secret.ts` to use `decodeEnvelope` /
   `classifyEnvelope` (§4.3.3).
5. **Add the integration test** in §5 (red → green) plus a `decodeEnvelope` unit
   test. Run `bun test test/integration/dual-envelope-apply.test.ts`.
6. **Doc:** note in ADR-0042 (or a short ADR-0052) that apply now decodes both
   envelopes via a prefix→backend registry, and that unknown `enc:` versions fail
   loud. Record the sops `rotate` vs `updatekeys` mapping for `migrate`/`rewrap`.
7. **Optional hardening:** add a CI grep/lint that fails if any `adapter.export`
   output contains the substring `enc:` (defense-in-depth against future leaks),
   mirroring the existing `scanServersForUrlCredentials` late guard already in
   `applyResolved`.

### Risk / compatibility
- Purely additive; the legacy `{ encryptionKey }` signature stays.
- The new loud-failure on unknown `enc:` is a behaviour change, but only for
  values that are *already broken* (would otherwise leak ciphertext) — strictly
  safer.
- age unlock is gated behind "a v2 value is actually present," so v1-only and
  no-secret applies are unaffected and won't prompt.

---

## 7. Sources

- sops design / multi-key / rotate vs updatekeys: <https://getsops.io/docs>;
  `getsops/sops` `decrypt/decrypt.go`, `keyservice/server.go`; key-groups/quorum:
  <https://github.com/getsops/sops/issues/1560>
- age format version + recipient stanzas: `FiloSottile/age` `age.go`
  (<https://github.com/FiloSottile/age/blob/main/age.go>); changing recipients:
  <https://github.com/FiloSottile/age/issues/136>; TS port used by `am`:
  `FiloSottile/typage` / npm `age-encryption` (<https://github.com/FiloSottile/typage>)
- git-crypt magic-prefix format + backward compat:
  <https://docs.rs/git-crypt>; <https://github.com/AGWA/git-crypt/blob/master/RELEASE_NOTES-0.4.md>;
  rekey workflow: <https://gist.github.com/bartv2/7e1c127d6af397bc0e4da6d11fb7ea6c>
- chezmoi `Encryption` interface + backend selection + suffix detection:
  `twpayne/chezmoi` `internal/cmd/config.go` (`setEncryption`); DeepWiki
  "Encryption Systems"
- Dapr versioned scheme header + manifest dispatch:
  <https://github.com/dapr/kit/blob/main/schemes/enc/v1/README.md>
- Acra envelope-ID registry dispatch + re-encrypt:
  `cossacklabs/acra` `crypto/registry_handler.go`, `crypto/envelope_detector.go`
- 1Password secret references / runtime substitution:
  <https://www.1password.dev/cli/secret-references>; Bitwarden import/migration:
  <https://bitwarden.com/help/releasenotes>
- HashiCorp Vault transit envelope encryption (DEK/KEK model, general):
  <https://developer.hashicorp.com/vault/docs/secrets/transit/envelope-encryption>
