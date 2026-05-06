[reviewer: moonshotai/kimi-k2.6]

CONFIRMED: The adapter split (Q1), tiered auth ladder (Q2), REST-first transport (Q3.1), always-PR-on-conflict (Q3.2), age encryption at rest (Q5.2), and per-server backend override (Q4.2) are coherent. The precedence chain in §4.2 is internally consistent.

ISSUES:

HIGH — §5.3 claims keychain entries "are not in the user's home directory, so accidental tar / git-add can't exfiltrate them." This is false. The age identity file lives at `~/.config/agent-manager/identities/identity.age` (§5.2), which is in the home directory and frequently dotfiles-synced. Additionally, `cross-keychain`'s Linux file-backend fallback stores encrypted key material in the home directory (per the cross-keychain audit). The justification for OS keychain caching relies on a factually incorrect premise.

HIGH — §4.4 and §5.4 assume the browser can resolve age-encrypted secrets locally, but Tier 1 MVP is "passphrase unlock per-tab" with no described key-provisioning mechanism. The browser needs the age private key to decrypt `enc:v2:age:...`; the memo never explains how the private key reaches the browser. If the user must type the full passphrase every new tab, the hosted-UX MVP has an unacknowledged UX cliff that will drive users to weak passphrases or abandonment.

HIGH — §4.1 introduces `op://` and `keychain://` as MVP URI schemes. In a browser, there is no `op` CLI to shell out to, and `cross-keychain` does not run in the browser. `env://` maps to `process.env`, which doesn't exist in a browser. The memo's "client-side only, no platform-specific code paths" claim (§4.4) is contradicted by schemes that are inherently CLI-only and OS-specific.

HIGH — §5.3 specifies "idle timeout: 8-12 hours; hard cap: 24 hours" for the OS keychain KEK cache, and Open decision #5 suggests user-configurable timeouts. Neither `cross-keychain` nor OS keychains provide native TTL/idle-timeout semantics for arbitrary entries. The memo provides no mechanism (timestamp file, keychain metadata, in-memory scheduler) to enforce these timeouts. Without an implementation, this is a security placebo.

MEDIUM — §4.5 `config_template` writes a plaintext file with `0600` and deletes it via `process.on('exit')`. This is Node.js CLI logic inserted into a hosted-UX memo. The browser has no `process.on('exit')`, and OPFS/native filesystem permissions differ from POSIX `chmod`. The cleanup mechanism is unportable and unspec'd for the browser.

MEDIUM — §3.1 mentions "OPFS for local working tree storage" as a fallback with isomorphic-git, but offers no fallback if OPFS is unavailable (older Safari, Firefox private mode).

MEDIUM — §Q2 table (GitLab) says "Worker holds short-lived token only," while Cross-question A claims the Worker "holds no state, no plaintext, no long-lived credentials." A short-lived token is plaintext state. The trust boundary description is inconsistent.

MEDIUM — §4.5 and §5.2 use POSIX `0600` permissions without acknowledging Windows semantics. A prior audit (REV-2) already flagged this; the synthesis should at least reference it.

MEDIUM — §5.2 recommends Argon2id `m=19MiB, t=2, p=1` for browser-side wrap. Running Argon2id with 19 MiB in browser WASM on mobile devices can cause OOM or multi-second hangs; no performance guardrails are mentioned.

LOW — §3.2 describes calling the Tree API with `if-match` on parent SHA. GitHub's Tree API uses `base_tree` in the request body, not an `If-Match` HTTP header. This is a minor technical imprecision.

LOW — §Q1 claims `supportsEnvRefResolution` would reduce "plaintext-on-disk by an estimated ~50%." No data or methodology supports this estimate.

QUESTIONS:

- How is the age private key provisioned to the browser for Tier 1 unlock? (§5.4)
- What mechanism enforces the keychain idle/hard-cap TTL? (§5.3, Open decision #5)
- How do `op://`, `keychain://`, and `env://` resolve in the browser where shell/OP/keychain/process.env are absent? (§4.1, §4.4)
- What is the write-path fallback when OPFS is unavailable and Tree API rate-limits hit? (§3.1, §3.2)

NEW BACKLOG:

- Browser key-provisioning flow design (Tier 1 passphrase → key derivation → session memory).
- Browser resolver compatibility matrix (`op://`, `keychain://`, `env://` behavior per context).
- Windows file permission strategy (replacement for POSIX `0600`).
- Tree API rate-limit handling and retry logic.
- Passphrase recovery / lockout UX when user forgets master passphrase.
- MCP spawn-crash cleanup guarantees for `config_template` plaintext files.
