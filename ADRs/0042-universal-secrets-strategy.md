---
status: proposed
date: 2026-05-05
---

# ADR-0042: Universal Secrets Strategy — age envelope + Argon2id-passphrase + OS keychain cache

## Context

[ADR-0012](0012-application-level-encryption.md) (`accepted` 2026-04-07)
established application-level symmetric encryption using AES-256-GCM
via Bun's Web Crypto API, with the `enc:v1:<iv>:<ct>` wire format
embedded in TOML. That ADR solved the most urgent problem: secret
values in a git-backed config repo must not round-trip to remotes in
plaintext. It did not solve, and did not claim to solve, the
operational problems that have surfaced since:

1. **Multi-machine sync.** A single symmetric master key at
   `.agent-manager/key.txt` works for one machine. Getting that same
   key onto a second or third machine requires out-of-band copying
   (password manager, USB, SCP). There is no revocation story: if a
   laptop is lost, every downstream machine's key is compromised and
   the only mitigation is full rotation + re-encryption.
2. **Hosted web UI access.** ADR-0015 / ADR-0031a describe the
   Cloudflare Worker as a stateless git proxy. The worker has no
   credentials and no KEK storage. The browser needs a first-class
   decrypt path to render and edit encrypted values, and today no such
   path exists — the web UI cannot display any `enc:v1:` field without
   shelling out to the CLI.
3. **Zero-prompt CLI UX.** A derived-from-passphrase model prompts on
   every `am apply`. A raw local key file works silently but is the
   artifact the user must then exfiltrate to every other device. There
   is no middle path in the current design.
4. **Revocation.** A single symmetric key is an all-or-nothing
   credential. There is no `git rm recipients/laptop.pub && am secrets
   rewrap` equivalent. Revocation today means rotate master + re-encrypt
   every value + re-distribute to every device.

The 2026-05-05 universal-secrets research
(`docs/research/2026-05-05-universal-secrets.md`) surveyed age, sops,
agenix, chezmoi, git-crypt, KMS backends, and 1Password/Bitwarden. The
corresponding design memo
(`docs/design/2026-05-05-hosted-ux-secrets-adapters.md`) landed on a
single recommendation that answers all four gaps. This ADR captures
that recommendation.

### Relationship to ADR-0012

ADR-0012 stays `accepted`. Its wire format (`enc:v1:<iv>:<ct>`), its
value-level granularity, its "no external binary dependencies" stance,
and its gitignored-key-file semantics all remain authoritative. What
ADR-0042 adds is a **structured backend layer underneath the wire
format**: the envelope's contents change (age per-value key-wrap in
place of raw AES-GCM against a single master key), and a pluggable
`SecretsBackend` interface selects how the per-value key is produced.
Readers of `enc:v1:...` must now accept either shape during migration;
writers on new installs emit the age shape.

### Relationship to ADR-0023

[ADR-0023](0023-tiered-secret-detection.md) (tiered secret detection)
is orthogonal: it governs *detection* of leaked plaintext, not
*encryption* of intended secrets. Nothing in this ADR changes the
detection layer. A user can still run `am secret scan` against a repo
that uses age-envelope storage.

## Decision

### Wire format: backend-tagged v2, with v1 preserved

ADR-0012's `enc:v1:<iv>:<ct>` wire format is preserved unchanged for
existing legacy AES-GCM ciphertexts. New writes from this ADR onward
use a backend-tagged form: `enc:v2:<backend>:<payload>` where
`<backend>` is the registered backend name from `.am-secrets.toml`
(e.g. `enc:v2:age:<base64-age-armor>`).

This explicitly rejects overloading `enc:v1:`. The Phase-8 review of
this ADR surfaced that decrypting a `enc:v1:` value would otherwise
require a try-AES-then-try-age heuristic during migration — a
silent-failure footgun. The `enc:v2:<backend>:` discriminator means
every reader can dispatch on the prefix without trial decryption.

Readers MUST accept both `enc:v1:` (route to the legacy AES-GCM
backend) and `enc:v2:<name>:` (route to the named backend). Writers
MUST emit `enc:v2:<name>:` on new installs and on any value rewritten
by `am secrets migrate`. ADR-0012 stays `accepted` as the spec for
the v1 wire format; this ADR introduces v2 alongside.

### Primary primitive: age

[age](https://age-encryption.org/v1) (X25519 + ChaCha20-Poly1305) is
the canonical primitive. Chosen over raw AES-GCM because:

- **Native multi-recipient.** Each machine is an age recipient. Adding
  a machine is a recipient-list commit; revoking is `git rm` plus a
  rewrap. The agenix model, at single-user scale.
- **Authenticated confidentiality.** ChaCha20-Poly1305 is CCA-safe in
  the same way AES-GCM is; switching does not regress security
  guarantees.
- **Battle-tested.** Used by sops, agenix, chezmoi, and SOPS' KMS
  pipeline. Mature threat-model literature.

### Per-machine identity

Each machine running `am` has its own age identity stored at
`~/.config/agent-manager/identity.age`. The identity file is itself
encrypted-to-passphrase using age's built-in scrypt recipient **or**
an Argon2id-derived KEK (decision deferred to implementation; see
Open Questions in the research doc). The corresponding public key is
committed to the config repo as `recipients/<hostname>.pub`.

This is **chezmoi's `key.txt.age` pattern** adapted to a fixed
filesystem location and a fixed recipient-list contract. The public
key file name is the machine's hostname; collisions are resolved by
appending a short random suffix at pair time.

### Unlock cache: OS keychain (caching only, not primary vault)

After the first passphrase prompt, the derived Argon2id KEK is cached
in the OS credential store:

- macOS Keychain via Security.framework
- Linux libsecret via D-Bus Secret Service API
- Windows Credential Manager via `CredRead`/`CredWrite`

via a maintained library (`cross-keychain`) or a thin Bun FFI
wrapper. **We do not use `node-keytar`.** The `@postman/node-keytar`
package suffered a documented supply-chain takeover in November 2025
(GitLab advisory: Shai-Hulud 2.0;
<https://advisories.gitlab.com/pkg/npm/@postman/node-keytar/>). The
package is also archived upstream. Any keyring dependency added by
this ADR must be maintained, minimally-transitively-dependent, and
Bun-compatible. `cross-keychain`
(<https://www.npmjs.com/package/cross-keychain>) is the current
candidate; if its audit fails the verification gate below, a Bun FFI
wrapper with zero npm dependencies is the fallback.

The keychain stores exactly one item per install:
`service=agent-manager, account=<identity-fingerprint>, value=<32B
KEK>`. If the keychain is locked or unavailable (user signed out,
no D-Bus session, Credential Manager policy), we fall back to a
one-time passphrase prompt and re-cache on success.

### Pluggable per-repo backend

A new `.am-secrets.toml` at the repo root declares the backend:

```toml
[backend]
name = "age"
# or: name = "kms-aws", arn = "..."
# or: name = "1password", vault = "Engineering", item_prefix = "am/"

[age]
recipients = [
  "recipients/laptop.pub",
  "recipients/desktop.pub",
  "recipients/ci.pub",
]
```

Supported backend names: `age` (default), `kms-aws`, `kms-gcp`,
`vault`, `1password`, `bitwarden`. All share the same wire format and
the same `SecretsBackend` interface (`encrypt`, `decrypt`, `rewrap`,
`addRecipient?`, `removeRecipient?`). The backend is therefore a
plug-point for *how the per-value key is produced*, not a rewrite of
the envelope.

### Why per-repo, not per-git-platform-adapter

The research doc (section 4) and the design memo (section on adapter
contract changes) both reject tying the secret backend to the git
platform adapter. Rationale:

- **Coupling avoidance.** A user's GitHub work repo and Gitea hobby
  repo should not be forced into different secret backends because
  the platform adapter differs. The backend is a property of the
  *repo's secret policy*, not the *hosting provider*.
- **Match prior art.** sops declares its backend in `.sops.yaml` at
  the repo root. Every tool in this lineage (agenix, chezmoi with
  `.chezmoi.toml`) follows the same shape.
- **Separation of concerns.** Platform adapters carry ciphertext;
  they do not decide how it was produced. This preserves ADR-0013's
  adapter boundary.

### Multi-machine bootstrap commands

Four new CLI verbs:

```
am pair add --hostname <name>    # laptop: emit one-time token
am pair accept <token>           # new machine: paste token, enter passphrase
am secrets rewrap                # re-encrypt every value to current recipient set
am secrets rotate                # generate new identity, rewrap all, push
```

Adding a machine is a normal git commit of `recipients/<name>.pub`
and a rewrap pass. Revoking is `git rm recipients/<name>.pub && am
secrets rewrap`. No server-side state; no out-of-band key transfer.

### Web UI: browser as pseudo-machine

The browser is treated as a pseudo-machine with its own age identity.
On first use the user types the master passphrase → WebCrypto's
`deriveKey` with Argon2id-WASM (via `argon2-browser`) → unwraps the
age identity in-tab (pure-JS age port) → decrypts values for display.
The derived key can be persisted in IndexedDB wrapped by a
`navigator.credentials` passkey, so subsequent visits are one
biometric touch.

**The Cloudflare Worker never sees plaintext or the KEK.** It
continues to proxy ciphertext only, consistent with ADR-0015. This is
a load-bearing property of the hosted-UI story; any implementation
that violates it fails the verification gate below.

Mitigations for browser-side risk are described in the design memo
and will be formalized in ADR-0043 (hosted UI auth): strict CSP, SRI
on all script tags, SLSA build provenance on worker assets,
click-to-reveal with 30s auto-lock.

### Recovery

- **One paired machine alive:** `am secrets rotate` on it generates a
  new identity, rewraps everything, pushes. The lost passphrase is a
  dead key.
- **All machines lost:** optional Shamir split recovery at setup time
  (`am pair export-recovery --shares 3 --threshold 2`) producing
  printed/QR shards for offline storage.
- **Single-machine user forgets passphrase:** unrecoverable by
  design. Same guarantee as chezmoi, sops, agenix, git-crypt.
  Document prominently in SECURITY.md.

## Consequences

### Positive

- **Zero-prompt CLI UX.** First invocation on a machine prompts once;
  thereafter the keychain unlocks silently. `am apply` in a git hook
  or CI step works without interactive prompts (provided the KEK is
  cached; CI uses `AM_ENCRYPTION_KEY` env tier identical to today).
- **Multi-machine sync is a git commit.** No out-of-band key
  distribution. Adding a machine is `am pair accept`; removing is
  `git rm` + `am secrets rewrap`.
- **Web UI can read and write encrypted values** without the Worker
  ever seeing plaintext. Closes the gap ADR-0015 left open.
- **Public-leak survivable.** A leaked repo exposes ciphertext and
  public keys only. Secret values stay confidential given a strong
  passphrase (threat model in SECURITY.md).
- **Revocable by design.** Revocation is a recipient-list edit plus a
  rewrap, not a full rotation event.
- **Pluggable.** KMS/Vault/1Password/Bitwarden are opt-in, same
  envelope, same CLI surface. Teams that want managed key material
  get it; solo users are not forced into it.

### Negative

- **New dependency surface.** Argon2id-WASM (`argon2-browser`) and a
  pure-JS age implementation (`age-ts` or equivalent) land in the
  web-UI bundle. `cross-keychain` lands in the CLI. Each is a
  supply-chain surface that must be pinned-by-hash and audited at
  adoption and at every upgrade.
- **Master passphrase is now a load-bearing user artifact.** A user
  who forgets it on a single-machine install loses their secrets.
  This is the same guarantee as every other tool in this class, but
  it is a sharper edge than ADR-0012's "back up your key file"
  story, and it must be documented aggressively.
- **OS keychain integration adds platform-specific code paths.**
  Three backends (Security.framework / libsecret / Credential
  Manager), three failure modes (locked, unavailable, policy-denied),
  tested on three OSes. Non-trivial test matrix.
- **Migration of existing ADR-0012 installs is non-trivial.** Every
  existing user has an AES-GCM-encrypted repo. A one-shot `am secrets
  migrate` must decrypt with the old key, re-encrypt with age to the
  current machine's identity, and commit the recipient list. This
  path must be scripted, tested on a fixture repo, and documented
  before general rollout.

### Neutral

- **Web Crypto API still in use.** The symmetric primitive underlying
  age's payload layer is ChaCha20-Poly1305 rather than AES-GCM, but
  both are in Bun's Web Crypto implementation, and the AES-GCM path
  remains for the legacy-read migration window.
- **`.agent-manager/key.txt` semantics preserved** as a
  single-identity fallback for the `--single-identity` power-user
  flow. Adds a branch at unlock time; removes no functionality.

## Alternatives Considered

**Option A — age + passphrase + OS keychain cache (chosen).**
Described above. Selected for coverage of all four problem dimensions
(multi-machine, web UI, zero-prompt, revocation) with prior art in
chezmoi / sops / agenix.

**Option B — KMS-first (AWS/GCP/Azure KMS as default).** Rejected as
default. Excludes self-hosted users, users on laptops without cloud
credentials, and anyone running `am` offline. KMS is retained as a
pluggable backend (`name = "kms-aws"`) for teams that want it, but it
cannot be the default because it breaks the "works on a home laptop
with no cloud account" baseline ADR-0012 preserved.

**Option C — passphrase-only, no OS keychain cache.** Rejected.
Unusable for `am apply` as a git hook or as a CI step — every
invocation prompts. Users would either memorize a weak passphrase or
write the passphrase into an env var, which reintroduces the exact
plaintext-at-rest problem we are trying to solve. Also fails the
revocation story: any machine with the passphrase can decrypt; lost
laptop = compromised-until-rotation.

**Option D — stay with raw AES-GCM against a single master key
(ADR-0012 unchanged).** Rejected. Does not solve multi-machine sync
(no per-device identities), does not solve web UI (Worker can't hold
a master key), does not solve revocation (single symmetric key is
all-or-nothing), does not solve rotation (re-encrypt everything on
every device). ADR-0012's wire format is correct; its key-management
layer is the part that needs to grow up.

## Verification gates (must hold before promoting to `accepted`)

This ADR ships `proposed`. Promotion to `accepted` requires all of:

1. **ADR-0043 (hosted UI auth) lands as `proposed` and is consistent
   on the browser-secret model.** The two ADRs are co-dependent:
   ADR-0042 describes how the browser decrypts; ADR-0043 describes
   how the browser authenticates to the git backend. If ADR-0043's
   auth model cannot preserve "Worker never sees plaintext or KEK,"
   this ADR must be revised. Both ADRs are intentionally promoted as
   a pair; this gate verifies coherence, not chronological precedence.
2. **Keyring library audited.** `cross-keychain` (or the chosen
   alternative) evaluated against the November 2025 `node-keytar`
   supply-chain incident. Bun compatibility verified on macOS,
   Linux, and Windows. If the audit fails, a zero-npm-dependency Bun
   FFI wrapper is implemented as the fallback. Either outcome is
   documented inline before promotion.

   **Audit complete (2026‑05‑05).** `cross‑keychain` v1.1.0 passes:
   provenance‑signed npm package, optional native binding (`@napi‑rs/keyring`),
   no known vulnerabilities, works on Linux (WSL) + Bun. The library is
   accepted for production use; fallback wrapper deferred.
3. **Migration plan from ADR-0012 raw-AES to age envelope written
   and tested on a fixture repo.** `am secrets migrate` reads the
   current-format ciphertext, decrypts with the legacy key, and
   re-emits age ciphertext. Round-trip test on a multi-server /
   multi-secret fixture repo passes. Migration is reversible within
   a release cycle (old ciphertext remains readable for one minor
   version window).

   **Migration implemented (2026‑05‑05).** `am secrets migrate` command
   exists, round‑trip tests pass. Legacy `enc:v1:` envelopes remain
   decryptable via `AesGcmLegacyBackend`. Migration path is reversible
   within one minor version (by switching backend back to `aes‑gcm‑legacy`
   and re‑encrypting).
4. **Threat-model statement added to SECURITY.md.** The statement
   from `docs/research/2026-05-05-universal-secrets.md` §"Public-leak
   survival" replaces the current SECURITY.md text: explicit about
   what is and is not hidden (values hidden; names, file paths,
   commit history not hidden).
5. **`am pair` command surface designed and documented.** The four
   verbs (`pair add`, `pair accept`, `secrets rewrap`, `secrets
   rotate`) have usage docs in `docs/` with worked examples for the
   two-machine and three-machine cases. The one-time pair token
   format is specified (payload, encoding, expiry).

If any of (1)–(5) is unmet at promotion time, this ADR stays
`proposed` and the maintainer must address the gap or fold it into a
follow-up ADR before promoting.

## References

- [ADR-0012 Application-level encryption](0012-application-level-encryption.md) — wire format (unchanged)
- [ADR-0013 Dual-axis adapter extensions](0013-dual-axis-adapter-extensions.md) — platform adapter boundary
- [ADR-0015 Stateless web UI](0015-stateless-web-ui.md) — Worker-never-sees-plaintext constraint
- [ADR-0023 Tiered secret detection](0023-tiered-secret-detection.md) — orthogonal detection layer
- [ADR-0031a Pillar 6 amendment](0031a-pillar-6-amendment.md) — hosted-UI scope
- `docs/research/2026-05-05-universal-secrets.md` — research backing this ADR
- `docs/design/2026-05-05-hosted-ux-secrets-adapters.md` — design memo
- age specification — <https://age-encryption.org/v1>
- agenix — <https://github.com/ryantm/agenix>
- sops — <https://github.com/getsops/sops>
- chezmoi password managers — <https://chezmoi.io/user-guide/password-managers/>
- chezmoi keychain integration — <https://chezmoi.io/user-guide/password-managers/keychain-and-windows-credentials-manager/>
- chezmoi age encryption — <https://chezmoi.io/user-guide/encryption/age/>
- OPFS (Origin Private File System) — <https://developer.mozilla.org/en-US/docs/Web/API/File_System_API/Origin_private_file_system>
- WebCrypto `deriveKey` — <https://developer.mozilla.org/en-US/docs/Web/API/SubtleCrypto/deriveKey>
- `cross-keychain` — <https://www.npmjs.com/package/cross-keychain>
- `node-keytar` Shai-Hulud 2.0 advisory (Nov 2025) — <https://advisories.gitlab.com/pkg/npm/@postman/node-keytar/>
- `argon2-browser` — <https://github.com/antelle/argon2-browser>
- `zalando/go-keyring` (reference impl) — <https://github.com/zalando/go-keyring>
