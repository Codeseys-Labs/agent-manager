---
status: accepted
date: 2026-05-05
accepted: 2026-05-05
amends: ADR-0042
---

# ADR-0051: Secrets Rotation + Grace Period (Synthesizes Lens I)

## Context

[ADR-0042](0042-universal-secrets-strategy.md) (Universal Secrets Strategy)
sketched `am secrets rotate` as "generate new identity, rewrap all, push" but
did not specify the full flow. The current implementation in
`src/commands/secrets-rotate.ts` is a misnamed `rewrap` — it rewraps all age
envelopes to the current recipient set without generating a new identity. True
rotation (generate-new-identity, dual-encrypt-during-grace, drop-old) was
missing entirely.

The 2026-05-05 Lens I design research
(`docs/research/2026-05-05-deep-loop/lens-I-secrets-rotation.md`, 504 lines)
surveyed prior art (SOPS two-phase grace period, agenix atomic cutover,
passage/pass manual rotation), analysed age's cryptographic guarantees
(X25519 static recipients = no forward secrecy), recommended a four-verb CLI
surface, and specified the grace-period mechanics. This ADR ratifies those
recommendations.

ADR-0042 gate 5 (rotation command surface) was partially closed by
[ADR-0047](0047-am-pair-cross-device-key-handoff.md) for the *pairing* verbs
(`pair accept`, `pair finalize`). The *rotation* verbs (`secrets rotate`,
grace period, revoke) remained unspecified until now. This ADR closes that
gap.

### Relationship to ADR-0046

[ADR-0046](0046-reject-team-passphrase-schema.md) rejected shared team
passphrases in favour of per-recipient X25519 identities. Rotation under this
ADR operates on per-machine identities, consistent with that posture. When a
team member leaves, `am secrets revoke <fingerprint>` removes their recipient
and rewraps — no passphrase change propagation required.

### Relationship to ADR-0047

ADR-0047's `am pair accept` and `am pair finalize` are recipient *addition*
verbs. The verbs in this ADR are recipient *lifecycle* verbs: rotate your own
identity, revoke someone else's, rewraps to maintain consistency. Together
they form a complete recipient management surface: add (pair), rewrap (sync),
rotate (replace self), revoke (remove other).

### Current implementation status

`src/commands/secrets-rotate.ts` (237 lines) currently:

- Accepts `--dry-run`, `--file`, `--no-backup`, `--json`, `--quiet`, `--verbose`.
- Walks `enc:v2:age:...` envelopes in TOML config files.
- Calls `AgeSecretsBackend.rewrap()` on each.
- Does NOT generate a new identity.
- Does NOT support grace-period dual-encryption.
- Does NOT have a `--finalize` flag.
- Does NOT have a `revoke` subcommand.

The command is semantically identical to what `am secrets rewrap` should be.
The implementation must be restructured per the Decision section below.

## Decision

### Four-verb CLI surface

Split the current monolithic `secrets rotate` into four distinct verbs:

| Verb | Action | Identity? | Recipient list? |
|------|--------|-----------|-----------------|
| `am secrets rewrap` | Re-encrypt all envelopes to current recipient set | Unchanged | Unchanged |
| `am secrets rotate` | Generate new identity, dual-encrypt grace window | NEW | Adds new recipient |
| `am secrets rotate --finalize` | Drop old identity at grace expiry | Drops old | Drops old recipient |
| `am secrets revoke <fingerprint>` | Remove a specific recipient + rewrap | Unchanged | Drops one |

Each verb supports `--dry-run` (report planned changes, no writes) and
`--json` (machine-readable output). Verb semantics:

**`am secrets rewrap`** — Rewraps every `enc:v2:age:…` envelope to the
current `[age].recipients` set from `.am-secrets.toml`, using the local
identity for decryption. This is the verb that `am pair finalize` calls
internally. It does not touch the local identity file. Use after editing the
recipient list (adding or removing `.pub` files).

**`am secrets rotate`** — Generates a new age X25519 identity, saves the old
identity as `identities/identity.age.old`, prompts for a NEW passphrase (the
old passphrase may be compromised — that is the motivation for rotation),
and rewraps every envelope to BOTH old and new recipients plus any peer
recipients. The old identity can still decrypt during the grace period.

**`am secrets rotate --finalize`** — Drops the old identity: re-encrypts
every envelope to the new-only recipient set (excluding the old recipient),
deletes `identities/identity.age.old`, and commits. After this, the old
identity holder cannot decrypt. Requires the old identity file to exist.

**`am secrets revoke <fingerprint>`** — Removes a specific recipient from
`recipients/<id>.pub`, deletes its entry from `.am-secrets.toml`, and
rewraps all envelopes to exclude that recipient. A thin convenience wrapper
over `git rm recipients/<id>.pub && am secrets rewrap`.

### Grace-period configuration

Grace-period default: **14 days**. Configurable via:

```toml
[settings.secrets.rotation]
grace_period_days = 14   # default; set to 0 for immediate cutover
```

A value of `0` causes `am secrets rotate` to skip dual-encryption entirely
and proceed directly to single-recipient new-key encryption — immediate
cutover, equivalent to agenix's `--rekey` semantics.

The 14-day default is chosen as a balance: long enough for distributed teams
across time zones to pull, verify, and confirm the new identity works on all
devices before finalizing; short enough to limit the attack window where
a compromised old identity can still decrypt production secrets.

During the grace period, the commit message for rotation includes the expiry
date:

```
am: rotate identity for <hostname> (grace period until 2026-05-19)
```

### No forward secrecy — documented explicitly

age envelopes using static X25519 recipients provide **no forward secrecy**.
If an attacker obtains the old identity key (via passphrase compromise or
filesystem access) AND has historical ciphertexts, they can decrypt every
past envelope that includes the old recipient in its header stanzas. This is
by design in the age specification (v1) and is shared by every tool in this
class: SOPS, agenix, git-crypt, and PGP-based encryption.

Rotation protects **future** confidentiality: after `--finalize`, new
ciphertexts are opaque to the old identity. Historical ciphertexts that were
not independently re-encrypted to exclude the old recipient remain
decryptable. The only complete mitigation after a confirmed key compromise is
to rotate the secret *values* themselves (change the passwords, rotate the
API keys), not just the encryption layer.

This limitation is documented in SECURITY.md §2 (Cryptographic Posture) per
the Verification gates below.

### Commit and push contract

All rotation verbs operate on the config repo. They require a clean working
tree (no uncommitted changes) and no pending `am pair accept` operations
detected on the repo. Each verb commits its changes as a single atomic commit
and pushes. The commit message identifies the verb, the affected recipient,
and (for rotate) the grace-period expiry.

### Dry-run and JSON output

`--dry-run` reports planned changes without modifying files. `--json`
produces machine-readable output. Example JSON output for `am secrets rotate
--json`:

```json
{
  "action": "rotate",
  "phase": "dual-encrypt",
  "old_recipient": "age1f4w...",
  "new_recipient": "age1abc...",
  "grace_period_until": "2026-05-19T00:00:00Z",
  "files": 23,
  "envelopes": 147
}
```

## Rationale

### Why four verbs instead of one

Overloading `rotate` to mean "rewrap", "rotate", "finalize", and "revoke"
creates ambiguity that leads to operational errors. A user who wants to sync
recipients after adding a new team member should not have to wonder whether
the command will also replace their own identity. Each verb does exactly one
thing, named precisely:

- **rewrap**: sync envelopes to recipients (no identity change).
- **rotate**: replace my identity (with grace period).
- **rotate --finalize**: commit to the new identity (drop old).
- **revoke**: remove someone else.

This follows the `am pair` precedent from ADR-0047, which split pairing into
`accept` (publish `.pub`) and `finalize` (rewrap to include it).

### Why a grace period (vs. immediate cutover)

agenix's immediate cutover (`--rekey`) is safe for NixOS deployments where
`nixos-rebuild switch` atomically updates every machine. agent-manager
deployments are not atomic: machines pull the config repo at different times,
some may be offline during rotation, and the operator needs time to verify
that the new identity decrypts correctly on all paired devices.

A grace period gives every paired device a window to pull the dual-encrypted
ciphertexts and confirm they can decrypt with either identity. If the
rotation is erroneous (wrong passphrase, corrupted identity file), the old
identity still works, and the operator can abort without data loss.

### Why default 14 days

- **7 days** (Lens I's original recommendation, matching SOPS convention) is
  too short for teams with members on vacation, devices in storage, or
  distributed teams with infrequent sync cycles.
- **30 days** is too long — it extends the dual-compromise window (old +
  new identity both valid) far beyond what is necessary for operational
  safety.
- **14 days** (~2 business weeks) covers a full sprint cycle, ensures
  at least one weekday overlap for every team member, and limits the attack
  window to an acceptable duration.

Users who prefer immediate cutover set `grace_period_days = 0`. Users who
need longer can set it higher. The default is a sensible middle for the
target audience (1-10 person teams with mixed online/offline devices).

## Trade-offs

### Grace-period adds ciphertext bloat

During the grace window, every age envelope contains an additional recipient
stanza for the old identity. Each stanza is ~200 bytes (encrypted file key +
recipient identifier). For repos with hundreds of envelopes, this is
negligible. For repos with tens of thousands, the bloat is measurable but
temporary (resolved at `--finalize`). The dual-encrypted state is always
transient; it should never persist beyond the configured grace period.

### Concurrent rotation + pair-finalize = race condition

If operator A runs `am secrets rotate` while operator B runs `am pair
finalize` on the same repo, the second operation to push will be rejected by
the remote (non-fast-forward). This is a workflow discipline issue, not a
tool-enforced lock. Documented mitigation: do not run rotation and
pair-finalize concurrently. SOPS and agenix have the same limitation; no
tool in this class implements distributed locking.

### Forward secrecy NOT provided

As detailed in the Decision section, age's static X25519 recipient model
means past ciphertexts remain decryptable by a compromised old identity.
This is an inherent property of the algorithm and is explicitly documented.

### New passphrase is a load-bearing user artifact

`am secrets rotate` prompts for a *new* passphrase. If the user forgets this
new passphrase before `--finalize`, and the old identity is still functional,
they can revert by deleting the new identity and staying on the old one. If
the user forgets it after `--finalize` (old identity deleted), the secrets
are unrecoverable — the same guarantee as losing the master passphrase on a
single-machine install (ADR-0042 §"Recovery"). This must be documented
aggressively in the rotate confirmation prompt.

### Identities directory adds filesystem surface

Storing `identities/identity.age.old` creates a second passphrase-protected
credential file on disk. If the user's passphrase hygiene is poor (same
passphrase for old and new identity), this adds no new risk. If the
passphrases differ, the old identity file is an additional brute-force
target. This is acceptable because the old identity is deleted at
`--finalize`, and the file's lifetime is bounded by `grace_period_days`.

## Implementation phases

### Phase 1 (this PR)

Fix `am secrets rotate` to generate a new identity and add the remaining
verbs:

1. **`secrets rotate`**: Generate new age identity via `generateIdentity()`,
   prompt for new passphrase, save old identity to
   `identities/identity.age.old`, dual-encrypt all envelopes to old+new
   recipients, commit with grace-period expiry date.
2. **`secrets revoke <fingerprint>`**: Remove recipient `.pub` file, remove
   from `.am-secrets.toml`, rewrap all envelopes to exclude it, commit.
3. **`secrets rewrap`**: Extract from current `rotate` implementation; pure
   rewrap-to-current-recipients, no identity change.
4. **Config**: Add `settings.secrets.rotation.grace_period_days` to
   `.am-secrets.toml` schema with default 14.
5. **Flags**: `--dry-run` and `--json` on all three verbs.
6. **SECURITY.md**: Add forward-secrecy limitation to §2 Cryptographic
   Posture.

Update `src/commands/secrets-rotate.ts` accordingly. The current file becomes
the `rewrap` command; `rotate` and `revoke` gain distinct implementations.

### Phase 2

`--finalize` automation (cron-style):

- `am secrets rotate --finalize` checks the grace window (compares current
  date against `rotated_at` timestamp stored in `.am-secrets.toml` or a
  sidecar metadata file).
- `am doctor` warns when the grace period has expired and `--finalize` has
  not been run.
- `pre-commit` hook option: refuse commits if grace period expired and old
  identity still present.

### Phase 3

Signed identity rotation: cryptographically attest that the new public key
was created by an authorized device. The new identity's `.pub` file is
accompanied by a `recipients/<hostname>.pub.sig` detached signature, signed
by the old identity. At `--finalize` time, the signature is verified before
dropping the old identity. This prevents an attacker with push access from
substituting their own public key during rotation.

## Verification gates

Phase 1 closes when all of the following hold:

| # | Gate | Test |
|---|------|------|
| 1 | `am secrets rotate` generates a NEW `identity.age` AND adds new recipient AND rewraps all envelopes to BOTH old and new recipient. | Encrypt with v1 identity, run rotate, decrypt with v2 identity succeeds. |
| 2 | Old identity still decrypts during grace period. | Encrypt with v1, run rotate, decrypt with v1 STILL succeeds. |
| 3 | `am secrets rotate --finalize` drops old identity access. | Encrypt with v1, run rotate, run --finalize, decrypt with v1 FAILS. |
| 4 | `am secrets revoke <fingerprint>` removes recipient and rewraps; decryption with revoked identity fails. | Add a peer recipient, encrypt, run revoke, peer decrypt fails. |
| 5 | `am secrets rewrap` rewraps all envelopes to current recipient set without changing local identity. | Add a peer `.pub`, run rewrap, peer can decrypt. |
| 6 | `settings.secrets.rotation.grace_period_days` honoured; `0` = immediate cutover. | Set to 0, rotate, old identity fails immediately. |
| 7 | `--dry-run` reports planned changes; `--json` outputs machine-readable format. | Run each verb with --dry-run and --json; verify output format. |
| 8 | SECURITY.md §2 (Cryptographic Posture) gains: "Forward secrecy: NOT provided. Static X25519 recipients mean past ciphertext is compromised if a future identity leaks." | Visual review of SECURITY.md. |

## Cross-references

- [ADR-0042 Universal Secrets Strategy](0042-universal-secrets-strategy.md) — parent ADR, per-machine age identity, recipient model
- [ADR-0046 Reject Team Passphrase Schema](0046-reject-team-passphrase-schema.md) — per-recipient identity enforcement
- [ADR-0047 am pair Cross-Device Key Handoff](0047-am-pair-cross-device-key-handoff.md) — recipient addition verbs (pair accept / finalize)
- Lens I design research: `docs/research/2026-05-05-deep-loop/lens-I-secrets-rotation.md`
- Current rotate implementation: `src/commands/secrets-rotate.ts`
- AgeSecretsBackend: `src/core/secrets-age.ts`
- age specification v1: <https://age-encryption.org/v1>
- SOPS rotation: getsops/sops GitHub; OneUptime blog (2026-03-13) on two-phase grace period
- agenix rekey: <https://github.com/ryantm/agenix>


---

## Amendment: 2026-05-05 — Safe finalize ordering

**Issue.** The original Phase-1 spec described `finalizeRotation()` as
a single atomic operation that drops the OLD recipient sidecar +
archived identity + state file. The CLI was expected to call rewrap
AFTER finalize. Phase-8 cross-family review (gpt-5.5 must-fix #1)
flagged that this ordering loses the OLD identity before rewrap
completes — if rewrap encounters a corrupt or undecryptable envelope,
the operator is left with envelopes encrypted to a recipient whose
identity has already been deleted, with no recovery path.

**Fix.** `finalizeRotation()` is split into two cooperating verbs:

1. `finalizeRotationPrepare()` — reads + validates the rotation-state
   sidecar, returns it. Does NOT delete anything. Throws if no rotation
   in progress. Runs the grace-period elapsed check.
2. `finalizeRotationCommit()` — drops the OLD recipient sidecar +
   archive + state file + clears the in-memory legacy-identity list.
   Caller must guarantee rewrap-to-new-only completed successfully
   FIRST.

**New CLI flow (`runFinalize` in `src/commands/secrets-rotate.ts`):**

```
1. backend.finalizeRotationPrepare()  → validates + returns state
2. drop OLD recipient sidecar from recipients/ (so encrypt targets new only)
3. rewrapMany() to re-encrypt all envelopes to NEW-only
4. if rewrap reports any failure → RESTORE sidecar from state.old_recipient + exit non-zero
5. only on full success: backend.finalizeRotationCommit() — delete archive + state
```

**Backward-compat.** `finalizeRotation()` is preserved as a deprecated
wrapper that calls `prepare()` then `commit()` directly (without the
intermediate rewrap). Existing callers and tests continue to work.

**New tests** (in `test/commands/secrets-rotate.test.ts`):

- `safe-ordering: rewrap failure on a corrupted envelope restores the
  OLD recipient sidecar AND keeps the archive on disk`
- `safe-ordering: full rewrap success commits — sidecar, archive, and
  state file are all removed`

Both pass alongside the original 9 Phase-1 verification gate tests
(11/11 total in this file as of Run K).

## Amendment: 2026-05-05 — readRotationState fail-closed

**Issue.** `readRotationState()` originally returned `null` on JSON
parse error or missing fields. A corrupt state file silently looked
like "no rotation in progress", letting a second rotation start over a
partial one and compounding damage.

**Fix.** Three-case behavior:

- file does not exist → return `null` (no rotation in progress)
- file exists, valid JSON, all required fields, recipients shaped
  `age1...` → return `RotationState`
- file exists, parse error OR missing required field OR malformed
  recipient → throw `Error` with the path + parse-error detail +
  remediation hint ("Remove the file manually if you are sure no
  rotation is in progress")

3 new tests in `test/core/secrets-age.test.ts` cover all three cases.


## Amendment: 2026-05-05 — Finalize-restore recovery hint

**Issue.** The Run K finalize-ordering safety patch (commit `aaefa09`)
made `runFinalize()` call `restoreOldRecipient(state)` on rewrap
failure. But `restoreOldRecipient()` itself can fail (disk full,
permission errors, pre-existing file collision). Without an inner
guard, the operator sees only the outer rewrap-failure error and
has no signpost to manual recovery.

**Fix.** Run L commit `7944670` wraps the `restoreOldRecipient()`
call in try/catch. On failure, an additional WARN is emitted before
the original error propagates:

```
WARN: failed to restore OLD recipient sidecar (<reason>).
Manual recovery: run 'age-keygen -y identity.age.old > recipients/_rotation-old.pub'
to reconstruct it.
```

The outer rewrap-failure error still propagates after the warning,
so exit code is non-zero and the operator's CI / scripts get the
correct signal.

This closes deepseek's Phase-8 must-fix #2 from Run J review.

**No test added.** The failure mode is hard to inject deterministically
in a unit test (would need filesystem permission manipulation that
behaves differently across CI runners). The pattern is conservative:
log + propagate. If the hint proves useful in production, a future
amendment can revisit and add an integration test that injects a
read-only `recipients/` directory.
