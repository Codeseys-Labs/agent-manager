# Wave R — ADR-0049 Phase-1 CodeMirror Editor Mount

**Status:** ready-to-execute (plan only; no code in this doc)
**Source ADRs:** [0049](../../ADRs/0049-hosted-ui-editor-cm6-implementation.md), [0045](../../ADRs/0045-hosted-ui-editor-codemirror.md)
**Source research:** [Lens G v2](../research/2026-05-05-deep-loop/lens-G-adr-0045-cm6-impl.md)
**Estimated total:** 5 sub-tasks, ~1200 LOC, ~$8-10 OpenRouter cost at 3-way parallel
**Dependency:** Wave R **depends on Wave Q** for the bundle pipeline (Wave Q's worker.ts exposes static asset routing). Wave R cannot ship before Wave Q.

## Goal

Ship a working CodeMirror 6 editor on the Cloudflare Workers stateless web UI that lets users view and edit Agent Manager configuration files. The editor integrates `@codemirror/legacy-modes/mode/toml`, uses a Web Worker to run Zod schema linting off the main thread, and includes a split-pane `MergeView` for drift visualization. It mounts on a dedicated `/edit/:path*` route and communicates with the backend via the session mechanism established in Wave Q.

## Non-goals

Wave R does NOT solve:
- Source-range diagnostics (precise line/column mapping from Zod errors; Phase-1 highlights the whole document)
- Schema-driven deep autocomplete (nested key completion; Phase-1 only provides top-level schema keys)
- Mobile UX polish addressing known iOS Safari virtual keyboard edge cases
- Multi-user concurrent editing (OT/CRDT)
- Browser-side secret decryption (Wave S)

## Acceptance criteria (test-first, executable)

Each test names the file + describe + it. All must pass to call Wave R done.

1. `test/e2e/editor.spec.ts` `describe("editor load")`:
   - `it("mounts CM6 and loads backend file content")`
   - `it("renders a textarea skeleton fallback when JS is disabled")`

2. `test/e2e/editor.spec.ts` `describe("editor actions")`:
   - `it("lint error displays as whole-file diagnostic when Zod fails")`
   - `it("top-level schema key autocomplete suggests valid keys")`
   - `it("drift view loads and renders side-by-side MergeView")`

3. `test/web/lint-worker.test.ts` `describe("lint worker")`:
   - `it("returns empty array for valid TOML config")`
   - `it("returns root-level diagnostic for malformed TOML")`
   - `it("returns root-level diagnostic for schema violation")`

Total: 8 acceptance tests across 2 test files.

## File-ownership map

Five sub-tasks. R1 has no deps; R2-R5 depend on R1. Run R1 alone first, then R2-R5 in parallel.

### R1 — Bundle setup + SRI hashing (~300 LOC, deps: none)

**Owns:**
- Build scripts (e.g., `scripts/build-editor.ts`) leveraging Bun's Bundler.
- `src/web/public/editor/index.html` template modifications to accept injected hashes.
- Utilities to generate SHA-384 Subresource Integrity (SRI) hashes and content-hashed filenames.
- Integration tests simulating the build pipeline and asserting SRI hash inclusion.

### R2 — Editor core + Lint worker (~600 LOC, deps: R1)

**Owns:**
- `src/web/public/editor/Editor.ts` — CodeMirror initialization, extensions (`@codemirror/legacy-modes/mode/toml`, base extensions), and `MergeView` plumbing.
- `src/web/public/editor/lint-worker.ts` — Web worker listening for `message` events, applying `ConfigSchema` to debounced text, and posting back diagnostics.
- `test/web/lint-worker.test.ts` — 3 unit tests.

### R3 — Server routes + API integration (~400 LOC, deps: R1)

**Owns:**
- Add `GET /edit/:path*` route returning the HTML shell.
- Implement `POST /api/files/save` route for saving edits to the repo via installed GitHub app (reusing Wave Q capabilities).
- Implement `GET /drift/:adapter` API for pulling native vs. managed state.
- Integration tests ensuring routes are mounted and handle valid/invalid inputs using the mock fetch infrastructure.

### R4 — HTML shell + Skeleton fallback (~330 LOC, deps: R1)

**Owns:**
- `src/web/public/editor/index.html` layout refinement.
- `<noscript>` or JS-failure textarea fallback styling and functionality.
- Playwright tests (`test/e2e/editor.spec.ts`) for skeleton fallback functionality and initial mount verifications.

### R5 — CSP Headers + Security integration (~150 LOC, deps: R1)

**Owns:**
- Injecting appropriate Content Security Policy headers on the `/edit` route response.
- `script-src 'self' 'sha384-...'`, `worker-src 'self'`, `style-src 'self' 'unsafe-inline'`.
- Integration test validating header presence and structure.

## Risks + rollback

| Risk | Likelihood | Impact | Mitigation / rollback |
|------|------------|--------|-----------------------|
| Bundle > 300 KB gzipped | Med | Build fails | Tree-shaking audit; ensure legacy-mode is used vs full WASM parser. |
| iOS Safari keyboard bug | Med | Poor mobile UX | Documented Phase-1 acceptable trade-off (fix in Phase-2). |
| SRI hash drift | Low | White screen (blocked by browser) | Build script atomicity; CI pipeline invariant checks. |
| `unsafe-inline` styles exploited | Low | XSS | CSP restricts scripts strictly via hashes; styles alone have limited attack surface. |

**Rollback plan:** Drop the `/edit` and `/api/files/save` routes from the router. The bundle is inert if not served.

## Budget estimate

- Total LOC: ~1200 (impl) + ~500 (tests) = ~1700 LOC
- Estimated subagent cost: 5 sub-tasks = ~$8-10 in OpenRouter spend
- Wall-clock at 3-way parallel: R1 alone → R2/R3/R4/R5 in parallel = ~2 hours

## Verification gates

Maps directly to ADR-0049 Verification gates:

1. ✅ All 8 acceptance tests pass (5 Playwright `test/e2e/editor.spec.ts`, 3 `test/web/lint-worker.test.ts`).
2. ✅ Security headers: CSP header presence validated in CI.
3. ✅ Performance: CI step verifies `dist/web/assets/editor.[hash].js` < 300 KB gzipped.
4. ✅ SRI integrity: CI rejects mismatched bundle hashes in the HTML shell.
5. ✅ Graceful degradation: textarea fallback renders when JS is disabled.

## Sequencing

```
Round 1 (sequential): R1 (bundle setup, SRI generation)
Round 2 (parallel)  : R2 (Editor.ts+lint-worker.ts), R3 (routes), R4 (HTML shell), R5 (CSP headers)
```