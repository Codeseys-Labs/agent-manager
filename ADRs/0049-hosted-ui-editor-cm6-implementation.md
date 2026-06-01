---
status: proposed
note: plan-only, code not yet landed
date: 2026-05-05
accepted: 2026-05-05
amends: ADR-0045
---

# ADR-0049: Hosted UI Editor CodeMirror 6 Implementation Plan

## Context

ADR-0045 established CodeMirror 6 (CM6) as the underlying engine for the Agent Manager Hosted UI configuration editor, explicitly rejecting Monaco. This decision (ADR-0049) formally defines the implementation mechanics, dependencies, boundaries, and validation criteria for that editor, synthesizing research from Lens G v2.

The implementation is bound by the architecture outlined in ADR-0043 (which governs the capability tiers and overall auth/access models) and ADR-0048, and must adhere to tight bundle size constraints.

## Decision

The following concrete technical choices dictate the Phase-1 implementation of the Hosted UI editor:

### 1. Language Pack
We adopt `@codemirror/legacy-modes/mode/toml` (v6.5.2 or compatible within the 6.x line) for syntax highlighting.

### 2. Editor Bundle Limits
The Phase-1 editor bundle is budgeted at a maximum of 300 KB gzipped. Research indicates the baseline CM6 setup plus necessary extensions will compress to approximately 172 KB gzipped.

### 3. Editor Mount Point
The editor will initialize on a dedicated, explicit route: `GET /edit/:path*`.
It will **not** be mounted under or merged with the authentication routes (`/auth/:provider/login`).

### 4. Linting Architecture
File validation and linting will execute off the main thread in a dedicated Web Worker. This worker runs the Agent Manager Zod schemas (`ConfigSchema`) against the editor contents, debounced at 300ms.

### 5. Drift and Diff View
To fulfill ADR-0006 drift detection UI requirements, we adopt `@codemirror/merge@^6.10.0`.
- Standard drift comparison between native state and managed state utilizes standard, side-by-side `MergeView`.
- Inline, smaller deltas and "show original" toggles utilize `unifiedMergeView`.

### 6. Security Header Mechanics (SRI and CSP)
The build pipeline will enforce Subresource Integrity (SRI). A custom Bun plugin or CI script will inject `integrity="sha384-..."` attributes on the editor JS bundle load.

Content Security Policy (CSP) will lock down execution:
```http
script-src 'self' 'sha384-<editor-bundle-hash>' 'sha384-<lint-worker-hash>';
worker-src 'self';
style-src 'self' 'unsafe-inline';
```

## Rationale

- **Language Pack**: `@codemirror/legacy-modes/mode/toml` is first-party, maintained by the official `codemirror` organization, and represents a much smaller dependency footprint than WASM-backed Tree-sitter approaches or sparse community packages. Structural validation is deferred to our Zod routines, lessening the burden on the grammar parser itself.
- **Web Worker Linting**: Heavy schema validation on every keystroke risks main-thread UI jank, especially on underpowered devices. A worker isolates Zod execution entirely.
- **Mount Point Separation**: Mixing application editing routes with OAuth callback routes violates separation of concerns. Dedicating `/edit/:path*` keeps the routing cleanly separated between capability boundaries (view/edit vs. authenticate).

## Trade-offs

- **iOS Safari Workarounds**: CM6 has intermittent known issues with the virtual keyboard on long documents breaking selection/scroll. This is a documented Phase-1 caveat.
- **CSP `unsafe-inline` Styles**: CM6 injects styles dynamically via JS (`Element.style`). Consequently, `style-src 'unsafe-inline'` is necessary, slightly weakening the CSP compared to a pure nonce-based CSS approach.
- **Coarse Lint Diagnostics**: Phase-1 ships with file-level diagnostics from the Zod worker rather than precise, character-level source-range mapping. If a TOML key fails validation, the error highlights the entire document rather than the specific problematic key. This accelerates shipping.

## Implementation phases

### Phase 1 (Immediate Scope)
- Dedicated mount route and read-only skeleton (`GET /edit/:path*`).
- Main editor bundle integration (< 300 KB gzipped) and schema-lint Web Worker wiring.
- Side-by-side drift display (`MergeView`) integration.
- Tooling: `bun build --integrity` integration and CSP enforcement.

### Phase 2 (Future Scope)
- Source-range diagnostics (mapping Zod schema paths to precise TOML line/column extents).
- Schema-driven, deep autocomplete (completing nested keys rather than just top-level keys).
- Mobile UX polish addressing edge-case virtual keyboard issues.

## Verification gates

Phase 1 cannot be marked complete without passing the following:

- **Integration**: 5 Playwright tests covering load, edit, lint-error display, drift view, and top-level schema-key autocomplete (the "deep autocomplete" — schema-driven nested completion — is Phase-2). Tests live at `test/e2e/editor.spec.ts`.
- **Unit**: 3 unit tests verifying the lint worker's Zod parsing and diagnostic payload shaping. Tests at `test/web/lint-worker.test.ts`.
- **Security**: CSP header presence validation in CI. Expected header includes `script-src 'self' 'sha384-<editor-bundle>' 'sha384-<lint-worker>'` and `worker-src 'self'`.
- **Performance**: CI step measures gzipped size of `dist/web/assets/editor.[hash].js` and fails the build if > 300 KB.
- **SRI integrity**: CI rejects deployments where the SRI hash embedded in the HTML shell template doesn't match the actual bundle (atomic-build invariant).
- **Graceful degradation**: a textarea fallback renders when JS fails / is disabled (read-only acceptable). Asserted by a Playwright test that disables JS.

Source files for Phase 1 (named explicitly so a subagent can find them):
- `src/web/public/editor/Editor.ts` — EditorView factory + extensions
- `src/web/public/editor/lint-worker.ts` — Web Worker wrapping `ConfigSchema`
- `src/web/public/editor/index.html` — shell with skeleton textarea
- `src/web/server.ts` / `src/web/worker.ts` — new routes `GET /edit/:path*`, `GET /api/files/:path`, `POST /api/files/save`, `GET /drift/:adapter`

## Cross-references

- [ADR-0043 hosted UI auth + git backend tiers](0043-hosted-ui-auth-and-git-backend-tiers.md)
- [ADR-0045 hosted UI editor CodeMirror choice](0045-hosted-ui-editor-codemirror.md) (this ADR amends 0045)
- [ADR-0048 hosted UI auth implementation](0048-hosted-ui-auth-implementation.md)
- [Lens G v2 research](../docs/research/2026-05-05-deep-loop/lens-G-adr-0045-cm6-impl.md) (concrete bundle architecture, package selection, code sketches, risk register)
- Bundlephobia size baselines: [codemirror/view](https://bundlephobia.com/package/@codemirror/view), [codemirror/lang-yaml](https://bundlephobia.com/package/@codemirror/lang-yaml)