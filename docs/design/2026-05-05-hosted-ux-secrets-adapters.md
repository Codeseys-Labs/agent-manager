# agent-manager hosted UX + git adapters + universal secrets — design memo

**Date:** 2026-05-05
**Status:** proposal (pre-ADR). Takes as input three research reports:
- `2026-05-05-am-current-architecture-survey.md` — what exists today
- `2026-05-05-universal-secrets.md` — secret-handling strategy
- `2026-05-05-hosted-ui-auth-and-git-backends.md` — hosted auth + browser git ops

**Who this is for:** the maintainer making a go/no-go call on the hosted UI before committing engineering to it. The user explicitly asked four questions; this memo answers each directly and proposes a single coherent architecture.

---

## Executive summary

1. **Auth UX: hybrid, tiered by backend capability.** GitHub → GitHub App; GitLab/Bitbucket → OAuth2+PKCE; Gitea/Forgejo/Codeberg → PAT entry + encrypted IndexedDB cache; generic HTTPS git → isomorphic-git + PAT; SSH-only → honest refusal banner pointing to `am serve`. Not OIDC-only, because ~half the target backends don't federate.

2. **Yes, we use the user's repo.** The Worker is stateless (ADR-0015/0031a); all state lives in the repo. Worker only proxies git. Browser reads/edits by calling the REST API where it exists, falls back to isomorphic-git over OPFS where it doesn't.

3. **Browser can edit.** Raw TOML (Monaco) ships first; structured per-entity forms land behind a toggle once Zod schemas are wired into the UI (they already exist in `src/core/schema.ts`). Commit cadence: save-button; optional `am-web/<device>` working-branch → Publish button for PR-flow users.

4. **Universal secret strategy: age public-key envelope, passphrase-unlocked identity cached in OS keychain.** Not KMS-first (excludes self-hosted users). Not passphrase-only (can't reach zero-prompt UX). Every per-machine identity is a separate age recipient so add/remove is `git rm recipients/X.pub && am secrets rewrap`. Public-leak-survivable. One wire format (`enc:v1:...`); pluggable backends (age default; sops-KMS, 1Password, Bitwarden, Vault as opt-in shims per git-platform adapter if a team wants it).

5. **Leaked repo survives** for secret values. Secret names and file structure do not survive (same guarantee as chezmoi/sops/age). Documented honestly in SECURITY.md.

6. **OS keychain: yes, for caching only, not as primary vault.** Use `cross-keychain` (or Bun FFI). Stores exactly one 32-byte KEK per install. If keychain locked, fall back to one-time passphrase prompt.

---

## Answer to "can we use OIDC/SSO vs git credentials — and can we use both?"

**Both — but not by accident. The auth tier is determined by the backend, not the user.**

| Backend | Primary auth | Fallback | Why |
|---|---|---|---|
| **GitHub.com** | GitHub App (per-repo install, fine-grained `contents:write` scope, short-lived installation tokens) | OAuth App if user refuses the App install | GitHub Apps are the 2026 recommended pattern — purest stateless Worker story (cookie holds only `installation_id`; JWT→token minted per request) |
| **GitLab.com, self-hosted GitLab** | OAuth2 + PKCE, scope=`api` (NOT `write_repository` — known bug: can't push with just write_repository per gitlab#321359), refresh-token in AES-256-GCM encrypted cookie | PAT entry for instances without OAuth2 | OAuth on GitLab is federation-friendly; `api` scope is the working minimum |
| **Bitbucket Cloud** | OAuth2 + PKCE, workspace + repo scoped | PAT | Same pattern as GitLab |
| **Codeberg** (public Gitea) | OAuth2 via Codeberg's provider | PAT fallback | Codeberg runs its own OAuth2 endpoint. Gitea-OAuth spec docs: https://docs.gitea.com/development/oauth2-provider |
| **Self-hosted Gitea / Forgejo** | **PAT entry form**, encrypted client-side with PBKDF2-derived WebCrypto key in IndexedDB (passphrase once per device) | None — OAuth doesn't federate across arbitrary Gitea instances | Each self-hosted Gitea is its own IdP. A hosted UI can't pre-register with a million unknown instances; PAT is the honest solution |
| **Generic HTTPS git** (gitolite, plain git-server, bare HTTP remote) | PAT entry + isomorphic-git over OPFS, with Worker-hosted CORS proxy if needed | — | Unknown hosts can't be detected; treat as opaque git smart-HTTP |
| **SSH-only** | **Blocked with first-class banner** | Use `am tui` or `am serve` on the user's machine | Browsers cannot open TCP sockets. Pretending otherwise (tunnelled agents, etc.) violates the stateless Worker model and adds attack surface. Refuse honestly |

### Why not OIDC everywhere?

- **Cloud providers (GitHub, GitLab, Bitbucket) have OAuth2, not OIDC.** OAuth2 is for authorization; we use it for that. OIDC is an identity layer on top; we don't need identity separately — the repo is the identity.
- **Self-hosted Gitea/Forgejo/Codeberg DO support OIDC as an IdP** (Codeberg is famously OIDC-friendly). But each instance is its own IdP — our Worker would have to dynamically register as a client per instance the first time anyone uses it. That's technically possible (dynamic client registration RFC 7591) but adds real complexity and many Gitea admins disable DCR. Not worth the complexity for the UX gain over PAT.
- **Plain git servers and gitolite have no auth UI** beyond HTTP Basic and SSH keys. OIDC is irrelevant.

### Can users mix? Yes, per-repo.

A user on GitHub uses GitHub App auth for their work repo; that same user can run a hobby repo on self-hosted Gitea with a PAT. The Worker holds per-repo session state in encrypted cookies. The CLI (`am`) stores per-remote credentials in `~/.config/agent-manager/credentials/<host>.{token,encrypted}` via OS keyring.

---

## Answer to "are we going to use a repo, and how do users edit it on the web?"

**Yes, one canonical repo per user (or per team). The Worker never stores anything — it's a renderer + commit proxy.**

### Architecture at a glance

```
Browser (Monaco editor + structured forms)
   │  ciphertext + encrypted PATs only ever reach the wire
   │
   ├── REST API (GitHub/GitLab/Bitbucket/Gitea) — single-file read/write
   │     5–50× faster than clone for per-file ops, no CORS proxy needed
   │
   └── isomorphic-git over OPFS — for generic HTTPS git only
         OPFS = Origin Private File System (browser-native, no quota wall)
         Worker-hosted CORS proxy as fallback (authenticated session cookie gate
         so it's not a free open proxy)
```

### Edit surface (two modes)

**Raw TOML (ships first, week 1):**
- Monaco editor with the existing @iarna/toml syntax
- Save-button commits
- Schema validation on save (use existing Zod `src/core/schema.ts`); errors inline with line numbers

**Structured forms (ships behind toggle, week 3+):**
- One form per entity type (`[servers]`, `[instructions]`, `[skills]`, `[agents]`, `[profiles]`)
- Generated from existing Zod schemas via `zod-to-json-schema` → react-jsonschema-form or similar
- Diff preview before commit
- Toggle defaults to structured once forms cover all five entity types

### Commit cadence

- **Save-button default** (not every-keystroke — pollutes history)
- **Optional working-branch mode**: each device gets `am-web/<device-id>` branch; Publish button fast-forwards `main`. Gives users free PR review when they want it, skips it when they don't.
- **Stateless constraint:** the Worker has no database to stage drafts in. Drafts live in:
  - a localStorage autosave (per-device), OR
  - the working branch (shared across devices but needs a Worker proxy commit)

### CLI-only operations (must be honest)

Operations the browser CANNOT do:
- `am apply` — writes to `~/.claude.json` and 12 other native IDE paths on the user's local disk. Browser can't see that disk.
- `am run <agent>` — spawns subprocesses, ACP/A2A clients, MCP stdio.
- `am secret scan --fix` against native IDE files.
- `am wiki ingest` of local session files (Claude Code JSONL at `~/.claude/projects/`).

**Solution:** the UI renders a prominent "Local-only: run `am <cmd>` on your machine" banner at the top of any panel that requires them. No pretending, no half-working simulations.

---

## Answer to "universal secret handling — so if the repo is exposed, secrets don't leak"

**Threat model statement** (publishable in SECURITY.md):

> A public leak of your `agent-manager` repo exposes no secret *values* to an attacker who does not also know your master passphrase. Secret names, field structure, commit history, and file paths are NOT hidden by the encryption layer. Rotate immediately on leak.

### The recommended strategy: age + passphrase + OS keychain

Three layers:

1. **On-disk wire format** — unchanged, still `enc:v1:<iv>:<ct>` (ADR-0012). But the values are now wrapped using **age** (X25519 + ChaCha20-Poly1305) instead of raw AES-GCM against a single master key. Age is CCA-safe, battle-tested in agenix/sops, and natively supports multiple recipients (one per machine).

2. **Per-machine identity** — each machine running `am` has its own age private key, stored encrypted at `~/.config/agent-manager/identity.age` using Argon2id-derived key from the user's master passphrase (chezmoi's `key.txt.age` pattern). The corresponding public key is committed to the repo as `recipients/<hostname>.pub`.

3. **Unlock cache** — after the first passphrase prompt, the derived Argon2id KEK is cached in the OS credential store (macOS Keychain / Linux libsecret / Windows Credential Manager) via `cross-keychain` or Bun FFI. Subsequent CLI invocations unlock silently.

### Why not just a passphrase (no age, no OS keychain)?

- Passphrase-only means prompting every time. Unusable for `am apply` as a git hook or CI step.
- Storing the derived KEK without per-machine public-key wrapping means any machine with the passphrase can decrypt — you can't revoke a lost laptop without forcing a full passphrase reset and key rotation.

### Why not KMS-first?

- Self-hosted users have no KMS. GitHub OIDC + AWS/GCP/Azure KMS is a great *option* for teams; it's a bad *default* because it excludes the largest user segment (individual devs on home machines).
- KMS-as-option ships as a **pluggable backend** — sops-style pointer in `.am-secrets.toml` selecting `age` (default), `kms-aws`, `kms-gcp`, `vault`, `1password`, `bitwarden`. Same `enc:v1:` wire format; different ways of getting the key.

### Should the secret backend be per-git-adapter?

**Pluggable, yes. Bound to the git adapter, no.** Tying secret backend to platform creates weird coupling ("my GitHub repo has KMS secrets but my Gitea repo has age secrets"). Instead, the backend is per-**repo** (declared in `.am-secrets.toml` at the repo root), and git adapters just carry the ciphertext. This matches how sops handles it.

### Multi-machine UX

```
# On laptop (already set up)
$ am pair add --hostname desktop
✓ Paste this on the new machine:
  am pair accept eyJwYXNzcGhyYXNlSGludCI6Li4ufQ==   # one-time token

# On desktop
$ am pair accept eyJwYXNz...
? Enter master passphrase: ********                  # same passphrase user always uses
✓ Cloned config repo
✓ Generated age identity for 'desktop'
✓ Added public key to recipients/desktop.pub
✓ Ran `am secrets rewrap`  (laptop re-encrypts every secret to both recipients)
✓ Cached derived KEK in Credential Manager
```

Adding a machine = a regular git commit. Revoking = `git rm recipients/desktop.pub && am secrets rotate`. No server-side state.

### Web UI with encrypted secrets

**The browser is a pseudo-machine.** On first use, the user types the master passphrase → WebCrypto `deriveKey` with Argon2id-WASM → unwraps the age identity in-tab (pure-JS age port, `age-ts`) → decrypts values for display. Derived key can be persisted in IndexedDB wrapped by a `navigator.credentials` passkey so subsequent visits are one biometric touch.

**Risks to document:**
- XSS exfiltrating the passphrase: mitigate with strict CSP, SRI on all script tags, SLSA build provenance on Worker assets.
- Supply-chain on the static bundle: sign releases, pin-by-hash in the Worker route.
- Shoulder-surfing: click-to-reveal with 30s auto-lock.
- **The Worker never sees plaintext or the KEK.** It only proxies git ciphertext. Consistent with ADR-0015.

### Recovery (lost passphrase)

- **One paired machine alive:** `am secrets rotate` on it generates a new identity, rewraps all values, pushes. The lost passphrase is a dead key.
- **All machines lost:** optional Shamir split recovery at setup time (`am pair export-recovery --shares 3 --threshold 2`). Printed / QR'd shards stored offline.
- **Single-machine user forgets passphrase:** unrecoverable by design. Same guarantee as chezmoi, sops, agenix. Document prominently.

---

## Adapter contract changes required

### Platform adapter interface (git backends)

Currently `src/platforms/*` has three adapters (GitHub via `gh`, GitLab via `glab`, bare). For hosted UX, extend:

```typescript
interface PlatformAdapter {
  // Existing
  detect(url: string): boolean;
  clone(url: string, dest: string): Promise<void>;

  // NEW — for hosted web UI
  readonly authMode: 'oauth-app' | 'oauth-pkce' | 'pat' | 'iso-git' | 'ssh-blocked';
  readFile(repo: RepoRef, path: string, creds: Creds): Promise<string>;
  writeFile(repo: RepoRef, path: string, content: string, message: string, creds: Creds): Promise<CommitRef>;
  createBranch(repo: RepoRef, base: string, newName: string, creds: Creds): Promise<void>;
  openPR(repo: RepoRef, base: string, head: string, title: string, creds: Creds): Promise<PRRef>;
  corsOk(url: string): Promise<boolean>;  // for iso-git fallback routing
}
```

Each existing adapter gains a REST-API read/write surface; a new `iso-git` adapter handles the fallback case.

### Secrets pluggable backend

Add a `SecretsBackend` interface at `src/core/secrets.ts`:

```typescript
interface SecretsBackend {
  readonly name: 'age' | 'kms-aws' | 'kms-gcp' | 'vault' | '1password' | 'bitwarden';
  encrypt(plaintext: string): Promise<string>;  // returns enc:v1:...
  decrypt(envelope: string): Promise<string>;
  rewrap(envelope: string, newRecipients?: RecipientList): Promise<string>;
  addRecipient?(pub: PublicKey): Promise<void>;
  removeRecipient?(id: string): Promise<void>;
}
```

Today's AES-GCM implementation becomes the `age` backend implementation (one envelope per value, multiple recipients). Other backends ship as opt-in plugins.

### `.am-secrets.toml` (new per-repo config)

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

---

## Build order (proposed sequencing)

If all of this ships, here's the dependency order:

1. **Week 1 — Foundations (ADR + core)**
   - Write ADR-0042 "Universal secrets strategy: age + passphrase + OS keychain" (supersedes current usage of ADR-0012's raw AES-GCM; ADR-0012 stays accepted as the wire format spec).
   - Write ADR-0043 "Hosted UI auth + git adapter tiers" (formalizes the 5-tier table above).
   - Extend `SecretsBackend` interface in `src/core/secrets.ts`. Keep existing AES-GCM path working (back-compat).
   - Add `cross-keychain` dependency (or Bun FFI equivalent). Wire KEK caching.

2. **Week 2 — age primitive + multi-machine**
   - Replace raw-AES with age envelope (1 recipient = current behavior; backward-compatible on read).
   - Ship `am pair add` / `am pair accept` / `am secrets rewrap` / `am secrets rotate`.
   - Migrate existing users: `am secrets migrate` reads old format, re-encrypts to new.

3. **Week 3 — Platform adapter REST surfaces**
   - Extend GitHub adapter with REST read/write via GitHub App token-minting (Worker-side).
   - GitLab/Bitbucket OAuth2+PKCE flows.
   - Gitea REST surface + PAT-entry flow (shared with iso-git adapter).

4. **Week 4 — Worker + Monaco UI shell**
   - Cloudflare Worker routes (`/oauth/*`, `/api/repo/*`, `/api/file/*`).
   - Monaco + TOML raw-edit UI. Save-button commits.
   - First honest banner for CLI-only ops.

5. **Week 5 — Secrets in the browser**
   - age-ts + Argon2id-WASM bundled into the UI.
   - Passphrase entry → IndexedDB persisted with passkey wrap.
   - Click-to-reveal + auto-lock.

6. **Week 6+ — Polish**
   - Structured per-entity forms (generated from Zod).
   - Working-branch + Publish flow.
   - iso-git fallback for Gitea/generic HTTPS.
   - `navigator.credentials` passkey flow.

---

## Open decisions for the maintainer

1. **GitHub App or OAuth App as primary for GitHub?** GitHub App is cleaner (per-repo, fine-grained scopes, short-lived tokens) but requires the user to install an App on their account — slightly more friction than OAuth. Recommend GitHub App with OAuth fallback. Decide.

2. **Single-identity mode for solo users?** Per-machine identities are revocable but add a step. Chezmoi offers "just copy `key.txt`" for speed. Expose `--single-identity` as an opt-in for power users? Recommend yes.

3. **OPFS size limits.** Browsers enforce ~60% of free disk (reasonable). Should the UI refuse to `iso-git clone` repos >500 MB? Recommend warning at 500 MB, hard refuse at 2 GB.

4. **Working-branch default: on or off?** On is safer (always a PR flow); off is friction-less for solo devs. Recommend off by default, exposed in settings.

5. **Recovery: Shamir at setup time?** Adds a step users will skip. But it's the only way to survive "laptop dead + passphrase forgotten + no other machine paired." Recommend: skip at setup, surface at `am pair add` the second machine ("Now that you have two devices, consider generating a recovery code in case you lose both").

6. **`.am-secrets.toml` location.** Repo root (sops-style) or `~/.config/agent-manager/.am-secrets.toml` (per-user)? Repo root is more portable across machines but means it's in the repo. Recommend repo root — the backend choice is part of the repo's identity.

---

## References (per-section)

- Existing-architecture survey: `docs/research/2026-05-05-am-current-architecture-survey.md`
- Universal secrets research: `docs/research/2026-05-05-universal-secrets.md`
- Hosted UI auth + git backends research: `docs/research/2026-05-05-hosted-ui-auth-and-git-backends.md`
- Parallel-critique synthesis: `docs/reviews/2026-05-05-parallel-critique/synthesis.md`

Key external references cited in research docs:
- age: https://age-encryption.org/
- sops: https://github.com/getsops/sops
- chezmoi secret management: https://www.chezmoi.io/user-guide/password-managers/
- agenix: https://github.com/ryantm/agenix
- GitHub Apps vs OAuth: https://docs.github.com/en/apps/creating-github-apps/about-creating-github-apps/choosing-between-a-github-app-and-a-personal-access-token
- isomorphic-git: https://isomorphic-git.org/
- Gitea OAuth2 provider: https://docs.gitea.com/development/oauth2-provider
- OPFS: https://developer.mozilla.org/en-US/docs/Web/API/File_System_API/Origin_private_file_system
