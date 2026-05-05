# Universal secret-handling strategies for git-backed config repos

**Date:** 2026-05-05
**Context:** `am` stores AI tool configs (TOML) in a git repo at `~/.config/agent-manager/`. Secret values are wrapped `enc:v1:nonce:ciphertext` (AES-256-GCM, ADR-0012) with the master key outside the repo. This report surveys universal secret-handling strategies to answer four production questions: (1) multi-machine sync, (2) hosted web-UI access, (3) public-leak survival, (4) zero-prompt CLI UX.

## Comparison matrix

| Tool | Crypto | Multi-machine model | Browser / web-UI story | OS keystore | Public-leak safe | Verdict for am |
|---|---|---|---|---|---|---|
| **age** (X25519 + ChaCha20-Poly1305) [1] | Hybrid: per-recipient key-wrap of symmetric file key | Add each machine's public key as a recipient; private key never leaves machine | Not browser-native; WASM ports exist (e.g. `age-wasm`) | No, private key is a local file | Yes — ciphertext is CCA-safe for confidentiality [2] | ★ Strong primary primitive |
| **sops** (envelope over age/KMS/GPG/Vault) [3][4] | Per-value encryption, structure preserved | Multiple recipients in `.sops.yaml`; rotate by re-running `sops updatekeys` | CLI-only; no browser decrypt path | Delegates to backend | Yes (provided backend keys not leaked) | Good model; heavy for single-user |
| **agenix** (age + SSH host keys) [5] | age under the hood | Each host's SSH host key is a recipient; re-encrypt on host add/remove | None | No | Yes | Inspires the recipient model but NixOS-specific |
| **chezmoi** (pluggable: age/gpg/keyring/1P/BW/Vault/KMS) [6][7][8] | Delegated | Options: (a) copy age key to each machine via password manager or encrypted-to-passphrase `key.txt.age`; (b) passphrase mode with prompt every op | None built-in; template functions pull from PM at apply time | Yes, via `zalando/go-keyring` [8] | Yes | **Closest analog; best prior art** |
| **git-crypt** [9] | AES-CTR filter on checkout, GPG-wrapped symmetric key | Add each user's GPG key with `git-crypt add-gpg-user`; no revocation [9] | None | Relies on GPG agent | Yes, but with caveats: filenames leak, no forward secrecy, revocation impossible | Fine for teams; poor for rotation |
| **dotenv / direnv .envrc.gpg** | plain / GPG | Out-of-band | None | GPG agent | `.envrc.gpg` yes; plain `.env` NO | Not recommended |
| **HashiCorp Vault / AWS/GCP/Azure KMS** | Managed KMS | Auth per-machine (OIDC, workload identity) | Yes via API if service is reachable | No | Yes (ciphertext meaningless without KMS grants) | Overkill for solo; useful as a backend |
| **1Password / Bitwarden secret mgmt** | Vendor-managed | SSO / account sync handles it | Yes (vendor web app) | Integrates with OS keychain | Yes | Great optional backend |
| **OS credential store direct** (Keychain / libsecret / Win CredMan) [10][11] | OS-managed | **Per-machine only, never travels with repo** | No | Native | N/A | Perfect *unlock cache*, not the primary vault |

## Recommended strategy for am (and why)

**Primary: age public-key envelope, passphrase-unlocked identity, cached in OS keychain.** Adopt age as the canonical primitive for the value-level wrapper, reusing the `enc:v1:` wire format. Every machine `am` runs on gets its own age identity. The repo carries `recipients/<host>.pub` (git-tracked) so every value is encrypted to the full set of paired devices — agenix/sops model [5][3] adapted to single-user. The private identity on each machine is stored **encrypted with an Argon2id-derived key from the user's master passphrase** (chezmoi's `key.txt.age` pattern [6]). After first unlock, the derived KEK goes into the OS credential store via a Bun-friendly keyring binding (macOS Keychain, libsecret on Linux, Credential Manager on Windows) [8][10][11]. Net: one passphrase typed once per machine, zero prompts thereafter.

**Pluggable per-adapter overrides.** Platform adapters (GitHub, GitLab, bare-git — ADR-0013) expose an optional `secretsBackend`. Default is age+passphrase everywhere; on GitHub orgs with OIDC→KMS wiring, users can swap to KMS for team use (sops-style pointer in `.am-secrets.toml`) [4]. Shim backends (`vault`, `1password`, `bitwarden`) implement the same `encrypt(plaintext)→enc:v1:...` / `decrypt(blob)→plaintext` interface — chezmoi's exact design [7]. One canonical envelope, many ways to produce the key.

**OS credential store.** Bun is N-API compatible so `node-keytar` works, but it is stale and had a 2025 supply-chain incident [12]; prefer a maintained alternative like `cross-keychain` [11] or a thin Bun FFI wrapper over native APIs. The keyring stores exactly one item per install: `service="agent-manager", account=<identity-fingerprint>, value=<32B KEK>`.

## Concrete UX for am

### First-time setup
```
$ am init
? Choose a master passphrase: ********
? Confirm:                    ********
 ✓ Generated age identity (age1qv...)
 ✓ Encrypted identity stored at ~/.config/agent-manager/identity.age
 ✓ Public key added to repo as recipients/laptop.pub
 ✓ Cached derived key in macOS Keychain (service=agent-manager)
```
Passphrase → Argon2id(salt, t=3, m=64MiB, p=1) → 32-byte KEK → AES-GCM-wraps the age X25519 private key. Salt + wrapped key live at `~/.config/agent-manager/identity.age` (encrypted-to-passphrase age file, same shape as chezmoi's `key.txt.age` [6]). Public key is added to repo as `recipients/<hostname>.pub` and auto-committed (ADR-0002).

### Day-to-day CLI (no prompts)
`am apply`, `am mcp add`, etc., open the keychain via `cross-keychain get agent-manager <fingerprint>` [11], get the KEK, unwrap the age identity in-memory, decrypt every `enc:v1:...` value encountered. Zero prompts. If the keychain is locked (macOS user signed out, Linux session bus unavailable) we fall back to a one-time passphrase prompt and re-cache.

### Multi-machine bootstrap
```
# Laptop already set up
$ am pair add --hostname desktop
 ✓ Paste this on the new machine:
   am pair accept eyJwYXNzcGhyYXNlSGludCI6Li4ufQ==  # one-time token with repo URL

# Desktop
$ am pair accept eyJwYXNz...
? Enter master passphrase: ********     # same one the user always uses
 ✓ Cloned config repo
 ✓ Generated age identity for 'desktop'
 ✓ Public key pushed to recipients/desktop.pub
 ✓ Ran `am secrets rewrap`  (laptop re-encrypted every secret to both recipients)
```
This is the agenix recipient-list pattern [5]. Adding a machine is a regular git commit; any machine that has *its* identity can re-wrap secrets to the expanded recipient set. Three safer failure modes than "copy the key": (a) if the passphrase is the same, the new machine could unlock the shared identity directly — cleaner UX but single-key compromise; (b) chosen design above keeps per-machine identities so revocation is `git rm recipients/desktop.pub && am secrets rotate`; (c) for users who refuse a second prompt, a `--single-identity` mode mirrors chezmoi's "just copy key.txt" workflow [6].

### Web UI (local and hosted)
**Local (`am serve`):** Shares the CLI's decrypt path via the same `core/secrets.ts` module — the Hono server already has process access to the keychain. No new surface.

**Hosted Cloudflare Worker (ADR-0015 stateless UI):** The browser is *itself* a pseudo-machine. On first use the user types the master passphrase → WebCrypto's `deriveKey` with PBKDF2 or Argon2id-WASM [13][14] → unwraps the age identity (pure-JS age port, e.g. `age-ts`) in the tab → decrypts values. The derived key can be persisted in IndexedDB wrapped by a `navigator.credentials` passkey so subsequent visits are one biometric touch. Risks:
- **XSS** — a compromised static bundle exfiltrates the passphrase. Mitigate with strict CSP, SRI on all `<script>`, and public build provenance (SLSA attestation on worker assets).
- **Supply chain** — sign releases; pin by hash in the worker route.
- **Screenshots / shoulder-surfing** — standard risk; show values behind click-to-reveal with auto-lock.
- **The worker never sees plaintext or the KEK.** It only proxies git. Ciphertext-only on the wire satisfies ADR-0015's "stateless worker" rule.

### Recovery / lost passphrase
- **Another paired machine alive:** `am secrets rotate` on that machine generates a new identity, rewraps everything, pushes. The lost passphrase is a dead key.
- **All machines lost:** Offer optional **Shamir split recovery** (`am pair export-recovery --shares 3 --threshold 2`) producing printed/QR shards for offline storage, OR a single written-down backup passphrase. No third-party escrow is implied by the default design.
- **Passphrase forgotten on one machine but repo intact:** same as "another machine alive" — rotate from a working one. If *only* one machine exists and passphrase is lost, secrets are unrecoverable *by design*. This is the same guarantee chezmoi, sops, git-crypt, agenix all make [4][5][9].

## Public-leak survival — threat-model statement

If the repo is pushed public (or the git host is breached), an attacker obtains:

1. Ciphertext of every secret — age X25519 + ChaCha20-Poly1305 in counter mode; no practical attack [1][2].
2. `identity.age` — passphrase-encrypted via age's scrypt recipient (work factor 18 by default). A weak passphrase is crackable; Argon2id at m=64 MiB raises cost ~100× vs. scrypt-18. Document a **12-word or 14-char min** policy.
3. `recipients/*.pub` — public keys only, designed to be public.
4. Metadata: field names, file paths, commit history — **not encrypted** (same as sops/age). Users needing to hide *which keys exist* should use git-crypt's whole-file mode instead, at the cost of web-UI access [9].

Statement we should publish: *"A public leak of your `agent-manager` repo exposes no secret values to an attacker who does not also know your master passphrase. Secret names and structural metadata are not hidden. Rotate immediately on leak."*

## Open questions

1. **Default KDF for wrapping the age identity:** Argon2id (our own, via `argon2-browser` WASM for parity with worker) or reuse age's built-in scrypt? Argon2id is stronger against GPU crackers; scrypt is one less dependency.
2. **Per-machine identities vs. single shared identity:** single is simpler (copy one file, no recipient list churn); per-machine is revocable. Default to per-machine; expose `--single-identity` for power users. Decide.
3. **Native crypto vs. Bun-compatible pure-JS age:** The CLI can shell out to `age` binary if present (chezmoi's pattern — if `age` is in `$PATH` use it, else built-in [6]); the worker *must* use the JS implementation. Maintain our own Bun wrapper or depend on `age-ts`?
4. **Keyring library:** `cross-keychain` [11] vs. writing a thin Bun FFI wrapper. The npm ecosystem keyring story is fragile after the 2025 Shai-Hulud incident [12]; an FFI wrapper with no transitive deps is safer.
5. **Rotation cadence:** opportunistic on `am secrets rotate`, or enforced TTL? Chezmoi punts; sops has `--rotate`. Recommend: manual now, scheduled reminder later.
6. **Value-level vs. file-level encryption:** `am` already does value-level (`enc:v1:...` per field). Keep it — it's the same choice sops made [3] and enables granular diffs. File-level (git-crypt) blocks the diff-based review UX.
7. **Web UI secret-editing UX:** allow editing of encrypted values in the browser (re-encrypt to all recipients on save) vs. read-only with a "copy to clipboard, edit in CLI" fallback? Editing is strictly better but doubles the JS-crypto surface.

## Sources

1. age specification — <https://age-encryption.org/v1> — X25519 + ChaCha20-Poly1305 spec; defines recipient / identity model.
2. Valsorda, "age and Authenticated Encryption" — <https://words.filippo.io/age-authentication/> — what age does and does not guarantee about authentication vs. confidentiality.
3. getsops/sops README — <https://github.com/getsops/sops> — per-value encryption, multi-backend (KMS/age/GPG/Vault).
4. GitGuardian, "Comprehensive Guide to SOPS" (2025) — <https://blog.gitguardian.com/a-comprehensive-guide-to-sops/> — multi-backend deployment patterns, GitHub Actions integration.
5. ryantm/agenix README — <https://github.com/ryantm/agenix> — host-SSH-key-as-recipient model for NixOS; `secrets.nix` recipient list.
6. chezmoi docs, "Encryption — age" — <https://chezmoi.io/user-guide/encryption/age/> and "FAQ: encrypt private key with passphrase" — <https://chezmoi.io/user-guide/frequently-asked-questions/encryption/> — passphrase-wrapped `key.txt.age` pattern, built-in vs. external age.
7. chezmoi docs, "Password Manager Integration" — <https://chezmoi.io/user-guide/password-managers/> — pluggable backend surface we are mirroring.
8. chezmoi docs, "Keychain and Windows Credentials Manager" — <https://chezmoi.io/user-guide/password-managers/keychain-and-windows-credentials-manager/> — uses `zalando/go-keyring` for cross-platform OS credential access.
9. AGWA/git-crypt README — <https://github.com/AGWA/git-crypt/blob/master/README.md> — transparent filter model; explicitly no revocation; filename leakage.
10. zalando/go-keyring — <https://github.com/zalando/go-keyring> — reference cross-platform Keychain/Secret Service/CredMan library (Go).
11. `cross-keychain` npm — <https://www.npmjs.com/package/cross-keychain> — maintained Node/Bun cross-platform credential store; macOS Security.framework bindings, CLI fallback.
12. GitLab Advisory, "@postman/node-keytar — Shai-Hulud 2.0 takeover" (Nov 2025) — <https://advisories.gitlab.com/pkg/npm/@postman/node-keytar/> — supply-chain risk context for picking a keyring lib.
13. MDN, `SubtleCrypto.deriveKey()` — <https://developer.mozilla.org/en-US/docs/Web/API/SubtleCrypto/deriveKey> — browser passphrase→AES-GCM-key derivation for the web-UI decrypt path.
14. Node.js Web Crypto API — <https://nodejs.org/api/webcrypto.html> — Bun-compatible subset used by `am`'s existing AES-256-GCM path.
