# Audit: secrets-and-security

**Dimension:** secrets-and-security
**Date:** 2026-05-31
**Repo:** /mnt/e/CS/github/agent-manager
**Bar:** Can a stranger install this, run it, and get value without reading the source — with a first-run wizard configuring everything needed?

---

## Executive summary

The secrets story is a **half-finished migration that is actively dangerous if a user follows the documented happy path.** ADR-0012's AES-256-GCM (`enc:v1:`) is the only secrets system that actually works end-to-end: it is what `am init` sets up, what every write command (`secret set`, `add`, `import`, `install`, web, TUI) emits, and what the single apply path in `core/controller.ts` decrypts. The ADR-0042 `age` backend (`enc:v2:age:`), `am pair`, and the `am secrets {migrate,rewrap,rotate,revoke}` lifecycle are fully implemented and unit-tested **in isolation**, but they are **not wired into the runtime apply path**. The result is a confirmed, reproducible data-corruption bug: if a user runs `am secrets migrate` to age (as ADR-0042 and the migration tooling invite them to), `am apply` writes the literal ciphertext string `enc:v2:age:...` into their `~/.claude.json` / `~/.codex/config.toml` instead of the decrypted API key, silently breaking every MCP server. The ADRs were promoted to `accepted` on the strength of unit tests and design coherence, not an integration test proving the feature works.

The crypto primitives themselves are sound (Web Crypto AES-GCM with random IVs; HKDF for cookies; age via a real library; `0o600` key files; constant-time token comparison). The danger is entirely in the **integration gap** between two coexisting secrets systems, compounded by doc/CLI drift that points users at commands that don't exist (`am secrets add-recipient`) and a `.am-secrets.toml`-vs-`recipients/` directory location mismatch that means the multi-device pairing flow cannot reconcile its own state.

**Verdict for this dimension: refactor-in-place.** The legacy v1 system is shippable on its own. The age system is not, and shipping it half-wired is worse than not shipping it. Either finish the wiring (make `controller.ts` go through `getDefaultBackend`/`isAnyEnvelope`) or fence age behind an explicit experimental flag and strip the `accepted` status from the migration-inviting tooling.

---

## What is actually built (grounded)

### The two coexisting systems

| Concern | Legacy (ADR-0012) | Age (ADR-0042) |
|---|---|---|
| Wire format | `enc:v1:<iv>:<ct>` | `enc:v2:age:<b64>` |
| Key material | single 256-bit AES key, `resolveKeyPath()` outside git | per-machine X25519 identity, passphrase-wrapped |
| Write path | `secret set`, `add`, `import`, `install`, web, TUI | **none** — no write command emits v2 |
| Read/apply path | `controller.ts` → `interpolateEnvAsync` | **none** — apply cannot decrypt v2 |
| Lifecycle cmds | n/a | `am secrets {migrate,rewrap,rotate,revoke}`, `am pair {accept,finalize}` |
| First-run setup | `am init` offers key generation | **none** |
| Tests | unit + integration round-trip | unit only, isolated |

### Apply path is v1-only (the core bug)

`src/core/controller.ts:227-230` is the single apply chokepoint (per ADR-0040). It decrypts via:

```ts
const encryptionKey = await loadKey(configDir);              // AES key only
const { config: interpolated } = await interpolateEnvAsync(config, {
  encryptionKey: encryptionKey ?? undefined,
});
```

`interpolateEnvAsync` (`src/core/secrets.ts:294-323`) walks strings and only decrypts when `isEncrypted(value)` is true. `isEncrypted` (`secrets.ts:209-211`) returns `value.startsWith("enc:v1:")`. `decryptValue` (`secrets.ts:196-197`) **passes through anything that is not `enc:v1:` unchanged.** There is a correct discriminator already in the file — `isAnyEnvelope` (`secrets.ts:529-532`, matches both v1 and v2) — but the apply path does not use it, and `controller.ts` has **zero** references to `getDefaultBackend`, `age`, or `enc:v2` (confirmed by grep).

**Reproduced** (Bun, against the real module):

```
isEncrypted("enc:v2:age:QQQQ")     -> false   // the check apply uses
isAnyEnvelope("enc:v2:age:QQQQ")   -> true    // the check it should use
apply would write API_KEY = enc:v2:age:QQQQ   // ciphertext leaks as plaintext
```

So an age-migrated secret lands verbatim in the native IDE config. The MCP server receives `enc:v2:age:...` as its API key. No error is raised — `am apply` reports success.

### Write commands ignore `settings.secrets.backend`

`src/commands/secret.ts` has **0** references to `getDefaultBackend`. `secret set` (secret.ts:62-69) always calls `loadKey` + `encryptValue` (v1). Same for `add.ts:179`, `import.ts:323`, `install.ts:46`, `web/server.ts:264/394`, `tui/index.tsx:138`. Setting `settings.secrets.backend = "age"` in `config.toml` therefore changes nothing about how new secrets are written — only the `am secrets`/`am pair` family honours it (those do call `getDefaultBackend`). A user who flips the backend setting gets a confusing split: lifecycle commands operate on age, everyday commands still emit v1.

### `am init` only sets up the legacy path

`src/commands/init.ts:111-122` offers exactly one secrets action: "Generate an encryption key for secrets?" → `generateKey()` + `saveKey()` (legacy AES). No age identity, no passphrase capture, no `settings.secrets.backend`. A brand-new user is steered entirely into v1. The entire age apparatus is reachable only by hand-editing TOML and exporting `AM_AGE_PASSPHRASE` — at which point apply breaks (above).

### Migration tooling actively invites the broken state

`src/commands/secrets-migrate.ts` decrypts `enc:v1:` via `AesGcmLegacyBackend` and re-encrypts via `getDefaultBackend` (`secrets-migrate.ts:88,104,235`). If the user has set `backend = "age"` (or passes `--to age`), it rewrites every secret to `enc:v2:age:` and writes it back to `config.toml`. From that moment, `am apply` is broken for that install. ADR-0042's "Migration implemented (2026-05-05)... round-trip tests pass" (ADR line 350-354) refers to a `migrate`→`decrypt` round-trip, not an `apply` round-trip — the verification gate never exercised the runtime consumer.

---

## Strengths

- **Legacy AES-256-GCM is correctly implemented.** Random 12-byte IV per encryption (`secrets.ts:187`), Web Crypto GCM (authenticated), version-tagged prefix, round-trip-safe through TOML. Integration-tested end to end (`test/integration/secret-pipeline.test.ts:257-349`).
- **Key file hygiene.** Master key lives outside the git-tracked config dir (`resolveKeyPath`, `secrets.ts:32-53`), enforced `0o600` (`secrets.ts:182`), with a safe legacy-key migration that warns on conflict (`secrets.ts:88-111`). `.gitignore` defensively ignores stray key files (`git.ts:8-19`).
- **MCP write-tier auth is real and reasonable.** Bearer token required for write-tier tools when `AM_MCP_TOKEN` is set, compared with `constantTimeEq` (`mcp/server.ts:362`), with an explicit `AM_MCP_ALLOW_UNSAFE_LOCAL` opt-out and a clear refusal message (`mcp/server.ts:346-373`). `write-remote` (push/pull) additionally gated behind `settings.mcp_serve.allow_push` (`mcp/server.ts:434-442`).
- **Local web server has token auth by default.** 32-byte random token, `0o600`, `safeCompare`, Bearer-or-cookie middleware on `/api/*` (`web/server.ts:39-179`).
- **Worker cookie crypto is competent.** Per-encryption random IV, HKDF-SHA256 key derivation, `HttpOnly; Secure; SameSite=Lax` (`web/worker.ts:88-144`), short-lived encrypted CSRF state cookie with provider-binding and 5-min expiry (`worker.ts:208-258`). This reflects ADR-0019's fixes actually landing.
- **The age backend code, in isolation, is high quality.** Fail-closed rotation-state parsing (`secrets-age.ts:624-670`), two-stage prepare/commit finalize with a recovery hook (`secrets-age.ts:794-870`), recipient-id sanitisation against path traversal (`secrets-age.ts:1063-1066`), keychain treated as cache-not-vault with graceful degradation (`secrets-age.ts:264-287`). The Argon2id params are validated with a hard floor (`secrets-age.ts:154-174`).
- **`team_passphrase` rejection is enforced**, not just documented — Zod `.refine` in the schema (`schema.ts:235-242`) plus a `doctor` scan (`doctor.ts:27-30`). ADR-0046 is honoured in code.

---

## Weaknesses

(See structured findings for severities; expanded here.)

### CRITICAL — apply silently writes age ciphertext as plaintext secrets
`controller.ts:227-230` + `secrets.ts:196-211`. Reproduced above. Any install that adopts age (via `am secrets migrate`, `--to age`, or `backend = "age"` + a write) gets undecryptable secrets pushed into native IDE configs with no error. This is data corruption presented as success. **Fix:** route apply through `getDefaultBackend(configDir)` and gate the walk on `isAnyEnvelope`, dispatching v1→legacy and v2→age; add an integration test that `am apply` of an `enc:v2:age:` envelope yields plaintext.

### HIGH — ADR-0042/0047/0050/0051 are `accepted` but the feature is not shippable
ADR-0042 was promoted to `accepted` (lines 380-424) on five gates, one of which (gate 3, migration) was satisfied by a `migrate`-level round-trip rather than an `apply`-level one. The `accepted` status signals "done" to any reader (including a future contributor or the wizard author) when the user-facing feature is broken. **Fix:** downgrade the age-runtime claim to `proposed`/`partially-implemented`, or finish the wiring before any release advertises age.

### HIGH — `am secrets add-recipient` is referenced but does not exist
`schema.ts:240` (the `team_passphrase` rejection message) and `doctor.ts:279` both tell users to "run `am secrets add-recipient <pubkey>`". No such command is registered (`cli.ts:39-60` registers `secret`, `secrets`, `pair`; `secrets.ts:37-42` exposes only `migrate/rewrap/rotate/revoke`). The real flow is `am pair accept` / `am pair finalize`. A user hitting the `team_passphrase` guard is sent to a dead command. **Fix:** correct the messages to reference `am pair accept`.

### HIGH — recipients directory location mismatch breaks multi-device pairing
`AgeSecretsBackend.getRecipientsDir()` resolves to `~/.config/agent-manager/identities/recipients/` (`secrets-age.ts:200-201`, `resolveIdentityDir()` = `…/identities`). But `.am-secrets.toml` lives at `<configDir>/.am-secrets.toml` (`secrets-toml.ts:27-28`) and stores recipient paths like `"recipients/laptop.pub"` interpreted relative to the **repo root** (`<configDir>/recipients/`). `secrets-toml.ts:6-10` itself describes a "covered set" (`.am-secrets.toml`) vs "seen set" (on-disk `recipients/*.pub`) whose delta drives `am pair finalize` — but the two sets point at **different directories**, so the delta computation operates on inconsistent state. `pair-accept.ts:127-143` writes the `.pub` into the backend's dir and appends a repo-root-relative path to TOML. **Fix:** pick one canonical recipients location (the committed repo `recipients/`, per ADR-0042 §"per-machine identity") and make both sides resolve to it.

### MEDIUM — secret detection / redaction blind to v2 envelopes
The detection scanner skips only `enc:v1:` (`secret-detection.ts:131,190`), and MCP `config_show` redaction (`lib/redact.ts:18,51`) replaces only `enc:v1:` with `[encrypted]`. Once v2 envelopes exist, `am secret scan` may re-flag them and `config_show` will **leak `enc:v2:age:` ciphertext to MCP clients** (the exact class of issue ADR-0019 §5 closed for v1). **Fix:** use `isAnyEnvelope` / add an `enc:v2:` redaction pattern.

### MEDIUM — betterleaks binary downloaded with no integrity verification
`betterleaks.ts:103-114` fetches a GitHub-release binary and writes it executable with **no SHA-256 checksum, no signature, no provenance check** — only a post-download `version` smoke test (line 122). This directly contradicts SECURITY.md §6 ("Git-installed packages are pinned by exact SHA hash") and ADR-0042's pin-by-hash stance. A compromised release or MITM on the redirect chain yields code execution in the user's config dir. **Fix:** ship a pinned SHA-256 per platform and verify before chmod+exec.

### MEDIUM — generated `.gitignore` does not cover age/rotation artifacts
`git.ts:8-19` ignores key files but not `.am-rotation-state.json`, `identity.age.old`, or `.am-secrets.toml`. The identity files live outside the repo (under `…/identities`) so they're safe by location, but a user who copies them or relocates the identity dir into the repo has no guardrail, and there is no defensive ignore as there is for `key.txt`. Low blast radius today; matters once age is live. **Fix:** add defensive ignores mirroring the key-file pattern.

### MEDIUM — SESSION_SECRET strength is undocumented and unenforced
`worker.ts:115-132` derives the cookie key from operator-supplied `SESSION_SECRET` with a fixed salt (`"agent-manager-session"`). The session cookie carries a **live git OAuth access token** (`worker.ts:295-298`) capable of pushing to the user's config repo. A weak/short `SESSION_SECRET` makes that token cookie brute-forceable offline. No minimum-entropy check or doc. SECURITY.md §5 claims "the Web UI does not handle decrypted secrets directly" — but a repo-write OAuth token is a high-value secret the worker holds in plaintext inside the cookie. **Fix:** enforce a minimum length / document a `wrangler secret put` with a 32-byte random value; reconcile the SECURITY.md §5 wording.

### LOW — doc drift: SECURITY.md / ADR claims vs reality
SECURITY.md §1 describes Argon2id-wrapped identities as the at-rest mechanism, but `secrets-age.ts:99-117,343-348` is explicit that the on-disk wrap uses **age's scrypt**, not Argon2id — the Argon2id params are carried but "not yet consumed by the wrap path." The cryptographic-posture table (SECURITY.md:73-78) lists "age + Argon2id" for at-rest. This overstates the implemented KDF. **Fix:** state scrypt-today / Argon2id-planned.

### LOW — `am secret get` cannot read what the backend wrote
`secret.ts:127-151` reads via `loadKey`+`decryptValue` (v1 only). If any v2 envelope exists, `secret get` returns the ciphertext unchanged (passthrough), not the secret. Same blindness as apply, lower stakes.

---

## Attack surfaces for a v1 download (ranked)

1. **Self-inflicted secret corruption (highest likelihood).** Not an attacker — the tool's own migration path writes broken secrets into IDE configs. Most likely "embarrassment in front of a first user" event.
2. **MCP write-tier with `AM_MCP_ALLOW_UNSAFE_LOCAL=1`.** Documented escape hatch; a local malicious agent or prompt-injection through a tool can mutate config / apply / (with `allow_push`) push to the user's git remote. Auth model is sound *if* the token path is used, but the unsafe-local path is a single env var away.
3. **betterleaks supply chain.** Unverified binary download + execute. Opt-in (`am secret install-scanner`), but advertised in `am secret scan` output as a "Tip", lowering the bar to running it.
4. **Hosted worker cookie / token theft.** OAuth repo-write token in an AES-GCM cookie whose key strength depends on an unvalidated `SESSION_SECRET`. XSS in the SPA (CSP not verified here) would also expose it — SECURITY.md §5 defers browser-side hardening.
5. **Metadata leakage (in scope, by design).** Filenames, env-var names, server URLs, commit history are plaintext (SECURITY.md §1, §"Known Limitations"). Documented and acceptable, but a first user pushing a "private" repo public still exposes which providers they use.

---

## Wizard implications

A first-run setup wizard sits directly on top of this dimension and **must not** present the age path as ready:

- **Default to v1, loudly.** The wizard should generate the AES key (as `am init` does today) and stop there. It must **not** offer "enable age multi-device" until apply is wired — otherwise the wizard's own output breaks the next `am apply`.
- **Block or quarantine `am secrets migrate --to age`** until `controller.ts` decrypts v2. Today a wizard step that "upgrades security to age" would be a footgun generator.
- **What's missing for the wizard to ever offer age:** (a) apply-path v2 decryption via `getDefaultBackend`/`isAnyEnvelope`; (b) write commands honouring `settings.secrets.backend`; (c) a real `am secrets add-recipient` or corrected messaging to `am pair`; (d) reconciled recipients directory; (e) passphrase capture + keychain priming during init; (f) an integration test gating the whole loop.
- **The wizard CAN safely offer:** AES key generation + "save this in your password manager" (init.ts:121-122 already does this), git remote setup, betterleaks install **with checksum verification added**, and MCP server token generation for `am mcp-serve`.
- **Honesty:** the wizard should not claim "multi-device secret sync" or "team sharing" as available features. Those are `accepted`-ADR aspirations with no working runtime path.

Net: the wizard is feasible **for the v1 system today**. The age/pair/rotation surface is documentation and tested-in-isolation code that the wizard must treat as not-yet-shipped.
