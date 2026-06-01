---
status: proposed
note: plan-only, code not yet landed
date: 2026-05-05
proposed: 2026-05-05
amends: ADR-0042
---

# ADR-0050: Browser Secret Decryption Bundle (Synthesizes Lens H + Clarification)

## Context

ADR-0042 §3 (browser-decrypt path) was sketched in two lines and deferred. Lens H (`docs/research/2026-05-05-deep-loop/lens-H-adr-0042-browser-bundle.md`) together with its clarification document (`docs/research/2026-05-05-deep-loop/lens-H-clarification.md`) resolve the four open ambiguities identified during research:

- KDF stack selection for Phase-1 browser
- Typage / API name alignment (`age-encryption@^0.3.0`)
- argon2-browser status (optional, Phase-2 only)
- WebAuthn PRF for KEK persistence

Lens A (`docs/research/2026-05-05-deep-loop/lens-browser-secrets.md`) established the high-level breadth; Lens H converted that into a concrete, minimal shipping bundle. ADR-0050 ratifies the browser-decrypt design without claiming to close any ADR-0042 verification gate (those are tracked separately and are about ADR-0043 coherence + keyring audit + migration, not about the browser bundle).

CLI reference implementation lives in `src/core/secrets-age.ts` (single-layer scrypt via `age-encryption`'s built-in `Decrypter.addPassphrase()`). No TypeScript source is duplicated here; the decision merely locks parity.

## Decision

From Lens H + clarification the project adopts the following Phase-1 bundle and defers everything else:

1. **KDF stack** — single-layer scrypt only (current CLI behavior). Browser uses `age-encryption@^0.3.0` (typage) with `Decrypter.addPassphrase()` directly. The `DEFAULT_ARGON2ID_PARAMS` export in `secrets-age.ts` and the accompanying `Argon2idParams` interface are **ROADMAP-only**; they will gate a future KEK-cache layer. Phase-1 browser never invokes them.
2. **WASM footprint** — ship only `age-encryption@^0.3.0` (~35 KB gzipped). `argon2-browser@^1.18.0` (~80 KB WASM) is pulled **exclusively** for the future KEK-cache; it is omitted from the initial browser bundle.
3. **WebAuthn PRF** — deferred to Phase-2 for persistent KEK storage; no plaintext passphrase survives page reload in that model.
4. **Browser bundle target** — <500 KB total (UI + editor + age WASM). Lens G v2 measured the editor at 172 KB; Lens H measures age WASM at 35 KB — comfortable headroom remains.
5. **Build & security headers** — Bun bundler + SRI + COOP/COEP cross-origin isolation headers. Isolation will be required once argon2-browser threads land in Phase-2; it is **not** required for the Phase-1 single-layer path.

## Rationale

Matching the CLI's scrypt-only path for Phase-1 gives **parity above optimization**. Every encrypted secret already on disk was produced by `age-encryption`'s scrypt KDF; a browser that performs the identical operation can decrypt any existing artifact without migration or dual-path logic. The Argon2id KEK layer + WebAuthn PRF are each independently valuable (stronger credential store, passwordless unlock across reloads) but each adds ~120 KB and material browser crypto complexity. Deferring them keeps the initial web UI shippable within the declared size budget and risk tolerance while still leaving an unambiguous extension path.

## Trade-offs

Phase-1 browser implementation **must** transiently hold the master passphrase in the in-tab JavaScript context (memory only, never transmitted). Consequently an XSS compromise of the hosted UI directly yields that passphrase while the tab is open. Mitigation:

- Strict CSP already documented in ADR-0049 (no inline scripts, no `eval`, font and worker sources locked).
- The plaintext passphrase lives **only** inside the editing tab and is zeroed on blur or navigation away; it is never persisted to `localStorage`, `sessionStorage`, or `IndexedDB`.

The trade-off is therefore accepted under the explicit security model that the hosted UI is a convenience surface, not a hardened secrets vault. Long-term secrets work (hardware tokens, WebAuthn PRF, local KEK cache) is explicitly scoped to Phase-2/3.

## Implementation phases

**Phase 1** (immediate)
- Ship `age-encryption` browser bundle with single-layer scrypt match.
- Plaintext-passphrase-in-memory model.
- End-to-end parity test: encrypt fixture with Node CLI, decrypt same blob in real browser using identical package.
- Verify against c2sp.org/age official test vectors.

**Phase 2** (next)
- Add optional Argon2id-derived KEK layer using `argon2-browser`.
- Introduce WebAuthn PRF for KEK persistence (no plaintext passphrase survives reload).
- Retain Phase-1 path for backward compatibility.

**Phase 3** (later)
- Hardware-token identities (FIDO2 / YubiKey) via WebAuthn `largeBlob` or `prf` extensions.

## Verification gates

Phase 1 must pass a Playwright test that:
1. Uses the real Node CLI (`am secrets encrypt`) to produce an age envelope.
2. Loads the envelope in a headless Chromium instance served from the bundled UI.
3. Executes `new Decrypter().addPassphrase(...)` + `decrypt()` using the exact same passphrase and `age-encryption` package.
4. Asserts byte-for-byte plaintext match and also successfully decrypts the canonical age test vectors published at c2sp.org/age.

Any failure blocks promotion of the browser UI to stable.

## Cross-references

- ADR-0042 — Universal Secrets Strategy (master). ADR-0050 ratifies the §3 browser-decrypt path; ADR-0042's verification gates remain unchanged.
- ADR-0049 — CSP & web security headers
- ADR-0046 — Passphrase rejection rationale (why no team passphrases)
- Lens H + Lens H-clarification (2026-05-05-deep-loop research loop)
- Lens A — browser-secrets breadth survey
- `src/core/secrets-age.ts` — authoritative CLI decrypt implementation

---

Status: accepted 2026-05-05 (amends ADR-0042 gate 1).