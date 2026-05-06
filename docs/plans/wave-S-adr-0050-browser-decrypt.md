# Wave S — ADR-0050 Phase-1 Browser Secret Decryption Bundle

**Status:** ready-to-execute (plan only; no code in this doc)
**Source ADRs:** [0050](../../ADRs/0050-browser-secret-decryption-bundle.md), [0042](../../ADRs/0042-universal-secrets-strategy.md), [0049](../../ADRs/0049-csp-web-security-headers.md)
**Source research:** [Lens H](../research/2026-05-05-deep-loop/lens-H-adr-0042-browser-bundle.md), [Lens H clarification](../research/2026-05-05-deep-loop/lens-H-clarification.md)
**Estimated total:** 3 sub-tasks, ~700 LOC, ~$5-7 OpenRouter cost at 3-way parallel

## Goal

Phase-1 ships `age-encryption` (typage) browser-side decrypt parity with the CLI's single-layer scrypt path. A user visiting the hosted UI (after Wave Q login) can, inside a Wave R editor view, supply the master passphrase and decrypt an `enc:v2:age:...` envelope in-browser using the identical WASM `age-encryption@^0.3.0` package the CLI uses on disk. Byte-for-byte parity with `src/core/secrets-age.ts` is the only success criterion — no optimization, no alternative KDF.

After Wave S, when the editor view in Wave R detects a value prefixed `enc:v2:age:`:
1. A passphrase prompt renders in-tab.
2. Browser calls `new Decrypter().addPassphrase(pass)` + `decrypt(bytes, "text")`.
3. Plaintext displays in the editor; passphrase is zeroed on blur / navigate-away.
4. No network call. No `localStorage` / `sessionStorage` / `IndexedDB` write.

## Non-goals

- Argon2id KEK layer (Phase-2 within ADR-0050; `DEFAULT_ARGON2ID_PARAMS` remains roadmap-only).
- WebAuthn PRF for passphrase persistence across reloads (Phase-2).
- Hardware-token identities / FIDO2 `largeBlob` / YubiKey (Phase-3).
- Multi-user / multi-tenant key scoping.
- Write-back encryption from the browser (Phase-1 is decrypt-only; re-encrypt remains CLI-side).
- `argon2-browser` bundling — explicitly omitted from the Phase-1 bundle to stay within the <500 KB budget.

## Acceptance criteria (test-first, executable)

Each test names the file + describe + it. All must pass to call Wave S done.

1. `test/web/secrets/parity.test.ts` `describe("CLI ↔ browser parity")`:
   - `it("Node CLI encrypts a fixture, browser WASM decrypts identical plaintext")` (Playwright; real Chromium)
   - `it("round-trips UTF-8 multi-byte payload (e.g. '密码')")`
   - `it("round-trips 1 KB binary buffer via base64 envelope")`

2. `test/web/secrets/age-vectors.test.ts` `describe("c2sp.org/age test vectors")`:
   - `it("decrypts canonical scrypt-wrapped vector #1")`
   - `it("decrypts canonical scrypt-wrapped vector #2")`
   - `it("rejects tampered ciphertext with a clear error")`

3. `test/web/secrets/network-assertion.test.ts` `describe("no plaintext on wire")`:
   - `it("no outbound request carries the passphrase")` (Playwright network interception)
   - `it("no outbound request carries the decrypted plaintext")`
   - `it("no outbound request carries an AGE-SECRET-KEY-1... identity")`

4. `test/web/secrets/no-persistence.test.ts` `describe("no client persistence")`:
   - `it("localStorage remains empty across decrypt + navigate")`
   - `it("sessionStorage remains empty across decrypt + reload attempt")`
   - `it("IndexedDB remains empty across decrypt")`
   - `it("passphrase state cleared on blur / tab-close")`

5. `test/web/secrets/browser-decrypt.unit.test.ts` `describe("browserDecrypt (unit)")`:
   - `it("addPassphrase + decrypt happy path (Bun runtime)")`
   - `it("throws a typed error on wrong passphrase")`
   - `it("throws a typed error on corrupt header")`
   - `it("zeroes the passphrase ref after decrypt")`

Total: 14 acceptance tests across 5 test files.

## File-ownership map

Three sub-tasks, strictly sequential (each builds on the previous).

### S1 — Bundle setup (Bun + WASM + SRI + COOP/COEP) (~150 LOC, no deps within S)

**Owns:**
- `scripts/build-web-bundle.ts` (NEW, ~90 LOC)
  - Invokes Bun bundler against `src/web/entry.tsx` (Wave R-provided entry).
  - Emits `dist/web/` with hashed asset names.
  - Copies `age-encryption` WASM asset into `dist/web/assets/`.
  - Generates SRI hashes (`sha384-...`) for every JS + WASM artifact, writes `dist/web/sri.json`.
  - Enforces bundle-size budget: hard-fail if total `dist/web/` > 500 KB gzipped.
- `src/web/headers.ts` (NEW, ~40 LOC)
  - Exports `appendIsolationHeaders(res)` that sets:
    - `Cross-Origin-Opener-Policy: same-origin`
    - `Cross-Origin-Embedder-Policy: require-corp`
    - Note: Phase-1 does NOT strictly require COEP for the scrypt-only path. Headers are conditionally enabled via env flag `AM_WEB_ISOLATION=1` so they can be toggled on ahead of Phase-2 argon2 thread activation.
  - CSP delta: extends ADR-0049's `src/web/csp.ts` with a `wasm-unsafe-eval` directive scoped to `/assets/age-*.wasm`.
- `src/web/worker.ts` — routing update (~20 LOC):
  - Adds `/assets/*` static-serve branch that sets `Cache-Control: public, max-age=31536000, immutable` for hashed assets.
  - Wires `appendIsolationHeaders` when env flag present.

**Dependency signaling:** S1 assumes Wave R's `src/web/entry.tsx` exists. If Wave R lands after S1 start, S1 stubs `src/web/entry.stub.tsx` and swaps at S3 integration time. See §Dependency below.

**Tests:** none at this layer — S1 is pure build plumbing. Bundle-size assertion runs in CI as `bun run build:web && test -s dist/web/sri.json` plus a size check.

### S2 — Browser-side decrypt module (~270 LOC, deps: S1 bundle pipeline exists)

**Owns:**
- `src/web/secrets/browser-decrypt.ts` (NEW, ~120 LOC)
  - Exports:
    ```
    decryptEnvelope(envelope: string, passphrase: string): Promise<string>
    decryptIdentity(identityAgeBytes: Uint8Array, passphrase: string): Promise<string>
    zeroString(ref: { value: string }): void
    ```
  - Parses `enc:v2:age:<base64>` prefix; rejects other prefixes with a typed `UnsupportedEnvelopeError`.
  - Calls `new Decrypter().addPassphrase(pass)` + `decrypt(bytes, "text")` exactly as in `src/core/secrets-age.ts`. NO other API surface.
  - On failure, throws one of: `WrongPassphraseError | CorruptEnvelopeError | UnsupportedEnvelopeError`. Error messages never leak the passphrase.
  - Zeroes its own internal `Uint8Array` scratch buffers before return.
- `src/web/secrets/errors.ts` (NEW, ~30 LOC) — typed error classes.
- `test/web/secrets/browser-decrypt.unit.test.ts` (NEW, ~150 LOC) — 4 unit tests from acceptance §5.
- `test/web/secrets/age-vectors.test.ts` (NEW, ~100 LOC) — 3 vector tests from acceptance §2 using c2sp.org/age fixtures checked into `test/fixtures/age-vectors/`.
- `test/fixtures/age-vectors/` (NEW, ~3 files) — canonical scrypt-wrapped vectors downloaded from https://github.com/C2SP/CCTV/ at a pinned tag.

**Uses:** `age-encryption@^0.3.0` (already in `package.json` from CLI). No new npm deps.

### S3 — Editor integration (decrypt-on-display) (~180 LOC, deps: S1 + S2 + Wave R editor)

**Owns:**
- `src/web/editor/decrypt-gate.tsx` (NEW, ~80 LOC)
  - React component wrapping the Wave R editor view.
  - Detects `enc:v2:age:` prefix in the current value.
  - Renders a passphrase `<input type="password" autocomplete="off">` + Unlock button.
  - On Unlock: calls `decryptEnvelope()` from S2; on success, replaces editor content with plaintext + tags the buffer `{ encrypted: true, dirty: false }`.
  - On blur / navigate-away / tab-hide: zeroes passphrase ref and re-encrypts display to placeholder `••••••` (no re-encrypt of ciphertext — Phase-1 is decrypt-only).
- `src/web/editor/decrypt-gate.css` (NEW, ~20 LOC) — minimal styling; no inline styles (ADR-0049 CSP).
- `test/web/secrets/parity.test.ts` (NEW, ~120 LOC) — 3 parity tests from acceptance §1 (Playwright).
- `test/web/secrets/network-assertion.test.ts` (NEW, ~100 LOC) — 3 wire tests from acceptance §3 (Playwright network interception).
- `test/web/secrets/no-persistence.test.ts` (NEW, ~80 LOC) — 4 persistence tests from acceptance §4 (Playwright).

**Integration points with Wave R:**
- Imports `<Editor>` from `src/web/editor/editor.tsx` (Wave R export).
- Wave R editor must expose `onValueChange(prev, next)` and `setValue(next)` — spec these as a Wave R acceptance criterion.

## Risks + rollback

| Risk | Likelihood | Impact | Mitigation / rollback |
|------|------------|--------|-----------------------|
| Passphrase-in-memory XSS exposure | Med | Critical if exploited | ADR-0050 documents the trade-off; ADR-0049 CSP blocks inline scripts + eval; Phase-2 WebAuthn PRF closes this. |
| COOP/COEP breaks embedded fonts / 3P images | Med at enablement | UI visual regression | S1 gates isolation behind `AM_WEB_ISOLATION=1` flag; Phase-1 default off. |
| `age-encryption` WASM size drifts above budget | Low | Bundle exceeds 500 KB | S1 hard-fails build; bump to Phase-2 stricter budget if needed. |
| Typage API renames (`addPassphrase` → other) between CLI and browser | Low | Parity test fails | S2 pins exact version; parity test catches drift on CI before release. |
| c2sp.org/age vector fixtures drift | Low | Test flakiness | Pin fixtures at a specific tag in `test/fixtures/age-vectors/README.md`. |
| Playwright test requires headless Chromium in CI | Med | CI infra delta | Use existing `bunx playwright install chromium` step from Wave Q (if present) or add. |

**Rollback plan:** Single git revert of Wave S merge commit. Wave R editor remains functional for plaintext; only the `<DecryptGate>` wrapper disappears. No data migration.

## Budget estimate

- Total LOC: ~420 (impl) + ~450 (tests) + ~150 (fixtures / scripts) = ~1020 LOC gross; ~700 LOC net excluding fixtures.
- Estimated subagent cost: 3 sub-tasks × ~$1.5-2.5 each = ~$5-7 in OpenRouter spend.
- Wall-clock: strictly sequential S1 → S2 → S3 at ~30 min each = ~1.5 hours.

## Verification gates (Phase-1 done = ALL green)

Maps directly to ADR-0050 §Verification gates:

1. ✅ Parity test green: Node CLI-encrypted blob decrypts in Chromium with byte-for-byte match.
2. ✅ c2sp.org/age canonical vectors all decrypt successfully.
3. ✅ Network-assertion test: passphrase + plaintext + identity never appear on the wire.
4. ✅ No-persistence test: localStorage / sessionStorage / IndexedDB empty throughout decrypt flow.
5. ✅ `bun run typecheck 2>&1 | grep -c 'src/web/secrets/'` = 0.
6. ✅ `bun run lint` clean.
7. ✅ Bundle size: `du -sb dist/web/` < 500 KB (before gzip, generous floor).
8. ✅ SRI file present: `dist/web/sri.json` lists every JS + WASM artifact with `sha384-` prefix.

## Sequencing

```
Round 1 (sequential, 1 subagent): S1 (bundle + headers + WASM asset pipeline)
Round 2 (sequential, 1 subagent): S2 (browser-decrypt module + unit + vector tests)
Round 3 (sequential, 1 subagent): S3 (editor integration + Playwright tests)
Round 4 (sequential, 1 subagent): Phase-8 cross-family review (3 reviewers)
Round 5 (sequential, 1 subagent): Documentation + final commit
```

Each sub-task strictly depends on artifacts from the previous — no parallelism is safe within Wave S.

Total: 5 subagent rounds, ~$5-7 cost, ~1.5 hours wall-clock.

## DEPENDENCY

**Wave S depends on BOTH:**

1. **Wave R (editor + bundle pipeline).** S1 extends the Bun bundler that Wave R introduces; S3 mounts inside the Wave R `<Editor>`. If Wave R has not landed, S1 authors a stub `src/web/entry.stub.tsx` so the bundler can produce output, and S3 defers its integration test until Wave R merges. The acceptance test suite ultimately requires Wave R to be green.
2. **Wave Q (GitHub App OAuth scaffold).** S3's Playwright tests run behind an authenticated session — the test harness uses Wave Q's sealed-cookie utilities to pre-mint a test session. `src/web/worker.ts` asset routing modified in S1 must not collide with Wave Q's `/auth/*` and `/api/*` routes; S1 explicitly scopes asset serving to `/assets/*`.

Consequence for scheduling: Wave S cannot start until both Wave Q and Wave R are merged. If one lags, Wave S starts with stubs and final integration slides to a tail merge.

## How to execute

In a future deep-work-loop run, after Waves Q + R are merged:

```
delegate_task(tasks=[
  { goal: "Wave S sub-task S1: Bun bundler + WASM + SRI + COOP/COEP headers",
    context: "<this plan + ADR-0050 + ADR-0049 + Lens H + Lens H clarification>",
    model: "anthropic/claude-opus-4.7", provider: "openrouter",
    toolsets: ["file", "terminal"] },
])
```

Wait for S1 to land + commit. Then dispatch S2, then S3. No parallelism.

Phase-8 review prompt template lives in the deep-work-loop skill's `references/PHASES.md`. Each reviewer model from a different family (suggested: anthropic + openai + deepseek).

## What this plan does NOT solve

- ADR-0050 Phase-2 (Argon2id KEK layer + `argon2-browser` bundle) is a separate future wave.
- ADR-0050 Phase-2 (WebAuthn PRF for passphrase persistence across reloads) is a separate future wave.
- ADR-0050 Phase-3 (hardware-token recipients) is a separate future wave.
- Re-encryption from the browser (writing a new `enc:v2:age:` value) remains CLI-only in Phase-1.

## When to invoke this plan

User says one of:
- "Start browser decrypt"
- "Wave S"
- "ADR-0050 Phase-1"
- "Ship the age WASM browser bundle"

Do NOT execute partially. Either run all 3 sub-tasks to completion or revert the lot — partial Wave S deployments leave a decrypt UI that displays plaintext without the network / persistence guardrails that make it safe.
