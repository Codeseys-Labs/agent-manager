# Cross-Facet Synthesis — URL-credential obfuscation (commit 3100a4d)

Branch `feat/url-credential-obfuscation`, 1 commit vs `main` (ecffc5f). Dual adversarial
review: **6 Codex facets** (cross-model, GPT) + a **6-probe Claude workflow that ran the
actual code** (same-model, reproduction-backed). Both streams converged.

**Verdict up front: NOT mergeable as-is. 5 confirmed HIGH defects + 1 LOW, all reproduced
by running real functions on the commit.** The common theme: *detection capability >
substitution capability* — the new unified scanner detects credentials in more locations
than `substituteSecret` can rewrite, and the ingest loop then **encrypts a copy and
reports "encrypted" while leaving the plaintext in the committed `config.toml`** (false
sense of safety — the worst failure mode for a secret pipeline).

## Confirmed defects (reproduced)

| # | Defect | Codex | Claude-ran-code | Sev |
|---|--------|:---:|:---:|:---:|
| A | **adapter.url cred leak.** A credential in `adapters.<tool>.url` is detected but mapped to `urlSource:"command"` (it's not in command/args); `substituteSecret` rewrites `command` (a non-URL → no-op), leaving the adapter URL plaintext while ALSO storing an encrypted copy. Reachable via `am import` over a pre-existing hand-edited config. `secret-detection.ts:247-254`, `substituteSecret` url branch. | F1,F4,F5,F6 | ✅ plaintext+encrypted both in config.toml | HIGH |
| F | **betterleaks Tier-2 findings are no-op-substituted but counted as fixed.** Tier-2 findings get `location:"args"` with NO `index`; `substituteSecret`'s args-case requires `index !== undefined`, so it does nothing — yet ingest encrypts + counts it. Plaintext stays. NOTE: latent pre-existing bug **activated** by this commit's Step-1 fix that made Tier-2 actually return findings (was dead `[]` before). `secret-detection.ts:216-220`. | F6 | ✅ `substitute changed server? false; plaintext still present? true` | HIGH |
| C | **`scan --fix` + TUI import bypass `pickEnvVarName`.** add/import/web route url-cred secrets through collision-safe `pickEnvVarName`, but `secret.ts:384` (`scan --fix`) and `tui/index.tsx:190` still use bare `suggestedEnvVar`. Two `?api_key=` servers → both `${API_KEY}`, second clobbers first → one server gets the WRONG credential. | F4,F5 | ✅ `API_KEY=enc(server-b)`, server-a key lost | HIGH |
| D | **Apply-guard raw-scan membership bypass.** The guard now scans `buildResolvedConfig(config /*raw*/)`, but profile membership is interpolation-sensitive: a server whose `tags`/`server_tags` use `${VAR}` is ABSENT from the raw-resolved guard set yet PRESENT in the exported (post-interpolation) set → a hardcoded `?apiKey=tvly-…` is written to the native config and the guard never fires. `controller.ts:345`. | F2 | ✅ end-to-end: `tvly-…` written to `.claude.json`, guard silent | HIGH |
| E | **Missing-key apply ships `enc:v1:…` as the apiKey.** `interpolateEnvAsync` seeds extraEnv from `settings.env` using the lenient `allowV1PassthroughWithoutKey` backend; with no key, the envelope passes through verbatim and is spliced into the URL → native config gets `?tavilyApiKey=enc:v1:…` and apply reports SUCCESS. Broken server presented as clean. (No plaintext leak — stays ciphertext — so HIGH not critical.) `secrets.ts:348`. | F3 | ✅ ciphertext reached adapter.export, apply succeeded | HIGH |
| G | `formatScanReport` mislabels `url-credential` source as "betterleaks" in human output. `secret-detection.ts:425`. | F5 | ✅ cosmetic | LOW |

## What the review VALIDATED (held under attack)

- The happy-path round-trip (add → `${VAR}`+encrypt → apply → decrypt) works with the
  correct key (Claude p5 + Codex F3).
- `am secret scan`/`doctor` now correctly FLAG a plaintext URL cred (the original
  false-clean is fixed) (Claude p5).
- betterleaks `--report-path -` correctly revives Tier-2 (Claude p5; Codex F3 confirms
  `-`=stdout is documented).
- Distinct-value multi-credential URLs ARE both obfuscated (Claude p2 held).
- No import cycle introduced; `pickEnvVarName` is used at the 3 primary ingest sites
  (Codex F5).

## Root-cause classes (two)

1. **Detection > substitution.** The detector (`scanServersForUrlCredentials` + revived
   Tier-2) finds creds in adapter.url, args-by-URL, and arbitrary inline text — locations
   `substituteSecret` cannot (or doesn't) rewrite. Whenever rewrite silently no-ops, the
   ingest loop still encrypts + counts, so plaintext survives under a "fixed" banner.
   Fixes A, F. **Hard invariant needed: never encrypt+count a secret unless substitution
   provably removed the plaintext; otherwise throw.**
2. **Guard scans values on the wrong membership set.** The raw-scan fix (D) decoupled
   credential-VALUE detection (correct: raw, placeholder-exempt) from profile MEMBERSHIP
   (now wrong: raw tags don't interpolate). Fix: keep `resolved` (interpolated) for
   membership, re-key onto RAW values for the scan.

## Fix plan (next session / before merge)

1. **A** — thread adapter location through: `CredentialHit.adapterName`, `DetectedSecret.urlSource:"adapter"`+`adapterName`; `substituteSecret` rewrites `server.adapters[name].url`. Fix `formatCredentialHits`/`buildSuggestedReplacementUrl` to point at the real field.
2. **F** — map betterleaks findings back to the exact command/arg/env occurrence (or, if it can't be located, do NOT count it as fixed — surface it as "manual action required").
3. **C** — route `secret.ts:384` (`scan --fix`) and `tui/index.tsx:190` url-cred secrets through `pickEnvVarName`.
4. **D** — build the guard input from `resolved` (interpolated) membership re-keyed onto raw `config.servers[name]` values; throw on hits.
5. **E** — decode `settings.env` for interpolation with a STRICT backend (`allowV1PassthroughWithoutKey:false`) so a missing key aborts loud instead of splicing ciphertext. Keep lenient passthrough only for the env-block walk.
6. **Invariant (covers A+F):** in the ingest loops, after `substituteSecret`, assert the raw value no longer appears in the server; if it does, throw rather than encrypt-and-claim.
7. **G** — `formatScanReport`: add a `url-credential` → "url" label.
8. Tests for every above (adapter.url ingest, betterleaks-only inline, 2× `?api_key=` via `scan --fix`, `${VAR}`-tag guard bypass, missing-key fail-loud), + `.betterleaks.toml` allowlist for new fixtures.

## RESOLUTION (commit 628d9a5)

All 6 findings fixed and re-verified. A second adversarial pass (6 agents,
re-running each original attack + probing for fix-introduced regressions)
returned **allClean: true — 6 confirmed-fixed, 0 problems**.

| Finding | Fix | Re-verified |
|---|---|---|
| A adapter.url leak | thread `source`/`adapterName` through CredentialHit→DetectedSecret; `substituteSecret` rewrites `adapters[name].url` | ✅ |
| F betterleaks no-op | `substituteSecret` returns bool; locates value across args/command; callers check return | ✅ |
| C `scan --fix`/TUI collision | route url-creds through `pickEnvVarName` | ✅ |
| D guard membership | membership from interpolated `resolved`, values from raw `config.servers[name]` | ✅ |
| E missing-key leak | STRICT (`allowV1PassthroughWithoutKey:false`) backend for the interpolation catalog | ✅ |
| G report label | `formatScanReport` → "url" + real location | ✅ |
| Invariant (A+F) | never encrypt+count unless substitution provably removed plaintext | ✅ |

Regression probes that held: happy-path round-trip (with key), ADR-0012 env-block
passthrough (opaque, no key), age v2 envelopes, stdio servers pass, boolean-return
consumers, redaction surfaces. 3674 tests / 0 fail.

## Executive verdict

**6/10.** The core lifecycle and the audit-surface fix are sound and validated, but the
change ships **5 reproduced HIGH paths where a plaintext credential survives in the
git-committed config while being reported as encrypted** — unacceptable for a
security-sensitive secret pipeline. **MUST-BLOCK: A, C, D, E, F.** Nice-to-have: G.
The single most important invariant to add: *substitution must be proven before
encryption is counted.* Do NOT merge until A/C/D/E/F are fixed + tested.

## Reviewer framing (what neither stream fully checked — for a human)

- Real adapter rendering: does each of the 13 adapters actually emit the decrypted URL
  correctly at apply (we tested cursor + a capture adapter, not all 13)?
- Key-rotation across machines (`am pair` / age multi-recipient) interacting with
  URL-cred envelopes in `settings.env`.
- Whether an already-published config in a user's git history (pre-fix) needs a
  documented remediation beyond `am secret scan --fix`.
