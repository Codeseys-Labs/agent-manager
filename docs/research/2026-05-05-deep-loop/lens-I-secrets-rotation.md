# Lens I: `am secrets rotate` Design + Grace-Period Research

Date: 2026-05-05
Context: ADR-0042 (Universal Secrets Strategy) sketches `am secrets rotate`
as "generate new identity, rewrap all, push" but the current implementation
(`src/commands/secrets-rotate.ts`) only rewraps existing envelopes without
generating a new identity. Lens C (`lens-age-sota.md` §3) flagged the
missing grace-period / legacy-recipient story. This lens closes the design
gap.

## 1. Findings: Prior Art Survey

### 1.1 SOPS — The Gold Standard for Grace-Period Rotation

SOPS (getsops/sops, v3.9+ 2026) provides the most mature rotation UX in
the age ecosystem. It distinguishes two operations:

- **`sops updatekeys`** — Rewraps only the _data encryption key_ (DEK) for
  new recipients. The encrypted values and MAC remain unchanged, producing
  minimal git diffs. This is the recommended approach for recipient
  rotation because it touches only the metadata block.
- **`sops --rotate --in-place`** — Generates a new DEK and re-encrypts
  _all values_. Changes every encrypted field. This is akin to a full
  re-encrypt and is coarser than `updatekeys`.

The canonical two-phase grace-period flow (Source: OneUptime blog,
2026-03-13, "How to Rotate SOPS Age Keys Without Re-Encrypting All
Files"):

1. **Phase 1 — Add new key.** Update `.sops.yaml` to list both old and
   new age recipients (`age1oldkey..., age1newkey...`). Run `sops
   updatekeys` on every encrypted file. The new key holder can now
   decrypt; the old key holder still can. Commit and push.
2. **Phase 2 — Remove old key (after confirmation window).** Update
   `.sops.yaml` to remove the old key. Run `sops updatekeys` again.
   The old key is now cryptographically excluded.

Key insight: because `updatekeys` only rewraps the DEK (not the
values), both phases produce small, reviewable diffs. Full
`--rotate` is reserved for DEK lifecycle rotation, not recipient
management.

SOPS also supports a **gradual file-by-file rotation** strategy: keep
both keys in `.sops.yaml`, migrate files as they are edited for other
reasons, track progress with `grep -rl "age1oldkey"`. This is
pragmatic for large repos where touching every file at once creates
merge-conflict storms.

**Race condition posture.** SOPS does NOT handle concurrent edits;
it relies on workflow discipline (Source: getsops/sops issue #52,
"merge conflicts with MAC signature"). The documented workaround is
`sops --ignore-mac` followed by `:wq` to regenerate the MAC. This is
acknowledged as a training burden. SOPS has no lockfile or distributed
coordination mechanism — neither does agenix, passage, git-crypt, or
any tool in this class.

### 1.2 agenix — Declarative Rekey, No Grace Period

agenix (ryantm/agenix) provides `agenix --rekey` which walks every
`.age` secret defined in `secrets.nix`, decrypts it, and re-encrypts
it to the current `publicKeys` set. There is NO built-in grace period:
when you remove a public key from `secrets.nix` and rekey, that key
holder immediately loses access. The flow is atomic cutover.

agenix _does_ support multiple identities for decryption (via `-i`
flags), which means an operator _could_ manually dual-encrypt during
a transition window by keeping the old key in `publicKeys` until all
machines have pulled the new config. But this is manual discipline,
not a tool-enforced grace period.

Source: DeepWiki on ryantm/agenix; agenix README; agenix-rekey
(oddlama/agenix-rekey) for the Nix module that extends the base
rekey flow with per-host derivation.

### 1.3 passage / pass + age — Manual Only

passage (Filippo Valsorda's age-based password store) and
pass + age have NO built-in rotation or multi-recipient support.
Rotation is manual: generate a new key, re-encrypt every `.age`
file, update `.age-recipients`. For multi-machine setups, users
typically add a hardware-bound YubiKey identity as a secondary
recipient to survive key loss, but this is backup, not rotation.

Source: passage README (sr.ht/~gpanders/passage); Filippo's blog
post "My age+YubiKeys Password Management Solution"; age
cookbook (sandipb.net).

### 1.4 Crypto Primitives: Forward Secrecy in age

The age v1 format (age-encryption.org/v1) uses:

1. An ephemeral X25519 keypair per encryption operation
2. The ephemeral key wraps a random 128-bit file key via ECIES
   (X25519 + HKDF-SHA-256)
3. The file key encrypts the payload via ChaCha20-Poly1305
4. For each recipient, the file key is wrapped separately in a
   header "stanza"

This is **not** forward-secret. If a recipient's long-term X25519
identity key is compromised, the attacker can decrypt every past
ciphertext whose header contains a stanza encrypted to that
recipient's public key. The ephemeral keypair provides _sender_
anonymity (the recipient cannot prove who encrypted the file), but
it does NOT provide forward secrecy — the file key is deterministically
recoverable from the static key.

**Practical implication for rotation:** After generating a new identity
and rotating, old ciphertexts that were NOT rewrapped remain decryptable
by the old identity. Rotation only protects _new_ ciphertexts. For full
protection after a key compromise, every ciphertext must be rewrapped.
This is not a bug — it is the explicit design of age's key-wrapping
model and is identical to the guarantees provided by SOPS, agenix, and
PGP. It must be documented clearly in SECURITY.md.

Source: Neil Madden's "A few comments on 'age'" (2019); age
specification v1; dev.to "Encrypting Files in a Post-PGP Age" on
forward secrecy distinctions.

### 1.5 Argon2id Parameters — 2025-2026 Guidance

OWASP Password Storage Cheat Sheet (2025) and RFC 9106 confirm
our current defaults are appropriate:

- **OWASP minimum:** m=19 MiB, t=2, p=1
- **OWASP "more resources available":** m=46 MiB, t=1, p=1
- **Our default:** m=128 MiB (131072 KiB), t=3, p=4
- **RFC 9106 recommended for 1-second target on 2025 hardware:**
  m=256 MiB, t=3, p=4

Our 128 MiB default is conservative and well above the OWASP floor.
The existing `resolveArgon2idParams()` validation in
`src/core/secrets-age.ts` enforces lower bounds (min 8 MiB memory,
1 <= time, 1 <= p <= 16). Users may override via
`settings.secrets.argon2` in `config.toml`. When parameters change,
the user must run `am secrets rewrap` so the new identity file uses
the updated KDF cost.

Source: OWASP Cheat Sheet Series (cheatsheetseries.owasp.org);
RFC 9106 (rfc-editor.org/rfc/rfc9106); guptadeepak.com comprehensive
guide 2026; bellatorcyber.com analysis.

## 2. Recommended CLI Surface

### 2.1 Verb Taxonomy

The current implementation conflates three distinct operations
under one verb. We propose splitting into:

| Verb                        | Action                                                  | ID change? |
|-----------------------------|---------------------------------------------------------|------------|
| `am secrets rewrap`         | Re-encrypt all envelopes to current recipient set       | No         |
| `am secrets rotate`         | Generate new identity, dual-encrypt, update recipients  | Yes        |
| `am secrets rotate --finalize` | Drop old identity, rewrap to new-only recipients      | Removes old|
| `am secrets revoke <id>`    | Remove recipient `<id>`, rewrap                         | No         |

Today `am secrets rotate` is semantically identical to `am secrets
rewrap` — it walks `enc:v2:age:...` envelopes and calls
`AgeSecretsBackend.rewrap()`. It does NOT generate a new identity.
This is a bug relative to ADR-0042's specification.

### 2.2 `am secrets rotate` — Full Flow

```
$ am secrets rotate
? This will generate a new age identity and re-encrypt all secrets.
  Existing secrets will remain decryptable by the OLD identity for
  a 7-day grace period. Continue? [y/N] y
? Enter NEW master passphrase: *****
? Confirm NEW master passphrase: *****

Generating new X25519 identity... done (recipient: age1abc...)
Dual-encrypting 23 envelopes for grace period... done
Updating recipients/laptop.pub... done
Committing: "am: rotate identity for laptop (grace period until 2026-05-12)"

To finalize rotation and drop the old identity, run:
  am secrets rotate --finalize
```

1. **Gate checks:**
   - Clean working tree (no uncommitted changes).
   - No `am pair accept --pending` detected on the config repo
     (i.e., no `.pub` file exists without a corresponding rewrap
     commit from any paired device). We detect this by comparing
     `recipients/*.pub` against the `[age].recipients` list in
     `.am-secrets.toml` and checking whether a corresponding rewrap
     commit exists. This is a heuristic; false positives are safer
     than false negatives — we err on the side of aborting.
   - Active backend is `age` (already enforced in current code).

2. **Identity generation:**
   - Generate a new `AGE-SECRET-KEY-1...` via `generateIdentity()`.
   - Prompt for a NEW passphrase (the old passphrase may be
     compromised — that is the motivation for rotation).
   - Write new `identity.age` wrapped to the new passphrase.
   - Write OLD identity to `identities/identity.age.old` so the
     grace-period decrypt path can find it.

3. **Grace-period dual-encrypt:**
   - For every `enc:v2:age:...` envelope in the repo:
     - Decrypt with old identity (still unlocked).
     - Re-encrypt to `[old_recipient, new_recipient] +
       other_recipients`.
   - Net effect: every value is now decryptable by BOTH old and
     new identity holders during the grace window.

4. **Commit:**
   - Update `recipients/<hostname>.pub` → new public key.
   - Commit all rewrapped files in one atomic commit.
   - Message includes grace-period expiry date.

### 2.3 `am secrets rotate --finalize`

```
$ am secrets rotate --finalize
? This will drop the old identity and re-encrypt all secrets to the
  new identity only. After this, old identity holders cannot decrypt.
  Continue? [y/N] y

Rewrapping 23 envelopes to new-only recipient set... done
Deleting identities/identity.age.old... done
Committing: "am: finalize identity rotation for laptop"
```

1. Requires the old identity file (`identity.age.old`) to exist.
2. Decrypts every envelope with the new identity, re-encrypts to
   the new-only recipient set.
3. Deletes `identity.age.old` and commits.

### 2.4 `am secrets rewrap` — Recipient Sync

This verb already exists (invoked internally by `am pair finalize`).
It rewraps all envelopes to the current `[age].recipients` set
_without_ changing the local identity. This is the correct verb for:

- After `am pair accept` on a new device → original device runs
  `am pair finalize` → triggers `am secrets rewrap`.
- After `am secrets revoke <id>` removes a `.pub` file.

### 2.5 `am secrets revoke <id-or-fingerprint>`

```
$ am secrets revoke laptop-lost
? Revoke recipient "laptop-lost" and rewrap all secrets?
  The revoked device will lose access immediately. [y/N] y
Removing recipients/laptop-lost.pub... done
Rewrapping 23 envelopes... done
Committing: "am: revoke recipient laptop-lost"
```

This is a thin convenience wrapper over `git rm recipients/<id>.pub
&& am secrets rewrap`. Called out as its own verb for discoverability,
matching the `pair accept` / `pair finalize` pattern from ADR-0047.

### 2.6 Grace-Period Window Configuration

Configurable in `.am-secrets.toml`:

```toml
[age]
grace_period_days = 7   # default; set to 0 for immediate cutover
```

A `grace_period_days = 0` causes `am secrets rotate` to skip
dual-encrypt and proceed directly to single-recipient new-key
encryption (immediate cutover, like agenix `--rekey`).

### 2.7 `--dry-run` and `--json` Output

All commands support `--dry-run` (report planned changes) and
`--json` (machine-readable output). The JSON output for `rotate`
includes:

```json
{
  "action": "rotate",
  "phase": "dual-encrypt",
  "old_recipient": "age1old...",
  "new_recipient": "age1new...",
  "grace_period_until": "2026-05-12T00:00:00Z",
  "files": 23,
  "envelopes": 147
}
```

## 3. Cryptographic Justification

### 3.1 When Rotation Actually Matters

Rotation of the per-machine X25519 identity is cryptographically
meaningful in exactly two scenarios:

**Scenario A — Master passphrase compromised.** If an attacker
obtains the user's master passphrase AND has access to the
`identity.age` file (either from the local filesystem, a backup,
or the config repo if the identity was inadvertently committed),
they can unwrap the X25519 private key and decrypt every
ciphertext that key is a recipient of.

Rotation with a NEW passphrase generates a new X25519 keypair.
After finalization (old identity dropped), the attacker can no
longer decrypt _new_ ciphertexts. However, past ciphertexts that
were not rewrapped remain decryptable — age has no forward secrecy.

**Scenario B — Old recipient key in untrusted hands.** If a paired
device is lost, stolen, or decommissioned, its age identity (or
the passphrase that unwraps it) is in untrusted hands. Revoking
the device (`am secrets revoke`) and rewrapping excludes its
public key from the recipient set.

If the user's own identity (not a peer) is suspected compromised,
rotation generates a new own-identity and dual-encrypts for the
grace window.

### 3.2 Argon2id 128 MiB Prevents Brute-Force

With our default m=128 MiB, t=3, p=4, an attacker attempting to
brute-force the passphrase that wraps `identity.age` must spend
~128 MiB of RAM per guess on hardware that may not parallelize well
(memory-hardness). At 80-180 ms per derivation on a 2026 laptop
(M3/M4), an 8-character mixed-case alphanumeric passphrase (~48
bits of entropy) requires ~2^47 guesses, or ~500 million CPU-years.

This is the primary defense. Rotation is a secondary control:
even if Argon2id holds, operational compromise of the passphrase
(e.g., shoulder surfing, keylogger, clipboard leak) bypasses
Argon2id entirely.

### 3.3 Forward Secrecy Limitation — Must Document

Age provides **no forward secrecy** for static X25519 recipients.
This is by design and is shared by every tool in this class (SOPS,
agenix, git-crypt). After a key compromise, the only mitigation
for past ciphertexts is:

1. Rotate the secret values themselves (not just the encryption
   keys). If the plaintext was `password123` and the attacker
   decrypted it during the compromise window, changing only the
   encryption key does nothing — the attacker already has the
   plaintext.
2. Accept that historical ciphertexts remain decryptable by the
   compromised key.

This must be stated explicitly in SECURITY.md: "Rotation protects
future confidentiality. It does not retroactively secure ciphertexts
that were decryptable by a compromised key."

### 3.4 KEK Rotation vs. DEK Rotation

In age's model:

- The **KEK** is the per-machine X25519 identity key.
- The **DEK** is the per-file 128-bit file key (random per
  encryption operation).
- Rotating the KEK (what `am secrets rotate` does) means old
  DEKs wrapped to the old KEK become inaccessible to the old
  KEK holder after finalization.
- Rotating the DEK (what SOPS's `--rotate` does) means generating
  a new random file key and re-encrypting the payload with it.
  Our `rewrap` operation does this implicitly: decrypt-then-encrypt
  produces a fresh DEK each time.

Our design correctly focuses on KEK rotation because DEK rotation
alone (without KEK change) provides no security benefit against
a compromised recipient — the attacker still has the KEK and can
unwrap any DEK.

## 4. Phase-1 Scope

### 4.1 Must-Ship (Phase 1)

1. **Fix `am secrets rotate` to actually generate a new identity.**
   Today it is a no-op alias for `rewrap`. Add:
   - `AgeSecretsBackend.rotate()` method (generate new keypair,
     save old to `identity.age.old`, prompt for new passphrase).
   - CLI flow with `--keep-old` (grace period) and `--finalize`.
   - Gate: clean working tree, no pending pair operations.

2. **Add `am secrets revoke <id>` convenience verb.**
   `git rm recipients/<id>.pub` + `am secrets rewrap` in one step
   with confirmation prompt.

3. **Add `grace_period_days` to `.am-secrets.toml` schema.**
   Default 7 days. Zero means immediate cutover.

4. **Add `--dry-run` and `--json` to all rotation verbs.**
   Already partially present in `secrets-rotate.ts`; extend.

5. **Update SECURITY.md with forward-secrecy limitation.**
   Explicit statement about what rotation does and does not protect.

### 4.2 Deferred (Phase 2+)

1. **Automated grace-period expiry.** A `pre-commit` hook or
   `am doctor` check that warns when the grace period has expired
   and `--finalize` has not been run. Requires storing
   `rotated_at` timestamp in `.am-secrets.toml` or a sidecar file.

2. **Race-condition detection.** Detect concurrent `am pair accept`
   on the config repo by checking if `recipients/` contains a
   `.pub` file without a corresponding rewrap commit. This is
   a heuristic and does not guarantee safety under all concurrent
   edit scenarios.

3. **Per-file rewrap progress tracking.** `am secrets status` should
   show how many envelopes are wrapped to each recipient, how many
   are dual-encrypted (during grace period), and when the grace
   window expires.

4. **`am secrets rotate --revoke <pub-fingerprint>`** as a combined
   rotate-and-revoke-other operation for the "lost laptop + rotate
   my own key" scenario.

5. **Shamir-split recovery integration.** During rotation, offer to
   generate new recovery shards for the new identity.

## 5. Test Strategy

### 5.1 Unit Tests (Backend)

```typescript
// 1. rotate() produces distinct identity
test("rotate generates new keypair distinct from current", async () => {
  const backend = new AgeSecretsBackend({ passphraseProvider });
  await backend.initialize();
  const oldRecipient = await backend.getRecipient();

  await backend.rotate("new-passphrase");

  const newRecipient = await backend.getRecipient();
  expect(newRecipient).not.toBe(oldRecipient);
});

// 2. Dual-encrypt makes value decryptable by both
test("dual-encrypted value decryptable by old and new identity", async () => {
  const backend = new AgeSecretsBackend({ passphraseProvider });
  await backend.initialize();
  const oldIdentity = backend.getIdentity();

  const envelope = await backend.encrypt("secret");
  await backend.rotate("new-passphrase");

  // New identity can decrypt
  expect(await backend.decrypt(envelope)).toBe("secret");

  // Old identity can ALSO decrypt (grace period)
  const oldBackend = new AgeSecretsBackend({
    passphraseProvider: () => Promise.resolve(oldPassphrase),
  });
  await oldBackend.initialize();
  expect(await oldBackend.decrypt(envelope)).toBe("secret");
});

// 3. After finalize, old identity cannot decrypt
test("finalize drops old identity access", async () => {
  // ... setup, rotate, finalize ...
  await backend.finalize();
  await expect(oldBackend.decrypt(envelope)).rejects.toThrow();
});
```

### 5.2 Integration Tests (CLI)

```bash
# E2E: fresh init → encrypt → rotate → finalize → verify
am init --backend age
echo 'secret = "enc:v2:age:...' > config.toml  # pre-encrypted
am secrets rotate --passphrase "new-pass" --keep-old
# Verify dual-encrypted: decrypt with BOTH identities
am secrets rotate --finalize
# Verify old identity fails
```

### 5.3 Grace-Period Regression Test

```bash
# With grace_period_days = 0 (immediate cutover)
am secrets rotate --passphrase "new-pass"
# Verify old identity CANNOT decrypt immediately
```

### 5.4 Concurrent-Edit Safety Test

```bash
# Simulate: user A runs `am secrets rotate`, user B runs `am pair finalize`
# Expected: second operation detects dirty state and aborts with message
```

## References

- ADR-0042 (Universal Secrets Strategy) — `ADRs/0042-universal-secrets-strategy.md`
- ADR-0047 (Cross-device Key Handoff) — `ADRs/0047-am-pair-cross-device-key-handoff.md`
- Current rotate implementation — `src/commands/secrets-rotate.ts`
- AgeSecretsBackend — `src/core/secrets-age.ts`
- Lens C (age SOTA) — `docs/research/2026-05-05-deep-loop/lens-age-sota.md`
- SOPS rotation guide — OneUptime blog, 2026-03-13, "How to Rotate SOPS Age Keys Without Re-Encrypting All Files in Flux"
- SOPS documentation — getsops.io/docs; getsops/sops GitHub
- agenix README — github.com/ryantm/agenix
- agenix DeepWiki — deepwiki.com search: "how does agenix handle key rotation"
- passage — sr.ht/~gpanders/passage
- age spec — age-encryption.org/v1
- Neil Madden on age — neilmadden.blog, 2019-12-30, "A few comments on 'age'"
- OWASP Password Storage Cheat Sheet — cheatsheetseries.owasp.org (2025)
- RFC 9106 (Argon2) — rfc-editor.org/rfc/rfc9106.html
