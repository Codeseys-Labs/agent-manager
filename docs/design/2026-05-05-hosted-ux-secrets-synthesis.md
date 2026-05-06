# Hosted-UX + Universal-Secrets: Concrete Answers to the 5 Open Questions

**Date:** 2026-05-05 (Run 2026-05-05-C, parallel-critique synthesis)
**Sources:**
- `docs/research/2026-05-05-B-followup/lens-a-universal-secrets.md` (GPT-5.5)
- `docs/research/2026-05-05-B-followup/lens-b-web-editing-ux.md` (Gemini 3.1 Pro Preview)
- `docs/research/2026-05-05-B-followup/lens-c-per-server-secret-indirection.md` (DeepSeek V4 Pro)
- ADR-0042 (universal secrets, accepted), ADR-0043 (hosted UI auth, proposed),
  ADR-0025 (worker multi-backend auth, accepted, amended by ADR-0043)

**Status:** Post-parallel-critique. 5 P0 + 2 P1 fixes applied inline.
Review synthesis at `docs/reviews/2026-05-05-hosted-ux-secrets-synthesis/synthesis.md`.
10 P2/P3 items remain in backlog.

---

## Q1. Adapters split — agent adapters vs git-backend adapters

**Confirmed.** am has two adapter axes (per AGENTS.md / ADR-0001):

- **IDE adapters** (13): Claude Code, Codex CLI, Cursor, Copilot, Windsurf, ForgeCode,
  Kilo Code, Kiro, Gemini CLI, Cline, Roo Code, Amazon Q, Continue. Each implements
  `detect / import / export / diff`.
- **Platform adapters** (3): GitHub, GitLab, bare git. URL-based detection.
  Codeberg + Gitea are NOT yet first-class adapters — they fall through to "bare git".

**Gap surfaced by Lens C (§7):** the IDE adapter capability surface is missing
`supportsEnvRefResolution`. Adapters that can resolve `${VAR}` at MCP-server spawn
time (Claude Code, Cursor, Windsurf — they all use a `.mcp.json`-shaped config with
`envFile` support) should NOT receive plaintext secrets at apply time; they should
receive `${VAR}` references that the IDE resolves later. This single change reduces
plaintext-on-disk in the **most-deployed** adapters; the actual percentage depends
on per-user adapter mix and is deferred to an audit (P2-4 in the parallel-critique
review backlog).

**Action item:** add `supportsEnvRefResolution: boolean` to `AdapterMeta`. Plumb
through `apply` so eager-resolve only happens for capability=false adapters.

---

## Q2. Hosted auth UX — git credentials vs OIDC/SSO

**Question restated:** for `am.example.com` (hosted Cloudflare Worker), do we use
git credentials (PATs) or OIDC/SSO? Or both? GitHub/GitLab vs Gitea/Codeberg.

**Decision (synthesized from Lens B §3, §7 + ADR-0043):** **both, tiered by what
the platform supports.**

The 5-tier ladder from ADR-0043 stands, but Lens B sharpens the rule for
self-hosted Gitea: **PATs are virtually unavoidable.** The reason is concrete and
not merely UX taste: configuring a per-instance OAuth2 client requires the Gitea
admin to register `am.example.com` as a client, generate a Client ID/Secret, and
hand them back to am. For a SaaS hosted UI talking to N user-owned Gitea instances,
this scales as N × manual registration. PATs scale as 1 paste per user.

| Platform | Tier | Mechanism | UX |
|---|---|---|---|
| GitHub.com | 1 | GitHub App OIDC | Click "Install on org/repo", auto-completes. Best. |
| GitHub Enterprise | 1 | GitHub App OIDC (per-instance install) | Same flow, manually install on Enterprise instance. |
| GitLab.com | 2 | OAuth2 + PKCE | Standard OAuth flow. Worker holds short-lived token only. |
| GitLab self-hosted | 2 | OAuth2 + PKCE + admin-registered client | Per-instance OAuth client; tractable for orgs. |
| Gitea / Forgejo (self-hosted) | 4 | **Fine-grained PAT** (paste flow) | User generates PAT in their Gitea, pastes once into am UI. PAT held in browser session memory only (lost on tab close); user re-pastes per session. |
| Codeberg | 4 | **Fine-grained PAT** (paste flow) | Same as Gitea. Codeberg supports OAuth but coordinating client registration on a public-instance basis isn't worth the complexity vs PAT. PAT held in session memory only. |
| SSH (any) | — | **Blocked for hosted UI** | Browser can't manage SSH keys safely; CLI-only path. |

**Both auth modes coexist.** A single config repo can be edited from CLI (any auth)
or from the hosted UI (tier-1/2/4 above). The repo never holds the auth credential —
the credential lives in the user's session (cookie + HMAC) or local OS keychain.

**Single-platform-only mode:** users who only use GitHub.com get the App OIDC path
with zero PAT involvement. Users on Codeberg-only get the PAT flow without ever
seeing GitHub UI. Mixed-platform users see both.

---

## Q3. Web editing on the repo — how do users edit & commit from a browser?

**Decision (synthesized from Lens B §1, §2, §4, §5 + ADR-0043):**

### 3.1 Transport priority

```
1st choice: Platform REST API (GitHub Tree API, GitLab API, Gitea API)
   - Fast, supports branch protection, commits via single HTTPS call
   - Works for: GitHub.com, GitHub Enterprise, GitLab.com, GitLab self-hosted, Gitea, Codeberg
   - This is the primary write path for tier-1/2/4 above
2nd choice: isomorphic-git in browser (CORS proxy needed for some hosts)
   - Universal, slower, no branch-protection support
   - Used as fallback ONLY for unknown / undetected hosts
   - OPFS for local working tree storage
```

Lens B is unambiguous: **REST APIs over isomorphic-git wherever possible** (§1, §4).
The Decap CMS pattern is the prior art — it abstracts over GitHub/GitLab/Gitea via
their REST APIs, treating isomorphic-git as a polyfill, not a primary path.

### 3.2 Conflict UX — "Always be PR-ing"

Lens B's §5 punchline: **do NOT build an in-browser 3-way merger.** Browser-side
conflict resolution against a stale base is an unbounded engineering problem with
no good UX outcome. The pattern that works is:

1. User edits at base SHA `X`.
2. User clicks Save. Worker (or browser direct-to-API) calls Tree API with
   `if-match` on parent SHA `X`.
3. If 200 OK → done.
4. If 409/422 (stale base) OR branch protection rejects:
   - **Pivot to PR mode automatically.**
   - Create branch `am/<user>/<timestamp>` with the user's changes.
   - Open PR against default branch.
   - Show user: "Direct save blocked. We've opened PR #N. Resolve via GitHub."
5. The conflict is resolved on the platform, not in our browser.

This handles BOTH stale-base conflicts AND branch-protection rules with a single
code path. Decap CMS calls this their "Editorial Workflow" (always-PR mode).

### 3.3 Editor surface

**Lens B (§6) recommends CodeMirror 6 over Monaco.** This is a real divergence from
the implicit Monaco assumption in earlier Phase-A vision docs. Reasoning:

- CM6 bundle: ~250 KB minified+gzipped (with TOML language pack)
- Monaco bundle: ~2-3 MB minified+gzipped
- CF Worker static-site delivery favors smaller bundles
- TOML doesn't need IntelliSense's heavy machinery — schema validation via a
  Web-Worker linter is sufficient

**Open decision for maintainer:** ADR-0043 mentions Monaco. Lens B's argument is
specifically about hosted-UI-on-Workers cost. If the local web UI (`am serve`,
non-Worker) wants Monaco for a richer experience, that's fine — but the hosted UI
should default to CM6. **Recommendation: amend ADR-0043 to specify CM6 for the
hosted UI, leaving Monaco as an opt-in for `am serve`.**

### 3.4 Pre-flight checks

Before opening the editor, query repo settings:
- Is the default branch protected?
- What checks are required?
- What's the current HEAD SHA?

If protected, the UI immediately enters PR mode (§8 of Lens B). User sees "Suggest
edit" instead of "Save" — sets expectation correctly.

---

## Q4. Per-MCP-server secret strategy across all git backends

**Question restated:** secrets for MCP servers need to land at process-spawn time
as env vars (or sometimes config files). The strategy must be optionally
swappable per-server. It must work the same whether the config repo lives on
GitHub, GitLab, Gitea, or Codeberg.

**Decision (synthesized from Lens C):**

### 4.1 Indirection scheme

Keep `${VAR}` as the canonical syntax (already shipped in `interpolateEnv`).
Extend it to recognize **URI-scheme values** at resolution time:

```toml
[servers.tavily.env]
TAVILY_API_KEY = "${TAVILY_API_KEY}"          # Resolved from secret backend
ANTHROPIC_KEY = "op://Work/Anthropic/credential"  # 1Password CLI
DOPPLER_KEY = "doppler://config/key"          # Doppler (deferred)
RAW_VAL = "literal-value"                      # Plaintext (NOT recommended)
```

The resolver dispatches on URI scheme. Schemes ship per-MVP, with
**execution-context awareness** (resolves P0-4 — schemes that can't run in the
browser must surface a clear error, not silent failure):

| Scheme | Backend | CLI? | Browser? | MVP status |
|---|---|---|---|---|
| `${VAR}` | am-managed (age, aes-gcm-legacy) | ✓ | ✓ | shipped |
| `op://...` | 1Password CLI shell-out | ✓ | **✗ (CLI-only)** | MVP add (Wave 4) |
| `env://NAME` | process env (no encryption) | ✓ | **✗ (CLI-only)** | MVP add (escape hatch) |
| `keychain://service/account` | OS keychain (cross-keychain) | ✓ | **✗ (CLI-only)** | MVP add |
| `vault://...` | HashiCorp Vault | ✓ | ✓ (with token in browser session) | post-MVP |
| `aws-sm://...` | AWS Secrets Manager | ✓ | ✓ (with browser SDK) | post-MVP |
| `gcp-sm://...` | GCP Secret Manager | ✓ | ✓ (with browser SDK) | post-MVP |

**Browser-context behavior for CLI-only schemes:** when the hosted UI encounters
a config containing `op://`, `env://`, or `keychain://` references, it MUST:

1. Display the field as locked (read-only with a "🔒 CLI-only" indicator).
2. Surface a clear, actionable error: "This field uses `op://...` references
   which require the 1Password CLI. View and edit this field via `am` CLI on
   your local machine."
3. NOT show plaintext (it can't resolve).
4. Allow the user to view the URI itself (it's not a secret) and to edit
   *other* fields in the same TOML file.

The cross-question-A "browser runs the same resolver locally" claim is now
qualified: the browser runs the resolver **for the schemes available in the
browser context**. CLI-only schemes are fenced.

### 4.2 Per-server backend override

Schema extension (`src/core/schema.ts`):

```toml
[servers.tavily.secrets]
backend = "1password"   # Forces all secrets in this server's env to op:// resolution

[servers.brave.secrets]
backend = "env"          # No encryption; user manages env directly
```

**Precedence chain (Lens C §4):**

```
1. Inline URI scheme on the value (op://...)        → that scheme wins
2. [servers.<name>.secrets].backend                  → per-server backend
3. AM_SECRETS_BACKEND environment variable           → run-level override
4. settings.secrets.backend                          → global default
5. Built-in fallback: aes-gcm-legacy                 → ensures no silent break
```

### 4.3 Resolution timing

- **am gateway path** (am spawns MCP server): resolve in-memory at spawn time.
  Plaintext never touches disk. Process inherits env, am drops plaintext after
  spawn returns.
- **am apply path** (writes to IDE-native config files): two modes per
  `supportsEnvRefResolution` capability:
  - capability=true (Claude Code, Cursor, Windsurf): emit `${VAR}` references.
    The IDE resolves at MCP-server spawn time. Plaintext never written to disk.
  - capability=false (older / less-supported IDEs): eager-resolve to plaintext
    before write. Same security posture as before.

**Failure handling for capability=false (resolves P1-2):** when an adapter
requires plaintext but the KEK is unavailable (keychain expired or cleared,
passphrase not in `AM_AGE_PASSPHRASE`):

1. **Interactive shell:** prompt the user for the master passphrase. Cache
   resulting KEK in keychain per §5.3 lifecycle.
2. **Non-interactive (CI, scripts):** fail with non-zero exit code and a
   structured error message (`error: secret KEK unavailable; pass
   AM_AGE_PASSPHRASE or run 'am secrets unlock' interactively first`). Do NOT
   write a partial config file. Do NOT silently skip secrets.
3. **`--dry-run`:** report which secrets would be eager-resolved vs lazy, but
   do not require KEK availability.
4. **Atomicity:** `am apply` writes to `<config>.tmp` first; renames atomically
   only if all secrets resolved. A partial write never lands on disk.

### 4.4 Cross-git-backend uniformity

**Lens C §7 conclusion:** the indirection layer is entirely client-side. No
GitHub Actions API integration, no GitLab CI variable integration, no Gitea
secrets API integration. The git backend stores ciphertext; resolution is local.

This means the strategy is identical across GitHub / GitLab / Gitea / Codeberg /
bare git. **No platform-specific code paths** for secrets.

The hosted UI consequence: when the browser opens a TOML and shows secret values,
it must run the same resolver locally (browser) to display plaintext. The Worker
never sees plaintext (zero-knowledge constraint preserved).

### 4.5 File-based secrets (config_template)

Some MCP servers want secrets in a config file (not env). Add to `ServerSchema`:

```toml
[servers.weird-server]
config_template = """
[auth]
key = ${WEIRD_KEY}
endpoint = "${WEIRD_ENDPOINT}"
"""
config_path = "~/.weird/config.toml"   # Where to write the resolved file
```

am resolves the template, writes to `config_path` with `0600` perms before
spawning the server, deletes after the server exits. Security note: the config
file IS plaintext on disk, briefly. Document this trade-off.

**Cleanup robustness (resolves P0-3):** `process.on('exit')` does NOT fire on
SIGKILL, OOM, SIGSEGV, or power loss. am must apply defense-in-depth:

1. **SIGTERM handler** in addition to `exit` for graceful termination.
2. **Best-effort `process.on('exit')`** for normal exit.
3. **Stale-file sweeper at `am` startup**: scan a known directory
   (e.g. `~/.config/agent-manager/runtime/templates/`) for orphaned plaintext
   config files older than 24 hours and delete. Run this on every am invocation
   that might spawn an MCP server.
4. **Document the abnormal-termination window** as a known plaintext exposure
   surface; recommend full-disk encryption (FDE) on the user's machine.
5. **Path discipline**: write to a `tmpfs`-backed location on Linux when
   available (`/run/user/$UID/`); falls back to `~/.config/.../runtime/` else.

For the hosted UI (browser), `config_template` does not apply — the browser
does not spawn MCP server processes. Skip this section in browser context.

---

## Q5. Universal secret strategies if the repo gets exposed

**Decision (synthesized from Lens A + ADR-0042):**

### 5.1 Threat model precision (Lens A §1)

| Leak class | What happened | Defense posture |
|---|---|---|
| Accidental public push | User toggled repo to public | Encrypted-at-rest must hold; no plaintext anywhere in committed history |
| Compromised contributor account | Hostile push or token theft | Per-recipient identity, ability to revoke a recipient and rewrap |
| Hostile fork scrape | Public fork before delete | Cannot un-publish — encrypted-at-rest is the only mitigation |
| History reconstruction | Force-pushed-deleted commits | Same as above; assume git history is forever |

**Lens A's headline:** treat the repo as **always-public, append-only.** This is
already ADR-0042's core posture; Lens A confirms it's correct against modern
threat models.

### 5.2 Encryption at rest — the strategy

**Adopted (already shipped via ADR-0042 + secrets-age.ts):**

- **age** (X25519, scrypt-passphrase-wrapped identity)
- Per-machine identity at `~/.config/agent-manager/identities/identity.age`
- Multi-recipient support (X25519 recipient public keys)
- Wire format: `enc:v2:age:<base64(age-ciphertext)>`
- Migration path: `am secrets migrate` re-wraps `enc:v1:` legacy AES-GCM envelopes

**Reinforced by Lens A §3:** add a **KDF policy + upgrade path**:
- Calibrate scrypt parameters at install time so that decryption takes ~1s on the
  user's CPU. Store calibration result alongside identity.
- `am secrets upgrade-kdf` to bump KDF parameters when calibration drifts.
- For passphrase-derived KEKs that aren't fed to age (e.g., browser-side wrap of
  local IndexedDB-cached identity), use **Argon2id** with `m=19MiB, t=2, p=1`
  (OWASP minimum, 2026 calibration).

### 5.3 Password caching via OS keychain (Q5 sub-question explicit)

**Pattern adopted from Lens A §3 (production CLIs survey):**

User flow:
1. First `am` invocation after install: prompt for master passphrase.
2. am derives KEK via scrypt (or fetches it from age scrypt-wrapped identity),
   then **caches the KEK in the OS keychain** under
   `service=agent-manager, account=identity-kek`.
3. Subsequent invocations: silent unlock from keychain. **No re-prompt** while
   the cache is warm.
4. **Idle timeout: 15 minutes** (since last unlock or last access).
5. **Hard cap: 12 hours** (re-prompt forced regardless of activity).
6. Both timeouts user-configurable via `settings.secrets.idle_minutes` and
   `settings.secrets.hard_cap_hours`.
7. `am secrets lock`: explicit invalidation; clears keychain entry.
8. `am secrets unlock`: explicit unlock prompt (e.g., for headless setup).

**Implementation note (resolves P0-1):** Neither `cross-keychain` nor any OS
keychain provides native TTL on entries. am must enforce idle/hard-cap by
storing a `last_unlock` and `last_access` timestamp alongside the KEK in the
keychain (e.g., as a JSON blob keyed by `account=identity-kek`), then comparing
on each access. On expiry, am wipes the entry and prompts.

**Why OS keychain, not file cache:**
- Keychain entries are user-scoped, OS-protected (Keychain on macOS, libsecret on
  Linux, DPAPI on Windows).
- They survive process restart but die on user logout (typical) or screen-lock
  policy depending on platform configuration.
- They're not in the user's home directory, so accidental `tar` / git-add can't
  exfiltrate them.
- `cross-keychain` (already audited, see `docs/audit/2026-05-05-cross-keychain-audit.md`)
  provides the cross-platform abstraction.

**Failure mode:** if the keychain is unavailable (headless server, CI), am falls
back to **session-cache via env var** (`AM_AGE_PASSPHRASE`) for the duration of a
single shell session. Document this as the headless escape hatch.

### 5.4 Browser-side: the zero-knowledge constraint

**Tiered UX from Lens A §"Recommended browser UX tiers":**

| Tier | UX | Worker sees |
|---|---|---|
| 0 | Read-only ciphertext | Encrypted bytes only |
| 1 | Passphrase unlock per-tab | Encrypted bytes only |
| 2 | CLI pairing (provisions a browser-specific age recipient) | Encrypted relay only |
| 3 | WebAuthn PRF / passkey unlock | Encrypted relay only |
| 4 | Team / enterprise (multi-recipient, optional KMS) | Never plaintext |

**Tier 1 is the MVP for hosted UI.** Tier 3 (passkey) is the long-term aspirational
goal — Lens A flags it as the most promising browser UX, but with caveats around
browser support. **Defer to a follow-up ADR (call it ADR-0045) for tier-3 design.**

#### 5.4.1 Tier 1 key provisioning (resolves P0-5 part 1)

The browser needs the age private key to decrypt `enc:v2:age:` envelopes. Two
options for Tier 1:

**Option A — passphrase-only mode (simpler, recommended for MVP):**

1. Browser fetches the passphrase-wrapped age identity file directly from the
   git repo (the `identity.age` file is the same file the CLI uses; it lives in
   the user's repo OR a per-user repo `~/.config/agent-manager/identities/`,
   committed-as-encrypted).
2. User types passphrase into the unlock dialog.
3. Browser runs age-WASM to derive the identity and decrypt envelopes locally.
4. Identity stays in JS memory only for the tab's lifetime.
5. **Worker never sees** passphrase, identity, or plaintext.

**Option B — CLI-pairing mode (Tier 2, post-MVP):**

1. User runs `am ui pair` on their CLI.
2. CLI provisions a **browser-specific age recipient** (separate X25519 keypair).
3. CLI rewraps the master identity to also be readable by the browser recipient.
4. CLI emits a one-time pairing token (QR code or copy-paste URL).
5. Browser receives the token, stores the browser-specific identity in IndexedDB
   wrapped by a passphrase chosen by the user (Argon2id + WebCrypto AES-GCM).
6. Future tab opens prompt for the browser passphrase, not the master passphrase.
7. **Worker never sees** any identity or plaintext.

This decouples the browser from the master passphrase and supports per-browser
revocation (`am secrets remove-recipient browser-X`).

#### 5.4.2 Browser-as-TEE assumption (resolves P0-5 part 2)

**Critical assumption acknowledged:** the Tier-1 zero-knowledge claim holds
**only when the static-asset origin is trusted**. Once the user types their
passphrase into the browser, the derived KEK lives in JS memory and is exposed
to:

- Cross-site scripting (XSS) in any Worker-served HTML/JS.
- Compromised CodeMirror 6 extensions or the TOML language pack.
- Supply-chain compromise of any direct dependency in the static bundle.
- Browser DevTools (if the user enables them with the unlock page open).
- Browser extensions with content-script access to the origin.

**Mitigations (mandatory for MVP):**

1. **Strict CSP:** `script-src 'self'`, no `unsafe-inline`, no third-party
   scripts on the unlock page.
2. **Subresource Integrity (SRI)** for every script + style tag in the unlock
   page.
3. **Reproducible static-asset builds** with hash verification published in the
   repo's release notes; users can verify the bundle they receive matches the
   published hash.
4. **No third-party CDN scripts on the unlock origin** — bundle everything,
   including fonts, into the Worker's static assets.
5. **Separate origin for unlock page** (e.g. `unlock.am.example.com`) with a
   minimal HTML+JS surface. Editor + git operations happen on a different origin
   that *cannot* read the KEK (cross-origin isolation).
6. **Document the limitation** explicitly in `SECURITY.md`: "Tier 1 zero-knowledge
   holds against a passive Worker. It does NOT hold against an active attacker
   who can inject code into the unlock page's origin. Users with high-stakes
   secrets should prefer Tier 3 (WebAuthn PRF) when available, or use the CLI
   path."

This is not a defeat — it's the same trust model as 1Password's web extension
and Bitwarden's browser app. The user trusts the origin's static-asset integrity.
But it must be **stated**, not implied.

### 5.5 Public-leak incident response

Lens A §"Public-leak incident response" outlines a 7-step runbook. Adopt it as
the basis for `docs/runbooks/secret-leak-response.md` (write in Wave 4):

1. Classify the leak class (current branch / full history / fork / compromised account).
2. **Always rotate provider credentials first** if any plaintext was ever committed.
   Encryption-at-rest does NOT save you from a plaintext leak that already happened.
3. Assess passphrase entropy + KDF parameters. Strong → rewrap & upgrade. Weak →
   rotate underlying secrets.
4. Optionally rewrite history (`git filter-repo`) to reduce casual access. Warn
   users that forks/clones/caches retain the data.
5. Generate new repo identity / DEKs.
6. Commit rewrapped secrets + recipient policy update.
7. Run secret scanners over all refs.

---

## Cross-question implications

Three places where the lenses converge into a single architectural commitment:

### A. The hosted UI is a thin git client, not a backend

(Q2 + Q3 + Q5 tier 1) The Worker is a CDN edge for static assets + a relay for
authenticated REST API calls. It holds no state, no plaintext, no long-lived
credentials. All resolution happens in the browser. This is the same posture as
Decap CMS, but stricter (no admin-config for OAuth clients).

### B. The IDE adapter capability surface needs to grow one bit

(Q1 + Q4.3) Adding `supportsEnvRefResolution: boolean` to AdapterMeta is the
single highest-leverage change for plaintext-on-disk reduction. Implementation
is small (per-adapter change to `export()`).

### C. The git backend is content-addressed ciphertext storage

(Q4.4 + Q5) am does not exploit any platform's secret-management API. Every
backend (GitHub / GitLab / Gitea / Codeberg / bare) is treated as the same:
"store this encrypted blob and these recipient public keys." Resolution is
client-side. This makes Codeberg-as-self-hosted indistinguishable from
GitHub.com from am's perspective.

---

## Open decisions to surface to maintainer

1. **CodeMirror 6 vs Monaco** for the hosted UI editor. Lens B argues CM6 for
   bundle-size reasons. ADR-0043 implies Monaco. **Recommendation: amend ADR-0043
   to spec CM6 for hosted UI, Monaco optional for `am serve`.**

2. **`op://` shell-out in MVP** (Q4.1) requires `op` CLI installed on the user's
   machine. Should am detect-and-prompt-install, or document as a prerequisite?
   **Default recommendation: document as prereq; do not auto-install.**

3. **Passkey/WebAuthn-PRF tier 3** in hosted UI: defer to ADR-0045 after MVP
   ships. **Recommendation: confirm ADR-0045 placeholder and keep MVP at tier 1
   passphrase-unlock.**

4. **Single-shared-team-passphrase** as a collaboration anti-pattern. Lens A
   §"KEY RECOMMENDATIONS FOR AM" rejects it explicitly. **Recommendation: am
   SHOULD reject it in the schema (don't accept `[settings.secrets].team_passphrase`
   as a field).**

5. **Idle / hard cap on keychain cache:** Lens A suggests 10-15 minute idle, 8-12
   hour hard cap. ADR-0042 didn't pin numbers. **Recommendation: 15-minute idle,
   12-hour hard cap, both user-configurable in `settings.secrets`.**

6. **`config_template` field for file-based MCP secrets** (§4.5): a known
   plaintext-on-disk window. Should we time-limit (delete after spawn returns)
   or document as a permanent leak surface? **Recommendation: delete after spawn
   process exit; use `process.on('exit')` cleanup hook.**

7. **PAT storage in browser** (Q2 tier 4): should the PAT be stored in IndexedDB
   wrapped by the user's age identity, or held only in session memory (lost on
   tab close)? **Recommendation: session memory only; user re-pastes per session.
   This matches Decap's posture and avoids a PAT-in-browser-indexeddb attack
   surface.**

8. **CLI pairing flow for hosted UI** (Tier 2): not designed yet. **Recommendation:
   defer to ADR-0046; not blocking for MVP if Tier 1 passphrase-unlock works.**

---

## Verification: each question has a concrete answer

| Question | Answered? | Where |
|---|---|---|
| Q1 — adapters split | ✓ | §Q1 + new `supportsEnvRefResolution` capability |
| Q2 — hosted auth (git creds vs OIDC) | ✓ | §Q2 5-tier table |
| Q3 — web editing UX | ✓ | §Q3 (REST-first, always-PR-on-conflict, CM6) |
| Q4 — per-server secrets across git backends | ✓ | §Q4 (URI schemes + per-server override + client-side only) |
| Q5 — universal secrets if repo leaks | ✓ | §Q5 (age + cross-keychain cache + tiered browser UX + runbook) |

**Implementation surfaces** (writes to follow): `supportsEnvRefResolution` on
AdapterMeta; `[servers.<name>.secrets]` schema extension; URI-scheme resolver
plumbing; `op://` and `keychain://` schemes; `am secrets upgrade-kdf`; runbook
doc; ADR-0044 amendment to ADR-0043 (CM6 + tier-1 passphrase MVP); ADR-0045
placeholder (passkey unlock).

**Status:** synthesis complete. Awaiting parallel-critique (Phase 3).
