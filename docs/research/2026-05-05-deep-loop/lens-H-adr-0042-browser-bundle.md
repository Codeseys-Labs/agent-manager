# Lens H: ADR-0042 Browser-Decrypt Bundle Pipeline + WASM Library Survey

**Date:** 2026-05-05
**Author:** Hermes Agent (sub-task on universal secrets)
**Scope:** Research only — no source modifications. Covers browser decrypt path for hosted UI as required by ADR-0042 §3 and verification gates. Primary constraints: Worker never sees KEK/plaintext; decrypt parity with `src/core/secrets-age.ts`; total browser bundle (< WASM + JS) < 500 KB gzipped.

## 1. Findings

### 1.1 age-encryption Landscape (2026)

- **Canonical package**: `age-encryption` (npm: `age-encryption@^0.3.0`; JSR: `@age/age-encryption`).
  - Maintainer: FiloSottile (spec author) via https://github.com/FiloSottile/typage.
  - Pure-TypeScript/ESM implementation using `@noble/ciphers`, `@noble/curves`, `@noble/hashes`, `@scure/base`.
  - Supports full age spec: X25519 recipients, scrypt passphrase identities (`identity.age` files), armor, multi-recipient.
  - Bundle size: noble libs are extremely small (total runtime after tree-shaking ~80-120 KB minified, gzipped <40 KB). No heavy WASM by default; optional acceleration paths exist but not required.
  - CLI interop plugin also ships; direct parity with Go `age` and Rust `rage` proven via test vectors (c2sp.org/age).

- **Format compatibility with CLI** (`src/core/secrets-age.ts`):
  - CLI identity storage uses `age-encryption`'s `Encrypter.setPassphrase()` → produces standard age scrypt-wrapped `identity.age`.
  - Browser decrypt MUST implement exactly the same scrypt recipient unwrap for the passphrase-encrypted identity file.
  - `age-encryption` already exposes `Decrypter` + `identityToRecipient` + passphrase support.
  - **No format adaptation needed**. The browser path re-uses the exact same on-disk `identity.age` (scrypt-based). Argon2id parameters in codebase are future/planned for a separate per-identity KEK wrapper layer, not the identity file itself.

- **Alternatives surveyed**:
  - `tfio-age`, `js-age`, `@cypherbridge/age`: No active 2025-2026 maintenance or spec parity in public results.
  - `age-wasm` (mentioned in SECURITY.md): Older/experimental; superseded by the official `age-encryption` TypeScript port.
  - Decision: Stick with `age-encryption` as the single dependency for both CLI and browser (shared code surface).

### 1.2 argon2-browser Status (2026)

- **Primary package**: `argon2-browser` (antelle/argon2-browser, v1.18.0).
  - Last significant activity: 2024-2025 (stable). Widely adopted; referenced in SECURITY.md and Lens A.
  - WASM build of Argon2id (and Argon2d/i variants). SIMD variant (`argon2-simd.wasm`) available for supported browsers.
  - Security: No reported vulnerabilities post-2024; follows RFC 9106 + OWASP guidance. Audits exist indirectly through downstream password-manager usage (1Password, Bitwarden patterns referenced in Lens A).

- **WebAssembly threading / shared memory**:
  - Parallelism (`p`) requires `WebAssembly.Memory({ shared: true })`.
  - Modern browsers support this only under **cross-origin isolation** (COOP + COEP headers).
  - Without isolation: library falls back gracefully to single-threaded execution.

- **Cross-origin isolation for Cloudflare Worker hosting**:
  - Required headers (in Worker response or Pages `_headers` file):
    ```
    Cross-Origin-Opener-Policy: same-origin
    Cross-Origin-Embedder-Policy: require-corp
    ```
  - Additional CORP headers on static assets (`Cross-Origin-Resource-Policy: cross-origin` for WASM).
  - ADR-0043 / hosted UI will need to serve the bundle with these headers (or document the requirement for self-hosted Workers).

- **Alternatives if stale**:
  - `hash-wasm`: Pure WASM alternative, actively maintained.
  - Pure-JS Argon2: Avoided (performance penalty on mobile).
  - Decision: Retain `argon2-browser`; fallback to `hash-wasm` if 2026 update is missing. Both < 150 KB gzipped.

### 1.3 WebCrypto / X25519 Story

- **Native support (2026)**: X25519 (and Ed25519) now part of official Web Cryptography API.
  - Chrome/Edge, Firefox, Safari 17+ ship stable implementations.
  - `crypto.subtle.deriveKey({ name: "X25519" })` is usable for raw key agreement.
  - However, **full age protocol construction** (stanza format, HKDF chaining, ChaCha20-Poly1305 payload) is not exposed by WebCrypto.
  - Conclusion: Noble-based `age-encryption` still required for the complete age envelope. WebCrypto X25519 can be used as an internal acceleration hook inside noble if desired, but not mandatory for Phase-1.

- **ChaCha20-Poly1305**: Fully covered by WebCrypto (`AES-GCM` preferred by browsers but `ChaCha20-Poly1305` polyfill in noble is constant-time and tiny).

### 1.4 Browser KEK Persistence & Passkeys

- **Recommended flow** (consistent with Lens A):
  1. User enters master passphrase.
  2. `argon2-browser` derives 32-byte KEK (Argon2id parameters pulled from committed config for parity).
  3. KEK used once to unwrap the local `identity.age` (scrypt via age-encryption).
  4. Decrypted age identity cached for the session.

- **Persistence**:
  - Preferred: IndexedDB + `navigator.credentials.create({ publicKey: ... })` (WebAuthn / Passkey) to wrap the KEK.
    - Uses `publicKey: { rp, user, pubKeyCredParams: [{ alg: -7 or -257 }], authenticatorSelection, attestation: "none" }`.
    - Passkey stored in OS/hardware; biometric re-unlock (TouchID/FaceID/Windows Hello) unwraps the IndexedDB KEK entry.
  - Fallback: Direct AES-GCM-protected entry in IndexedDB (less ideal, no biometric).
  - Threat model difference:
    - Passkey: Hardware-bound, phishing-resistant, survives tab close / browser restart (until credential is deleted).
    - Direct IndexedDB KEK: Survives restart but vulnerable to same-origin script exfil if XSS occurs.
  - Session behavior: In-memory decrypted identity cleared on tab close. Persisted (wrapped) copy re-prompts only on new biometric challenge or expiry policy (configurable 24h default).

- **30-second click-to-reveal auto-lock** and explicit "lock" button are UI mitigations (ADR-0043).

### 1.5 Build Pipeline Recommendations (2026)

- **Bundler choice**: 
  - Bun bundler (preferred) or esbuild both handle WASM imports cleanly via `import wasm from "./argon2.wasm"` (asset or base64) and dynamic `WebAssembly.instantiate`.
  - Rollup requires `@rollup/plugin-wasm` or URL plugin; more friction.
  - Recommendation: Use Bun for the hosted-UI build step (already primary in repo via bun.lock).

- **Output target**:
  - Single ES2022 bundle for simplicity (or two-chunk: core UI + crypto chunk).
  - Gzip + Brotli on Worker static assets.
  - Target total (UI + age-encryption + argon2-browser WASM + noble) < 450 KB gzipped after tree-shaking.

- **SRI + CSP + Supply-chain**:
  - Compute SHA-384 SRI hash for every emitted `.wasm` and `.js` chunk at build time; embed in `<script integrity="...">` and Worker response headers.
  - Strict CSP: `default-src 'self'; script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'; worker-src 'self';`
  - SLSA provenance (already planned per ADR-0042 gate) on Worker build artifacts.
  - Pin exact versions + hash in `bun.lock` / lockfile.

### 1.6 Test Strategy

- **Parity testing (must-have)**:
  - End-to-end: Run `am secrets encrypt ...` (Node/Bun CLI → age-encryption) on fixture secrets.
  - Serve identical repo via Cloudflare Worker preview.
  - Use Playwright to drive browser, exercise passphrase → argon2 KEK → scrypt identity unwrap → value decryption.
  - Assert plaintext matches across CLI vs. browser for all edge cases (multi-recipient, legacy `enc:v1:`, armored, large values).

- **Unit testing without real browser**:
  - jsdom insufficient (missing full WebCrypto + WASM threading).
  - Use `@vitest/browser` with real Chrome/Firefox headless via Playwright or WebdriverIO.
  - Isolate crypto: unit-test argon2 derivation and age envelope unwrap in worker context where possible.

- **Stress / mobile**:
  - Test high `memoryKiB` (128 MiB) Argon2id on low-end Android emulator.
  - Verify graceful single-thread fallback when COOP/COEP headers absent.

- **Regression gate**: Any change to `src/core/secrets-age.ts` Argon2id params or identity format triggers full browser parity suite.

## 2. Concrete Bundle Recipe

1. **Dependencies** (browser bundle only):
   ```json
   {
     "argon2-browser": "^1.18.0",
     "age-encryption": "^0.3.0"
   }
   ```

2. **Worker header injection** (Cloudflare):
   ```ts
   response.headers.set("Cross-Origin-Opener-Policy", "same-origin");
   response.headers.set("Cross-Origin-Embedder-Policy", "require-corp");
   ```

3. **Minimal usage sketch** (hosted UI):
   ```ts
   import argon2 from "argon2-browser";
   import * as age from "age-encryption";

   const keccak = await argon2.hash({
     pass: passphrase,
     salt: userSalt,
     time: 3,
     mem: 131072,
     parallelism: 1, // or 4 with COOP/COEP
     hashLen: 32
   });
   const identityBytes = await readIdentityAgeFile(); // from Worker proxy
   const dec = await new age.Decrypter().addIdentityFromPassphrase(keccak /* or direct scrypt if reusing identity.age */);
   const secret = await dec.decrypt(new TextDecoder().decode(identityBytes));
   ```

   (Note: For identity.age the primary unwrap is age scrypt; argon2 KEK derived value protect a higher-level cache.)

4. **Bundle size budget**:
   - argon2.wasm (gzipped): ~80 KB
   - age-encryption + noble deps (min + gzipped): ~35 KB
   - Hosted UI framework + CodeMirror chunk: < 300 KB remaining
   - Total target: < 500 KB

## 3. Test Strategy (Expanded)

- **Automated pipeline**:
  - GitHub Actions matrix: Linux + Playwright + Chrome/Firefox.
  - Fixture repo generation: seed with known encrypted values + `identity.age`.
  - Snapshot comparison of decrypted output vs. golden file.

- **Manual gate**:
  - Hosted UI preview link in every PR touching secrets.
  - Browser devtools: confirm no KEK ever leaves memory → Network tab zero plaintext; IndexedDB shows only ciphertext.

## 4. Phase-1 Scope

**Phase-1 MVP (acceptance for ADR-0042 gate)**:
- `age-encryption` + `argon2-browser` vendored into hosted UI bundle.
- Passphrase → KEK derivation + age identity unwrap (scrypt) + single-value decryption demo.
- Passkey-wrapped IndexedDB persistence with 30-second auto-lock UX.
- COOP/COEP headers + SRI + CSP on Worker.
- Playwright parity test (CLI encrypt ↔ browser decrypt) green on main.
- Bundle size < 500 KB measured on CI.

**Deferred**:
- Full multi-recipient editing, rewrap UX, Shamir recovery.
- Argon2id parallelism > 1 in production until Worker headers stabilized.
- Post-quantum hybrid identities (noble already has hooks).

**Risks & Mitigations**:
- Performance on mobile: benchmark `memoryKiB=131072` — downgrade to 64 MiB tier if needed.
- Supply chain: exact-hash pin + provenance attestation (SLSA level 2 target).

---

**References**
- ADR-0042 §3 (browser decrypt spec)
- `src/core/secrets-age.ts` (identity.age format & Argon2id interface)
- Lens A: `docs/research/2026-05-05-deep-loop/lens-browser-secrets.md`
- age spec: https://age-encryption.org/v1
- argon2-browser: https://github.com/antelle/argon2-browser
- age-encryption TS: https://github.com/FiloSottile/typage
- Web.dev cross-origin isolation: https://web.dev/articles/why-coop-coep
- c2sp.org age test vectors