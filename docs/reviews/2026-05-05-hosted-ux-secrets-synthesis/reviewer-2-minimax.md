[reviewer: minimax/minimax-m2.7]

---

CONFIRMED:
- Q1 adapter split is correct and the `supportsEnvRefResolution` addition is high-value.
- Q2 5-tier auth table is concrete and actionable; PAT-on-Gitea/Codeberg reasoning is sound.
- Q3 REST-API-first + always-PR conflict pivot is a solid architectural commitment.
- Q4 indirection scheme (URI schemes, per-server override, client-side only) is consistent and cross-backend uniform.
- Q5 threat model table (always-public, append-only) is well-framed.
- Cross-question implications A/B/C are coherent summaries.

---

ISSUES:

**HIGH — §5.3 contradiction on idle timeout**
Body text says "Idle timeout: 8-12 hours (matches `aws sso login` and `gh auth`)." Then Open Decision #5 recommends "15-minute idle, 12-hour hard cap." These are not reconcilable. 8–12 hours and 15 minutes are entirely different security/correctness postures. Maintainer must pick one. The 15-minute recommendation appears in Open Decisions but contradicts the body text's own stated rationale. This is an internal contradiction, not an open question.

**HIGH — §4.3: keychain unavailable during `am apply --ide` with capability=false**
When `supportsEnvRefResolution=false` (older IDEs), the memo says am "eager-resolve[s] to plaintext before write." This requires the KEK to be available. If the keychain entry has expired or was cleared, does `am apply` prompt the user? Fail silently? Write nothing? The failure path is unstated. A plaintext-write failure that surfaces no error to the user is a data-loss risk.

**HIGH — §5.4 Tier 1 + Cross-question A: Worker zero-knowledge architecture is self-contradictory**
Cross-question A states: "The Worker holds no state, no plaintext, no long-lived credentials." §5.4 Tier 1 says the browser runs the resolver locally so "the Worker never sees plaintext (zero-knowledge constraint preserved)." But then what does the Worker actually relay? If the Worker relays encrypted bytes, it is stateful in the sense that it must hold and forward ciphertext for the duration of the session. The "stateless relay" claim conflicts with any session-scoped relay function. This ambiguity has security implications: if the Worker buffers or logs encrypted relay data, it is de facto stateful and the zero-knowledge claim requires tighter definition.

**HIGH — §4.1: URI scheme error handling is entirely absent**
The scheme dispatch table lists 6 schemes, but for every scheme the memo fails to specify:
- What happens if the scheme handler (`op`, `keychain`, `doppler`) is not installed?
- What happens if the resolved value is absent (e.g., `${NONEXISTENT_VAR}` or `op://Work/NonExistent/field`)?
- Does the resolver throw, fall back to plaintext, or leave the URI unexpanded?
The fallback chain in §4.2 covers backend precedence but not scheme handler failure. This is a silent correctness gap.

**HIGH — §5.2 vs Open Decision #6 on KEK KDF policy**
§5.2 recommends Argon2id (`m=19MiB, t=2, p=1`) for "passphrase-derived KEKs that aren't fed to age." Open Decision #6 on `config_template` (the plaintext-on-disk window) never references this KEK policy. If `config_template` uses a passphrase-derived KEK for wrapping, which KDF does it use — age's scrypt or Argon2id? The two sections are adjacent but inconsistent on which KDF applies where.

**MEDIUM — §5.3: Windows DPAPI hidden assumption**
The rationale for OS keychain cites "DPAPI on Windows" as the protection mechanism. DPAPI-bound secrets are recoverable by any process running as the same Windows user on the same machine. A stolen disk attached to a machine with the same user account (or a domain-joined scenario) yields the keychain contents with no additional authentication. The threat model in §5.1 does not mention this, and §5.3 does not qualify "OS keychain" with this limitation. On macOS (Keychain) and Linux (libsecret/secretservice), the story is materially different — Keychain can require re-authentication per access; DPAPI cannot.

**MEDIUM — §5.4 Tier 1: sessionStorage vs tab lifecycle ambiguity**
Tier 1 says "Passphrase unlock per-tab." sessionStorage is origin-scoped and tab-scoped, so each tab independently stores the passphrase. If the user has 3 tabs open and unlocks in one, the other two tabs cannot see plaintext — correct. But if the tab is closed, sessionStorage is wiped. If the Worker is holding a relay connection for that tab's session, what happens when the tab closes and reopens? Does the user re-unlock? The memo says no re-prompt for the duration of the shell session (§5.3), but the browser context has no "shell session" equivalent. This boundary condition is not addressed.

**MEDIUM — §5.4: Tier 1 "encrypted relay only" vs Tier 4 "never plaintext" — tiered UX has undefined boundaries**
Tier 1 Worker sees "encrypted bytes only." Tier 4 Worker also "never sees plaintext." But Tier 1 requires the Worker to relay encrypted data that the browser will decrypt — how does the Worker distinguish between Tier 1 and Tier 4 traffic if it truly sees only encrypted bytes? The tier labels imply different security postures but the mechanism difference between "encrypted relay" and "never plaintext" is not defined. Tier 1 appears to have the same Worker-visible behavior as Tier 4.

**MEDIUM — §4.5: `process.on('exit')` cleanup hook is unreliable**
The memo recommends `process.on('exit')` cleanup for the plaintext config file created by `config_template`. `process.on('exit')` only fires for normal process termination (SIGTERM, exit call). It does NOT fire for SIGKILL, uncaught exceptions, or OOM kills. On Windows, `process.on('exit')` handlers run after the event loop drains but may not complete before termination. A more robust approach (SIGTERM handler, or write-to-temp + rename + unlink) is not mentioned. The "delete after spawn process exit" recommendation will leave plaintext on disk for all abnormal terminations.

**MEDIUM — Q2: PAT storage recommendation conflicts with the table entry**
Open Decision #7 recommends "session memory only; user re-pastes per session. This matches Decap's posture." But the Q2 tier-4 table entry says "PAT stored encrypted in browser (IndexedDB or in-config wrapped envelope)." These are contradictory. IndexedDB is persistent; session memory is not. The recommendation cannot simultaneously endorse "session memory only" and allow IndexedDB storage. One must be chosen.

**MEDIUM — §4.2: `AM_SECRETS_BACKEND` env var does not apply to browser context**
The precedence chain includes `AM_SECRETS_BACKEND environment variable → run-level override". For the hosted UI (browser), OS environment variables are not accessible. The resolver runs in the browser (per §4.4: "browser runs the same resolver locally"). How does `AM_SECRETS_BACKEND` apply in the browser path? This precedence level is either meaningless for hosted UI or requires translation into a browser-compatible mechanism (e.g., sessionStorage flag, Worker relay parameter). The memo does not address this.

**MEDIUM — §4.4: browser OPFS availability not addressed as failure mode**
The memo says "OPFS for local working tree storage" in the 2nd-choice transport path. OPFS (Origin Private File System) is not available in: Safari < 15.2, Firefox < 102, IE11, and has partial support in some mobile browsers. No fallback is specified for browsers that lack OPFS. If OPFS is a hard requirement for the isomorphic-git fallback path, the hosted UI will fail silently or degrade unexpectedly on unsupported browsers.

**LOW — §5.5 step 5: "Generate new repo identity / DEKs" is underspecified for multi-recipient**
Step 5 of the incident runbook says to "generate new repo identity / DEKs." For a multi-recipient setup (per §5.2: "Multi-recipient support"), generating new DEKs means re-encrypting all secrets for all recipients. The memo does not specify whether this is automatic, how long it takes for large repos, or what happens to secrets for recipients who are offline during the rewrap. This is a non-trivial operational procedure stated as a single step.

**LOW — §3.2: `if-match` on parent SHA — no stated error for missing preflight**
The conflict pivot uses `if-match` on parent SHA `X`. If the pre-flight check (§3.4: HEAD SHA, branch protection) was not performed (race condition, network error), the 409/422 pivot to PR mode is triggered. This is fine. But the memo does not address what happens if the Tree API call itself returns a 401/403 (credential expired mid-edit session). The user would see a save failure with no recovery path stated.

---

QUESTIONS:

1. §5.3: Which specific keychain implementation does `cross-keychain` target on Linux — libsecret (freedesktop), kwallet5, or both? The security properties differ: libsecret can be locked with a master password; kwallet5 may not require authentication per access.

2. §4.4: For the hosted UI browser resolver — is it compiled to Wasm (e.g., age decryption in a Wasm module) or pure JS? If Wasm, how is the Wasm module delivered and cached? Cloudflare Workers have a 1MB asset limit.

3. §5.4 Tier 1: What is the session boundary for the "per-tab" unlock? A browser tab can be backgrounded for days. Does the 15-minute idle (Open Decision #5) apply per-tab in the browser context, or is the browser session exempt from idle timeout?

4. §Q2 tier 4: For the PAT paste flow — does am validate the PAT before storing it (e.g., test a scopes-limited API call), or does it store whatever string the user pastes? A mispasted PAT could brick the hosted UI auth silently.

5. §4.1: The `vault://`, `aws-sm://`, `gcp-sm://` schemes are marked post-MVP. Is there a committed design for them, or are they placeholder rows? The table format implies commitment.

6. Open Decision #2: "Document as prereq; do not auto-install" for `op` CLI. If `op` is absent and the user has `op://...` URIs in their config, what error does the user see? Is there a targeted error message, or a generic scheme resolution failure?

7. §5.2: The KDF calibration result is stored "alongside the identity." Where exactly — in the identity file itself (appended metadata), a sidecar file, or the keychain? This affects portability of the identity across machines.

---

NEW BACKLOG:

1. **[security]** Design a SIGTERM-handler cleanup for `config_template` plaintext files. `process.on('exit')` is insufficient. Evaluate temp-file + atomic-rename + unlink pattern.

2. **[compat]** Define OPFS fallback path for browsers that lack it (Safari < 15.2, Firefox < 102). Either degrade to read-only or surface a clear incompatibility notice.

3. **[compat]** Audit `cross-keychain` on Linux for which backend (libsecret vs kwallet5) is targeted and whether the security properties are documented.

4. **[schema]** Add `supportsEnvRefResolution: boolean` to AdapterMeta — confirmed high-value, already identified.

5. **[ux]** Define the error message when a URI scheme handler is absent. Each scheme (`op://`, `keychain://`, `env://`) needs a distinct error with recovery guidance.

6. **[security]** Address DPAPI limitation in the threat model. A disk stolen with a live user account on Windows is a DPAPI bypass. Consider BitLocker or equivalent as an implicit dependency for Windows keychain security.

7. **[docs]** PAT validation step in the Gitea/Codeberg paste flow — test the PAT before storing, surface a clear error on failure.

8. **[browser-ux]** Define session boundary for browser-tier-1 passphrase unlock. Idle timeout applicability to backgrounded tabs needs a concrete spec.

9. **[interop]** Define the CLI pairing flow for Tier 2 (cross-question A / Open Decision #8) — it is not designed and is the only path by which the hosted UI can provision a browser-specific age recipient.
