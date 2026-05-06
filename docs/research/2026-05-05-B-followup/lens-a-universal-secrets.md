[reviewer: openai/gpt-5.5]

# Lens A: Universal Secrets at Rest Against Public-Leak Attack, With Browser/CLI UX Preservation

## Executive summary

For `agent-manager` (`am`), the public-leak problem is not just “some TOML was accidentally pushed.” The realistic failure mode is that the entire git-backed configuration history, including deleted files, old encrypted envelopes, metadata, recipient lists, and possibly multiple prior KDF parameter choices, becomes available to fast offline attackers forever. The strongest usable defense is therefore not post-leak cleanup; it is ensuring that every secret committed to the repo is already protected by a durable client-side envelope whose plaintext key material never reaches GitHub, Cloudflare Workers, or logs.

The best fit with existing shipped decisions (ADR-0042: age + scrypt passphrase + OS keychain cache, with `AgeSecretsBackend` in `src/core/secrets-age.ts`) is a layered model:

1. Treat the repo as always-public and append-only.
2. Keep age-compatible encrypted values in TOML as the committed representation.
3. Keep plaintext and KEKs strictly client-side: CLI process memory, OS keychain, browser WebCrypto/OPFS/IndexedDB, or user-entered passphrase.
4. Use a per-repo high-entropy age identity or data-key hierarchy wrapped by passphrase-derived KEK and, where available, hardware/passkey-derived KEKs.
5. Preserve CLI usability with OS-keychain caching and explicit lock/logout controls.
6. Preserve hosted browser usability by making the Worker a static/app/data relay only; browser-side code must obtain or derive the age identity locally from passphrase import, CLI pairing, local browser storage, or WebAuthn PRF/passkey wrapping.
7. Add public-leak detection, plaintext-secret scanning, recipient drift checks, and rewrap tooling, but do not rely on history rewriting as a security boundary.

The key design choice is to separate “encryption for storage in git” from “authentication to the hosted UI.” Login to `am.example.com` can identify the user and authorize repo access, but it must not unlock secrets unless the browser locally obtains a decryption capability. If a fresh tab can view secrets without a local passphrase, passkey, imported identity, or previously stored non-extractable key, then the Worker or backend must have the secret, violating the zero-knowledge constraint.

## 1. Threat model precision: what “leaked repo” means

### A. Accidental public push

Definition: a user pushes a private config repo to a public GitHub remote, changes repository visibility, mirrors to a public remote, or includes the config directory in another public project.

Attacker capabilities:
- Clone the current default branch and inspect all files.
- Run GitHub search/secret scanning or custom regexes over the repository.
- Download obvious encrypted blobs and metadata for offline cracking.
- Potentially see commit history, tags, releases, pull requests, and cached rendered views.

Defenses that matter:
- All secrets must already be encrypted before commit. Preventive encryption is the only robust protection.
- KDF parameters on passphrase-wrapped material must assume public offline attack.
- Secret values should have recognizable encrypted markers so scanners and CI can reject plaintext.
- Git pre-commit/pre-push hooks and `am doctor` should catch unencrypted values, but hooks are advisory because they can be bypassed.
- GitHub secret scanning and push protection help catch known token formats, but they do not protect custom secrets or encrypted-but-weak passphrases.

What does not help much after the fact:
- Deleting the file in a later commit. Git history keeps it.
- Making the repo private after scrapers or forks cloned it.
- Rewriting history as a primary defense. GitHub’s own guidance emphasizes revoking/rotating leaked credentials first; rewritten history is disruptive, cannot clean other users’ clones, and may require support to purge cached views and PR refs.

### B. Compromised contributor account

Definition: an attacker gains access to a GitHub account or machine belonging to someone who can read or write the config repo.

Attacker capabilities vary:
- If they only get GitHub read access, this resembles public repo leakage: encrypted blobs and metadata are exposed.
- If they get write access, they can commit malicious config, alter recipient lists, weaken future encryption settings, or replace hosted UI URLs/tool definitions to induce phishing.
- If they get the contributor’s local machine or keychain, they may get cached KEKs/age identities and decrypt everything the contributor can decrypt.

Defenses that matter:
- Signed commits/tags or at least visible change review for security-sensitive files such as recipient manifests and encryption policy.
- Deterministic policy validation: `am` should refuse to decrypt or write if the repo policy was downgraded unexpectedly.
- Recipient list changes should be auditable and ideally require review in team repos.
- OS keychain caching protects against casual disk disclosure, not against a live compromised user session. Provide `am secrets lock`, `am logout`, and TTL/idle expiration.
- Principle of least privilege for team recipients: do not give all contributors all secrets by default.

### C. Hostile-fork scrape

Definition: an attacker intentionally forks or mirrors a public or briefly public repo, including git objects and old branches, then keeps an immutable copy. This may happen within seconds through bots.

Attacker capabilities:
- Keep old encrypted envelopes indefinitely, even if upstream rewrites history.
- Compare versions over time to infer secret churn, file names, recipient additions/removals, and encrypted value lengths.
- Attack old KDF parameters or old weak passphrases years later.

Defenses that matter:
- Backward secrecy is limited: anyone with an old ciphertext and a later-compromised passphrase/identity may decrypt historical values unless old data keys are rotated and old identities were not exposed.
- Avoid committing passphrase-wrapped master identity envelopes with weak KDF parameters that become permanent attack targets.
- Provide emergency rotation that creates new actual service secrets, not merely new encrypted wrappers.
- Minimize metadata leakage: encrypt values rather than whole files only if TOML UX demands it, but be honest that key names, paths, comments, and value lengths may leak.

### D. Commit-history reconstruction after delete

Definition: the user deletes a secret, removes the file, or replaces it with encrypted text, but prior commits remain reachable in branches, tags, PR refs, forks, local clones, GitHub caches, or packfiles.

Attacker capabilities:
- Use `git log`, `git grep $(git rev-list --all)`, GitHub cached diffs, PR refs, forks, or archived clones.
- Recover “deleted” plaintext if it was ever committed.
- Recover old encrypted envelopes and attack them offline.

Defenses that matter:
- Migration must treat any previously committed plaintext as compromised and prompt rotation of the underlying external credentials.
- History rewriting can reduce casual exposure but cannot be the security boundary. GitHub documents that sensitive data cannot be removed from other users’ clones and may persist in pull request views/caches until extra cleanup.
- `am migrate secrets` should produce a post-migration checklist: rotate provider tokens, rewrite history only if necessary, contact host support, invalidate old TOML, and audit forks.

## 2. Existing solutions to learn from

| Tool | Identity model | KDF / crypto shape | Multi-recipient story | Browser story | CLI UX | Key-rotation cost |
| --- | --- | --- | --- | --- | --- | --- |
| SOPS (Mozilla/getsops) | Per-file data key encrypted to master keys: age, PGP, AWS/GCP/Azure KMS, Vault. Supports key groups/threshold via Shamir. | Values encrypted with AES-256-GCM; data key wrapped by recipients/KMS. Passphrase only through underlying mechanisms, not the main team model. | Strong. Add/remove recipients in `.sops.yaml`, run update/rotate commands to rewrap data keys. KMS IAM changes can avoid file rewrites for access grants. | No native hosted-browser zero-knowledge editor. Browser would need a JS SOPS/age implementation and local identities. | Excellent for editors: `sops file.yaml`, decrypt temp, re-encrypt on save. | Rewrapping metadata is manageable; rotating actual data keys or all external secrets is more expensive. Removing a recipient does not erase their access to old commits. |
| git-crypt | Repo has a shared symmetric key; GPG public keys wrap that key for users. Git clean/smudge filters encrypt selected files. | AES-256-CTR with synthetic IV/HMAC construction. No password KDF unless symmetric key is manually protected elsewhere. | Moderate. `git-crypt add-gpg-user` adds a GPG-encrypted copy of the repo key. | Poor. Transparent git filters do not translate to hosted browser editing. | Very smooth after unlock; files appear plaintext locally. | Hard revocation. Once a user has the repo key, history remains decryptable; rotation is disruptive. |
| agenix | Nix-oriented age files encrypted to host/user SSH or age public keys listed in Nix expressions. | age file encryption; usually X25519 or SSH recipients. | Good for infra. Add recipient in `secrets.nix`, re-encrypt/rekey files. agenix-rekey adds master identity/YubiKey/TPM workflows. | None by default. | Good for Nix users, specialized otherwise. | Fine for small sets; at scale rekey automation is needed. Historical access remains. |
| dotenv-vault | Project/environment vault keys (`DOTENV_KEY`) decrypt `.env.vault`; team sync through dotenv service. | Encrypted vault file; exact KDF/identity model is product-specific. | Team story delegated to service/account model. | Product web UI exists, but not a general zero-knowledge git editor model for arbitrary TOML. | Simple `dotenv-vault push/pull/decrypt`. | Environment key rotation and redeploys; service coupling. |
| transcrypt | Shared symmetric password/key configured in local `.git/config`; optional GPG export of credentials. | OpenSSL, default AES-256-CBC; deterministic per-file salts. | Weak-to-moderate. Contexts allow multiple passwords; GPG export can share credentials. | None. | Transparent after setup, but credentials may live plaintext in local git config. | `--rekey` re-encrypts files and breaks plaintext historical diffs. Team coordination required. |
| BlackBox (StackExchange) | GPG public keys for admins; encrypted `.gpg` files in repo. | GPG encryption per file. | Clear but manual. Add/remove admin then `blackbox_update_all_files`. | None. | Wrapper commands (`blackbox_edit`, `postdeploy`). Project is abandoned. | Re-encrypt all files after admin changes; not for large file counts. |
| chezmoi + age | User dotfiles encrypted with age identity/recipient; can also prompt passphrase. | age; passphrase mode uses age passphrase behavior. | Supports multiple recipients and identities in config. | None as a hosted editor. | Good for personal dotfiles. Chezmoi docs note repeated passphrase prompts become tiresome, motivating key files/caching. | User-managed; adding recipients requires config and re-encryption. |
| Sealed Secrets (Kubernetes) | Cluster controller holds private key; anyone can encrypt to public cert. | Asymmetric sealing for Kubernetes Secret resources; controller decrypts in-cluster. | Not user/team recipients; recipient is the cluster/controller. | Not applicable to browser editor; one-way authoring model. | `kubeseal` CLI; good GitOps flow. | Controller renews sealing key every 30 days by default; old keys retained. `kubeseal --re-encrypt` moves to latest key. |

Lessons for `am`:
- SOPS has the closest data model: per-value or per-file DEK plus multiple KEK wrappers and auditable recipient metadata.
- git-crypt/transcrypt prove transparent local UX is popular, but git filters are brittle for hosted browser UX and can hide whether plaintext is about to be committed.
- agenix/SOPS prove “add pubkey, rewrap, commit” is understandable for technical teams, but 50-person teams need automation and review.
- Sealed Secrets is valuable conceptually for “public encryption key, private decryption key never leaves trusted environment,” but its trusted environment is the cluster. For `am`, the trusted environment must be the user’s local CLI/browser, not Cloudflare Workers.
- BlackBox and transcrypt show what to avoid: abandoned GPG wrapper complexity, plaintext local credential config, and whole-file workflows that do not map well to TOML web editing.

## 3. Password cached via OS keychain in production

Several successful CLIs use a pattern where the durable secret is stored in the OS credential store and the user is re-prompted based on terminal/session/expiration boundaries.

### 1Password CLI

1Password’s CLI/app integration is a strong UX reference. The CLI does not simply place long-lived plaintext in an arbitrary dotfile. It asks for explicit biometric/OS authorization when a new terminal window or tab uses the CLI. The documented model includes a 10-minute session that refreshes on use, a hard maximum session lifetime of 12 hours, and immediate revocation when the 1Password app locks. Session credentials are scoped to terminal/process properties: tty ID plus process start time on macOS/Linux, and PID plus process start time on Windows. IPC is platform-specific and authenticated: XPC/code signatures on macOS, Unix socket/group checks on Linux, named pipes and Authenticode checks on Windows.

Takeaway for `am`: emulate the UX shape, not necessarily the architecture. “Unlock once per active terminal, idle refresh for a short window, hard cap by day, lock command, OS auth when available” is understandable and proven.

### GitHub CLI (`gh auth`)

`gh auth login` defaults to a browser OAuth flow and stores tokens in the system credential store. If no credential store is available, it can fall back to plaintext and exposes `--insecure-storage`. This is good UX but also an important warning: cross-platform keychain support has failure cases on headless Linux, WSL, containers, and minimal servers.

Takeaway for `am`: if keychain storage fails, do not silently downgrade to plaintext for KEKs/age identities. Require explicit `--insecure-cache` or `AM_SECRETS_CACHE=plaintext` with loud warnings and short TTL, or fall back to prompting every time.

### AWS CLI SSO/session cache

AWS CLI SSO caches IAM Identity Center access tokens locally and refreshes or re-prompts when expired. The CLI separates long-ish SSO login sessions from short-term role credentials. The model is not zero-knowledge secret storage, but it sets user expectations: login once, commands work until token expiration, then `aws sso login` again.

Takeaway for `am`: separate “repo/provider authentication” from “secret decrypt authorization.” A GitHub OAuth session may remain valid while the local secret unlock cache is expired.

### Kubernetes ExecCredential plugins

Kubernetes exec credential plugins return credentials with an `expirationTimestamp`; client-go/kubectl cache and re-exec the plugin when needed. Plugins declare whether interactive stdin is allowed/required/never. This is a good model for terminal automation.

Takeaway for `am`: commands should know whether they are allowed to prompt. `am run` in CI should fail fast if secrets are locked rather than hang; interactive editing can prompt.

### Invalidation on machine compromise

OS keychain caching is not a complete answer to endpoint compromise. If malware runs as the user while the keychain is unlocked, it may ask the keychain, read process memory, intercept clipboard/editor temp files, or wait for the user to unlock. Invalidation must therefore be operational:
- `am secrets lock` deletes in-memory/session cache and asks the OS keychain to forget cached authorizations when possible.
- `am secrets logout --all` removes local cached wrapped identities and browser pairing material.
- `am secrets rotate` creates new age identities/DEKs and rewraps current secrets.
- For actual leaked provider tokens, rotate at the provider. Rewrapping ciphertext does not invalidate a stolen API key.

Recommended default for `am` CLI:
- Durable local storage: OS keychain item containing a randomly generated repo unlock key or encrypted age identity, never plaintext TOML secrets.
- Prompt policy: first decrypt in a terminal prompts for passphrase/OS auth; cache in memory for 10-15 minutes idle; hard cap 8-12 hours; lock on explicit command and optionally on system sleep.
- Non-interactive mode: require `--no-prompt`/CI env to fail if locked.
- Headless fallback: passphrase prompt or environment-provided one-shot key; no silent plaintext file cache.

## 4. Argon2id vs scrypt vs PBKDF2 for public-repo passphrase wrap

A passphrase-wrapped envelope in a public git repo is equivalent to publishing a password hash to attackers. They can attack it offline, at scale, forever. The KDF must be memory-hard, parameterized, salted, and upgradeable.

### Argon2id

Argon2id is the modern first choice for new password-derived encryption. OWASP recommends Argon2id and gives minimum profiles such as 46 MiB memory with 1 iteration, 19 MiB with 2 iterations, or 12 MiB with 3 iterations. Libsodium’s high-level password hashing API uses Argon2id by default and describes password hashing as CPU-intensive and memory-intensive specifically to resist brute force. Argon2id combines side-channel resistance and GPU/ASIC cost better than PBKDF2.

For `am`, Argon2id should be preferred for new non-age-native passphrase wrapping if compatibility allows. Use PHC-style self-describing parameters in the envelope so future clients can raise cost.

Suggested 2026 target:
- Calibration target: about 1 second on the user’s current CPU for an interactive unlock, with a floor.
- Floor for desktops/laptops: 128 MiB, t=3, p=1 or p based on available cores after benchmarking.
- Low-memory fallback: 64 MiB with higher time cost, explicitly marked as weaker.
- Browser fallback: calibrate separately because WebAssembly Argon2 can be slower and memory-limited; target 500 ms to 1.5 s and avoid values that crash mobile Safari/Chromium.

The exact “enough to deter cloud GPUs” number cannot be universal because passphrase entropy dominates. A weak 8-character password will fall eventually even with expensive KDFs. The product must enforce or strongly guide users toward high-entropy passphrases: 5-6 random words minimum, or generated 128-bit recovery key for serious use. KDFs buy cost multiplication, not magic.

### scrypt

scrypt is already part of age passphrase encryption and ADR-0042. It remains a strong memory-hard KDF when parameters are high enough. OWASP’s scrypt examples include N=2^16, r=8, p=1 for 64 MiB. Age passphrase files include scrypt recipient parameters in the header; the decrypting side’s cost is determined by the encrypted file header, so old weak work factors remain weak forever unless re-encrypted.

For `am`, continuing age+scrypt is acceptable and avoids redesign. The improvement is policy and calibration:
- Reject or warn on envelopes below a minimum work factor.
- Record KDF version/parameters in metadata.
- Provide `am secrets upgrade-kdf` to rewrap with current parameters.
- Benchmark on first setup and choose the highest work factor that meets the UX target.

### PBKDF2

PBKDF2 is widely available in WebCrypto and FIPS contexts, but it is not memory-hard and is more GPU-friendly. OWASP recommends PBKDF2-HMAC-SHA-256 at 600,000 iterations when PBKDF2 is required. That is acceptable for compatibility fallback, not the strongest public-repo defense.

For `am`, PBKDF2 should be a last-resort browser compatibility mode only when Argon2id/scrypt is unavailable, clearly labeled and preferably combined with high-entropy generated recovery keys rather than human passphrases.

### Practical calibration recommendation

`am` should treat KDF cost like TLS versions: enforce a minimum and offer upgrade prompts. On setup:
1. Benchmark candidate KDF parameters locally.
2. Choose parameters targeting roughly 1 second for initial unlock on CLI, with memory at 64-256 MiB depending on platform.
3. For browser/mobile, target around 0.75-1.5 seconds and cap memory to avoid tab crashes.
4. Store parameters in every envelope.
5. Warn if decrypting old envelopes below current policy.

## 5. Multi-recipient story for shared/team configs

The team problem is: Alice creates a config repo; Bob needs to decrypt; later Carol joins; later Bob leaves. Public-key recipient wrapping is the best developer-friendly answer.

SOPS and agenix both use a simple mental model:
- Every user/machine has an age public/private key pair (or KMS identity).
- The repo contains a recipient policy file listing public recipients for each secret group/path/environment.
- The encrypted secret data key is wrapped to each allowed recipient.
- To add a teammate: add their public key to policy, run rewrap/updatekeys, commit the metadata changes.
- To remove a teammate: remove their key, rewrap, commit, and rotate actual downstream service secrets if the teammate may have read them before.

This scales well to 5-15 technical users if tooling is good. At 20-50 users, raw recipient lists become noisy and error-prone. Mitigations:
- Group aliases in policy, e.g. `team:platform`, `env:prod-admins`, expanded by `am` into public recipients.
- Path/environment rules similar to SOPS `.sops.yaml`: dev secrets decryptable by many; prod secrets by fewer.
- CI policy check that every encrypted value has wrappers for exactly the expected recipient set.
- Bulk rewrap command: `am secrets rewrap --all --policy am-secrets.toml`.
- Recipient drift report: show who can decrypt which secret groups.
- Optional org-managed KMS/HSM recipients for enterprise, while preserving local age recipients for offline CLI.

Important limitation: removing Bob’s recipient prevents Bob from decrypting future commits, but does not prevent Bob from decrypting old commits he already had access to. If Bob’s access was legitimate, this is normal. If Bob is hostile or compromised, rotate the underlying provider secrets.

Recommended `am` policy model:
- Keep per-secret or per-secret-group DEKs, not one global repo key for all teams.
- Store recipient manifest in the repo, but make changes conspicuous and reviewable.
- Use age X25519 recipients as the universal base. Avoid SSH keys as the default for new systems; age’s own guidance recommends native X25519 for integrations.
- Support passphrase-wrapped personal identity for solo users, then add public recipients for teams.
- Do not use a single shared team passphrase except as an emergency recovery option; it is unrevocable and unauditable.

## 6. Hosted browser case: minimum UX when Worker cannot see plaintext

The hosted UI constraint is decisive: Cloudflare Worker must never see plaintext secrets or KEKs. Therefore, all decryption must happen in browser JavaScript/WebAssembly, using key material obtained locally. The Worker can serve static assets, proxy git/OAuth requests, store encrypted blobs, and coordinate auth, but it cannot unwrap secrets.

### Fresh tab, no local state

Minimum UX to read a decrypted secret in a truly fresh browser tab is one of:

1. User enters the repo passphrase. Browser runs Argon2id/scrypt locally, unwraps the age identity or DEK, decrypts the TOML value in memory.
2. User imports/pastes/drops an age identity or recovery key. Browser uses it locally; optionally stores a wrapped/non-extractable local form.
3. User approves a passkey/WebAuthn PRF operation. Browser derives a wrapping key from the authenticator and decrypts a locally or repo-stored wrapped identity.
4. User pairs with the CLI/local daemon. The CLI already has the identity in OS keychain; it performs local decryption or transfers a short-lived wrapped browser session key over a local authenticated channel.

Anything easier than this means the server has enough material to decrypt, which is forbidden.

### Browser local storage options

OPFS: MDN describes OPFS as a private origin-scoped filesystem available in secure contexts, invisible to the user, and suitable for efficient local file/database storage. It is good for encrypted repo cache, encrypted identity blobs, and local editor state. It is not a secret vault by itself; any JavaScript running under the origin can read it.

IndexedDB + non-extractable WebCrypto keys: WebCrypto `CryptoKey.extractable=false` prevents `exportKey()`/`wrapKey()` from returning raw key material. Such keys can be stored in IndexedDB and reused across sessions. This raises the bar against casual exfiltration but does not protect against malicious same-origin JavaScript that calls decrypt operations while the key is usable. It also depends on origin integrity and browser storage persistence.

LocalStorage/sessionStorage: avoid for secrets. Acceptable only for non-secret preferences.

Clipboard/file import: useful for recovery but risky. Provide warnings and avoid retaining plaintext.

### Passkeys and WebAuthn PRF

WebAuthn PRF is the most promising browser-native UX for zero-knowledge unlock. The PRF extension allows an authenticator/passkey to produce a stable secret output for a given relying party and input, after user verification or presence. Bitwarden and Filippo Valsorda’s `age-encryption`/Typage work show the pattern: use PRF output to wrap an age file key or identity, and perform decryption in the browser. The `age-encryption` package supports browser passkey/security-key encryption and an interoperable CLI plugin for hardware FIDO2 keys.

Benefits:
- No memorized passphrase for users who have passkeys.
- Hardware/platform authenticator can require biometrics/PIN.
- Worker never sees the derived key.
- Syncing passkeys may allow cross-device browser UX.

Caveats:
- Browser/platform support is still uneven. Chromium support is strongest; Safari/Firefox/platform combinations vary and must be feature-detected.
- Losing the passkey can lose access unless there is a recovery recipient/passphrase.
- Same-origin JavaScript integrity becomes critical. A malicious deployed UI could ask the authenticator to decrypt. Mitigate with strict CSP, SRI where possible, reproducible/static asset builds, no third-party scripts on the decrypting origin, and ideally an installable/offline web app option.
- PRF is symmetric. It is for wrapping local keys, not for public-key team recipient encryption by itself.

### Recommended browser UX tiers

Tier 0: View encrypted only. Fresh browser can browse repo and edit non-secret TOML without unlock.

Tier 1: Passphrase unlock. User clicks “Unlock secrets,” enters passphrase; browser derives KEK locally and decrypts. Offer “remember on this browser” by storing a locally wrapped identity in IndexedDB/OPFS, protected by WebCrypto and/or passkey if available.

Tier 2: CLI pairing. `am ui pair` opens a localhost or QR flow, authenticates the browser session, and provisions a browser-specific age recipient or wrapped session identity. Worker only relays encrypted pairing messages.

Tier 3: Passkey unlock. Browser creates a WebAuthn PRF credential and wraps the repo identity. Future tabs prompt OS/passkey UI, not the repo passphrase. Always require a recovery key/recipient before enabling.

Tier 4: Team/enterprise. Browser uses individual age recipients plus optional enterprise KMS via client-side OAuth/token exchange only if plaintext KEKs stay out of Worker. Be careful: cloud KMS decrypt APIs return plaintext data keys to the caller; if the caller is the Worker, zero-knowledge is broken. If used, KMS calls must be made directly from the client or through a blind/key-service design that does not reveal plaintext to the Worker.

## Public-leak incident response for `am`

When `am` detects or the user reports a public leak:
1. Classify: current branch only, full history, fork scrape, contributor compromise, or plaintext pre-migration leak.
2. If any plaintext provider credential was ever committed, mark it compromised and rotate at the provider first.
3. If only encrypted age envelopes leaked, assess passphrase entropy and KDF parameters. If weak, rotate underlying secrets; if strong, rewrap/upgrade KDF but do not panic-rotate everything automatically.
4. Remove public exposure and optionally rewrite history to reduce casual access, with warnings that forks/clones/caches remain.
5. Generate new repo age identity/DEKs if local keys may be compromised.
6. Commit rewrapped secrets and recipient policy updates.
7. Run secret scanners over all refs and working tree.

## KEY RECOMMENDATIONS FOR AM

- Adopt an “always-public, append-only git” security posture. All TOML secret values must be encrypted before commit, and history cleanup must be treated as exposure reduction, not protection.
- Keep ADR-0042’s age+scrypt+OS-keychain path, but add KDF policy enforcement, local calibration, and `am secrets upgrade-kdf`. Prefer Argon2id for any new non-age-native passphrase wrapping; keep scrypt for age compatibility; reserve PBKDF2 for explicit compatibility fallback only.
- Implement SOPS-like recipient policy and rewrap UX: native age X25519 recipients, group/path rules, `am secrets add-recipient`, `am secrets remove-recipient`, `am secrets rewrap --all`, and CI drift checks. Reject a single shared team passphrase as the normal collaboration model.
- Preserve CLI UX with OS keychain caching modeled after production CLIs: prompt/authorize once per terminal session, 10-15 minute idle refresh, 8-12 hour hard cap, explicit `am secrets lock`, and no silent plaintext fallback on headless systems.
- For hosted UI, enforce zero-knowledge strictly: the Worker may serve/relay encrypted data but must never receive plaintext secrets, passphrases, age identities, data keys, or KEKs. Decryption must happen only in browser memory or local CLI.
- Support browser unlock tiers: passphrase unlock as baseline; IndexedDB/OPFS for encrypted local state; non-extractable WebCrypto keys as a convenience layer; CLI pairing for smooth desktop UX; WebAuthn PRF/passkey unlock as the preferred modern path when feature detection succeeds, with mandatory recovery.
- Add leak-prevention and incident tooling: plaintext secret scanner for TOML, encrypted marker validation, pre-commit/pre-push hooks, GitHub push-protection guidance, full-history scanner, and a public-leak runbook that prioritizes provider credential rotation.
- Reject git-filter-based transparent encryption (`git-crypt`/transcrypt style) as the primary `am` model because it weakens browser compatibility, hides commit-time state, leaks metadata anyway, and makes team/browser UX harder than explicit encrypted TOML envelopes.
