# Parallel Critique — Hosted-UX + Universal-Secrets Synthesis

**Date:** 2026-05-05
**Artifact:** `docs/design/2026-05-05-hosted-ux-secrets-synthesis.md`
**Reviewers:** 3 (Kimi K2.6, MiniMax M2.7, Z-AI GLM 5.1) — three different families, none overlapping with the Phase-1 research scatter (GPT-5.5, Gemini 3.1 Pro, DeepSeek V4 Pro)
**Aggregator:** Claude Opus 4.7 (via Bedrock — orchestrator default)
**Router-trap probe:** PASSED. All three reviewer files open with the correct `[reviewer: <model-slug>]` header; metadata from `delegate_task` confirms each ran on the requested model.

## INTERSECTION — must-fix before merge (P0)

### P0-1: §5.3 keychain-cache timeout numbers contradict §Open-decision-5
- Flagged by: Kimi (HIGH), MiniMax (HIGH), GLM (HIGH) — **3/3 unanimous**
- Issue: Body text says "Idle timeout: 8-12 hours, hard cap: 24 hours." Open Decision #5 recommends "15-minute idle, 12-hour hard cap." These are not the same policy.
- Proposed fix: Pin one set. Recommendation from the reviewers' synthesis: 15-min idle, 12-hour hard cap, user-configurable. Adopt and remove the body-text numbers.

### P0-2: PAT-storage table entry contradicts Open Decision #7
- Flagged by: MiniMax (MED), GLM (MED) — both reviewers raised it independently
- Issue: §Q2 tier-4 table says "PAT stored encrypted in browser (IndexedDB or in-config wrapped envelope)." Open Decision #7 says "session memory only; user re-pastes per session."
- Proposed fix: Adopt session-memory-only. Strike the IndexedDB clause from the §Q2 table.

### P0-3: `process.on('exit')` cleanup is unreliable
- Flagged by: Kimi (MED — also doesn't apply to browser), MiniMax (MED), GLM (MED)
- Issue: Hook does NOT fire on SIGKILL, OOM, power loss, SIGSEGV. Plaintext config_template files persist on disk until next boot.
- Proposed fix: Two layers — (a) install SIGTERM handler in addition to `exit`, (b) add startup stale-file sweeper that removes orphaned `config_template` plaintext files from prior crashed runs. Document the abnormal-termination window as a known plaintext exposure.

### P0-4: URI schemes (`op://`, `keychain://`, `env://`) cannot resolve in the browser
- Flagged by: Kimi (HIGH — multiple schemes are CLI-only), MiniMax (MED — `AM_SECRETS_BACKEND` env var doesn't exist in browser)
- Issue: §4.4 claims "the browser runs the same resolver locally," but `op` CLI doesn't run in browser, `cross-keychain` doesn't run in browser, `process.env` doesn't exist. The §4.1 dispatch table is silently CLI-only for several schemes.
- Proposed fix: Annotate each scheme with **execution context** (CLI / browser / both). Schemes that are CLI-only must surface a clear error in the browser ("This config uses `op://` references which require the 1Password CLI; viewable but not editable in the hosted UI").

### P0-5: Tier-1 browser unlock — key-provisioning + XSS-exposes-KEK gap
- Flagged by: Kimi (HIGH — how does the age private key reach the browser?), GLM (HIGH — XSS in static assets exposes the KEK once user types passphrase)
- Issue: The memo never explains how the age private key is provisioned to the browser for Tier-1 unlock. Once the user types a passphrase, the derived KEK is in JS memory, exposed to any XSS / supply-chain compromise of Worker-served static assets.
- Proposed fix:
  1. Spec the key-provisioning flow: option (a) ciphertext-only mode where the browser fetches the encrypted age identity from the repo and unlocks with the user's passphrase locally; option (b) CLI-pairing flow that provisions a browser-specific X25519 recipient and a separate identity key cached in IndexedDB unlocked by passphrase; option (c) WebAuthn PRF (deferred, ADR-0045).
  2. Acknowledge the browser-as-TEE assumption in the threat model. State explicitly: "Tier 1 zero-knowledge holds against a passive Worker. It does NOT hold against an XSS or supply-chain attack on the static-asset origin. Mitigations: strict CSP, SRI, no third-party scripts on the unlock page, reproducible static-asset builds."

## INTERSECTION — should-fix soon (P1)

### P1-1: `~50% plaintext-on-disk reduction` claim unsubstantiated
- Flagged by: Kimi (LOW), GLM (HIGH)
- Issue: §Q1 claims `supportsEnvRefResolution` reduces plaintext-on-disk by ~50%, but only Claude Code, Cursor, Windsurf are named as capability=true. The other 10 of 13 adapters still write plaintext eagerly.
- Proposed fix: Either (a) audit all 13 IDE adapters and produce a real percentage based on user-deployment frequency, or (b) reword to "the most-deployed IDE adapters" without a number. Adopt (b) as the lower-effort fix; commit (a) as a backlog item.

### P1-2: Capability=false silent failure path on missing KEK
- Flagged by: MiniMax (HIGH), GLM (HIGH — eager-plaintext write is the default for the majority of adapters)
- Issue: When `supportsEnvRefResolution=false` and the keychain entry has expired, `am apply` would attempt to eager-resolve plaintext but fail. The failure path is unstated.
- Proposed fix: Define explicit failure handling: if KEK is unavailable AND the adapter requires plaintext, prompt the user (interactive) or fail with a clear non-zero exit code (non-interactive). Never write a partial config.

## UNION — follow-up backlog (P2/P3)

### P2-1: Worker "stateless relay" terminology vs reality (MiniMax HIGH)
The Worker MUST relay encrypted bytes for active sessions; that's stateful by definition. Tighten language: "Worker is stateless across sessions, holds only short-lived in-memory relay buffers per request." Define what data the Worker may log (none) and what request shape it accepts.

### P2-2: DPAPI-on-Windows limitation (MiniMax MED)
DPAPI-bound secrets are recoverable by any process running as the same Windows user. Macros: a stolen disk + same user account = keychain bypass. Add to threat model: "On Windows, OS keychain protection assumes BitLocker (or equivalent FDE) for at-rest disk theft scenarios."

### P2-3: KDF mix — scrypt (age) + Argon2id (browser) + ??? (config_template) (MiniMax HIGH)
§5.2 hedges between scrypt and Argon2id. Pin which KDF applies in which context: scrypt for age identity wrap (forced by age spec), Argon2id for browser-side IndexedDB-wrapped identity, n/a for config_template (it doesn't wrap; it expands). Open Decision #6 in the original memo doesn't mention this — should.

### P2-4: Argon2id 19 MiB on mobile = potential OOM (Kimi MED)
Browser WASM Argon2id with `m=19MiB, t=2, p=1` can OOM or hang multi-second on low-end mobile. Add adaptive parameters: detect device memory via `navigator.deviceMemory` and downscale to `m=8MiB` on devices reporting <2GB.

### P2-5: OPFS browser availability fallback (MiniMax MED, Kimi MED)
Safari < 15.2 and Firefox < 102 lack OPFS. Specify: degrade to read-only mode, surface clear browser-incompat notice. Bake a feature-detect at app load.

### P2-6: `AM_AGE_PASSPHRASE` env-var fallback security classification (GLM MED)
Currently documented as "headless escape hatch." Classify explicitly: refuse in interactive shells unless `--allow-env-passphrase` flag, allow in CI/non-interactive automatically. Surface in docs as a known downgrade mode with `/proc/PID/environ` exposure caveat.

### P2-7: CM6 TOML language pack is not first-party (GLM LOW)
CM6 doesn't ship a TOML language pack. am must either depend on `@codemirror/lang-toml` (3rd-party, ~150 LOC) or author its own. Pick a path; budget bundle size.

### P2-8: `env://NAME` is a no-op indirection (GLM LOW)
`env://NAME` is equivalent to existing `${VAR}` and adds dispatch complexity. Drop it from the §4.1 table.

### P2-9: Tree API uses `base_tree`, not `If-Match` (Kimi LOW)
§3.2 mentions `if-match` on parent SHA. GitHub Tree API uses `base_tree` in body, not header. Correction.

### P2-10: Multi-recipient rewrap operational complexity (MiniMax LOW)
§5.5 step 5 collapses a multi-step rewrap-for-all-recipients-while-some-are-offline workflow into one bullet. Expand into a runbook section.

## DISAGREEMENTS

None. All three reviewers agreed on the direction of every flagged item; they disagree only on severity (e.g., Kimi LOW for the ~50% claim, GLM HIGH).

## METADATA

- Total reviewer wall-time: ~600s (one timed out gracefully after writing its file)
- Token cost: ~85k input + 10k output across 3 reviewers (~$2 OpenRouter)
- Aggregator (this doc): in-context, no additional API call
- Method: parallel-critique skill, blind 3-way scatter on cross-family models, no inter-reviewer contamination

## ACTION SUMMARY

Apply 5 P0 fixes inline to the synthesis memo:
1. Pin timeout numbers — keep Open Decision #5 (15-min idle, 12-hour hard).
2. Strike "IndexedDB" from PAT-storage row in §Q2.
3. Spec the SIGTERM + stale-file-sweeper combo for `config_template`.
4. Annotate URI schemes with execution context.
5. Spec key-provisioning flow + acknowledge browser-as-TEE assumption.

Apply 2 P1 fixes inline:
1. Reword ~50% claim to "most-deployed adapters."
2. Define capability=false failure path.

Defer 10 P2/P3 to backlog (this doc serves as the backlog).
