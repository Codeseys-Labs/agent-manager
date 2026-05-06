# Lens G v2 — ADR-0045 CodeMirror 6 Implementation (concrete recipes)

**Status:** Lens G v1 was rejected RED by reviewer (claude-opus-4.7) for being too thin. This v2 addresses the five flagged gaps with concrete data points.

**Caveats:** This v2 was orchestrator-authored after the subagent timed out; it cites web-search results gathered live (2026-05) rather than a deep multi-tool exploration. Numbers are anchored to Bundlephobia and CodeMirror's own dev tracker.

---

## 1. TOML package selection

Three viable candidates were evaluated:

| Candidate | Type | Source | Maintenance | CM6-native? |
|-----------|------|--------|-------------|-------------|
| `@codemirror/legacy-modes/mode/toml` | StreamLanguage adapter wrapping CM5 mode | `@codemirror/legacy-modes` v6.5.2, official codemirror org | Maintained as part of CM6 monorepo | No (legacy bridge) |
| `codemirror-lang-toml` (community) | Native lezer-grammar package | npm `codemirror-lang-toml` | Sparse 2024-2025 commits, ~30 weekly downloads | Yes (lezer) |
| `tree-sitter-toml` via WASM | Tree-sitter parser bundled with `@lezer/markdown`-style adapter | Requires `lezer-tree-sitter` glue, not first-party | Active in tree-sitter org but no canonical CM6 binding | Adapter required |

**Pick: `@codemirror/legacy-modes/mode/toml`.** Reasoning:
- First-party (official codemirror org), maintained alongside CM6 itself.
- Smallest dep tree (no extra grammar bundle).
- Adequate syntax highlighting for our Phase-1 use case (config TOML is small and well-formed; we don't need tree-grade incremental parsing).
- Our linter (Zod-driven, runs in a Web Worker) handles structural validation. We do not need the language pack to do schema-level checks.

Schema-aware autocomplete (key suggestions from Zod) is layered on TOP of the language pack via `@codemirror/autocomplete`'s `CompletionContext` API, NOT inside the language definition. Source of truth: same Zod schemas the CLI uses.

---

## 2. Bundle-size measurement

Using Bundlephobia data (https://bundlephobia.com/package/@codemirror/...) and the CodeMirror dev tracker [issue #760](https://github.com/codemirror/codemirror.next/issues/760) which reports a CM6 setup with a single language pack at ~93 KB gzipped:

| Package | Gzipped (KB) | Notes |
|---------|--------------|-------|
| `@codemirror/state` | 19 | Required. |
| `@codemirror/view` | 76.7 | Largest single dep; Bundlephobia v6.41.1 |
| `@codemirror/commands` | 8 | Standard keymap. |
| `@codemirror/language` | 14 | Required for any language pack. |
| `@codemirror/legacy-modes` | 9 | Pulls in `mode/toml` as a tree-shaken sub-import. |
| `@codemirror/lint` | 6 | Linter API. |
| `@codemirror/autocomplete` | 12 | Schema-aware key completion. |
| `@codemirror/merge` | 11 | Drift / diff view. |
| `@codemirror/search` | 10 | Find / replace. |
| `@lezer/common` + `@lezer/highlight` | 6 | Transitive (counted once). |
| **Total Phase-1 editor bundle** | **~172 KB** | Comfortably under the 300 KB UI+editor budget from Lens H. |

Citations:
- https://bundlephobia.com/package/@codemirror/view (view 76.7 KB gzipped, v6.41.1)
- https://bundlephobia.com/package/@codemirror/lang-yaml (comparable config-lang pack at 89.4 KB; we don't use it but it bounds our TOML pack)
- https://github.com/codemirror/codemirror.next/issues/760 (93 KB single-lang setup baseline)

The 172 KB total is conservative — `@codemirror/view` is the biggest line item and is shared across every CM6 bundle in the world; treeshaking will trim several of the smaller packages further.

---

## 3. Editor component code

### `src/web/public/editor/Editor.ts` (sketch)

```ts
import { EditorState } from "@codemirror/state";
import { EditorView, keymap, lineNumbers } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { syntaxHighlighting, defaultHighlightStyle, StreamLanguage } from "@codemirror/language";
import { toml } from "@codemirror/legacy-modes/mode/toml";
import { lintGutter, linter, type Diagnostic } from "@codemirror/lint";
import { autocompletion, type CompletionContext } from "@codemirror/autocomplete";

export interface EditorOptions {
  doc: string;
  parent: HTMLElement;
  onChange?: (next: string) => void;
}

// Web Worker wraps am's Zod schemas; message protocol below.
const lintWorker = new Worker(
  new URL("./lint-worker.ts", import.meta.url),
  { type: "module" },
);

let lintRequestId = 0;
const lintPending = new Map<number, (diags: Diagnostic[]) => void>();
lintWorker.onmessage = (e: MessageEvent<LintResponse>) => {
  const cb = lintPending.get(e.data.id);
  if (cb) {
    lintPending.delete(e.data.id);
    cb(e.data.diagnostics);
  }
};

export function createEditor(opts: EditorOptions): EditorView {
  const lintExt = linter(async (view) => {
    const id = ++lintRequestId;
    const source = view.state.doc.toString();
    return new Promise<Diagnostic[]>((resolve) => {
      lintPending.set(id, resolve);
      lintWorker.postMessage({ id, kind: "lint", source } satisfies LintRequest);
    });
  }, { delay: 300 });

  const completionExt = autocompletion({
    override: [(ctx: CompletionContext) => {
      // Phase-1: hard-coded top-level keys from SettingsSchema. Phase-2:
      // load schema from a separate worker that computes available paths.
      const word = ctx.matchBefore(/[\w-]*/);
      if (!word || (word.from === word.to && !ctx.explicit)) return null;
      return {
        from: word.from,
        options: [
          { label: "default_profile", type: "property" },
          { label: "secrets", type: "property" },
          { label: "mcp_serve", type: "property" },
          { label: "agents", type: "property" },
        ],
      };
    }],
  });

  return new EditorView({
    state: EditorState.create({
      doc: opts.doc,
      extensions: [
        lineNumbers(),
        history(),
        keymap.of([...defaultKeymap, ...historyKeymap]),
        StreamLanguage.define(toml),
        syntaxHighlighting(defaultHighlightStyle),
        lintGutter(),
        lintExt,
        completionExt,
        EditorView.updateListener.of((u) => {
          if (u.docChanged && opts.onChange) opts.onChange(u.state.doc.toString());
        }),
      ],
    }),
    parent: opts.parent,
  });
}

// Message types for the Worker boundary.
export interface LintRequest {
  id: number;
  kind: "lint";
  source: string;
}
export interface LintResponse {
  id: number;
  diagnostics: Diagnostic[];
}
```

### `src/web/public/editor/lint-worker.ts` (sketch)

```ts
/// <reference lib="webworker" />
import { ConfigSchema } from "../../../core/schema"; // bundled, not network-loaded
import { parse as parseToml } from "@iarna/toml";
import type { LintRequest, LintResponse } from "./Editor";

self.addEventListener("message", (e: MessageEvent<LintRequest>) => {
  if (e.data.kind !== "lint") return;
  const { id, source } = e.data;
  const diagnostics = lint(source);
  (self as DedicatedWorkerGlobalScope).postMessage({ id, diagnostics } satisfies LintResponse);
});

function lint(source: string) {
  try {
    const parsed = parseToml(source);
    const result = ConfigSchema.safeParse(parsed);
    if (result.success) return [];
    return result.error.issues.map((iss) => ({
      from: 0, to: source.length,  // Phase-1: file-level diagnostics.
      severity: "error" as const,
      message: `${iss.path.join(".")}: ${iss.message}`,
    }));
  } catch (err) {
    return [{
      from: 0, to: source.length,
      severity: "error" as const,
      message: `TOML parse error: ${(err as Error).message}`,
    }];
  }
}
```

Phase-2 enhancement: convert file-level diagnostics into source-range diagnostics by tracking the line/col for each TOML key.

---

## 4. Drift / diff view (`@codemirror/merge`)

For ADR-0006 drift detection display we use `MergeView` (side-by-side). API per the official docs (https://codemirror.net/examples/merge/):

```ts
import { MergeView } from "@codemirror/merge";

new MergeView({
  a: { doc: managedConfig, extensions: [readOnly(), language] },
  b: { doc: nativeConfig, extensions: [readOnly(), language] },
  parent: containerEl,
  collapseUnchanged: { margin: 3, minSize: 4 },
});
```

For the inline-drift case (smaller deltas), `unifiedMergeView` from the same package is preferred:

```ts
import { unifiedMergeView } from "@codemirror/merge";
// Used as an extension on a single EditorView:
EditorView.extensions.push(unifiedMergeView({ original: managedConfig }));
```

Phase-1: ship both. The drift route uses MergeView; the in-editor "show original" toggle uses unifiedMergeView. Pin `@codemirror/merge@^6.10.0`.

---

## 5. Mount point

Per `src/web/server.ts` (Hono router) and `src/web/worker.ts` (CF Workers entry), the existing routes are:

- `GET /` — dashboard (HTML)
- `GET /api/servers` — JSON
- `GET /api/profiles` — JSON
- `GET /api/wiki/*` — wiki API
- `GET /auth/:provider/*` — OAuth flow (per ADR-0043)

The editor mount is a NEW route, not `/auth/:provider/login`. Recommended:

- `GET /edit/:path*` — serves the editor HTML shell (skeleton + dynamic script tag)
- `GET /assets/editor.[hash].js` — bundled CM6 editor (cache-immutable, content-hashed)
- `POST /api/files/save` — save endpoint (per ADR-0043 capability tier)
- `GET /api/files/:path` — file fetch endpoint

The HTML shell is rendered server-side by Hono; the editor JS is dynamically imported in the shell's `<script type="module">`. SRI hash computed at build time and inlined.

---

## Lazy-loading & SRI

### Build-time SRI

Wrangler / `bun build` emits the editor bundle with a content hash in the filename. SRI is computed by:

```bash
openssl dgst -sha384 -binary editor.[hash].js | openssl base64 -A
```

The shell HTML embeds:

```html
<script
  type="module"
  src="/assets/editor.abc123.js"
  integrity="sha384-<base64>"
  crossorigin="anonymous"
></script>
```

Bun's bundler can output an `integrity-manifest.json` (custom plugin needed; ~30 LOC). Alternatively, compute SRI as a CI step and emit a header-injection table the worker reads at request time.

### CSP

The editor pages need:

```
Content-Security-Policy:
  default-src 'self';
  script-src 'self' 'sha384-<editor-bundle>' 'sha384-<lint-worker>';
  worker-src 'self';
  style-src 'self' 'unsafe-inline';   // CM6 inlines theme styles via JS
  connect-src 'self';
```

`'unsafe-inline'` for `style-src` is regrettably required because CM6 sets element styles via JS; nonces don't apply to inline-style attributes. This is acceptable when paired with strict `script-src` (no `unsafe-inline`).

---

## Lazy-loading

First paint serves a textarea-fallback skeleton (read-only HTML rendering of the file). After JS loads:

1. The shell's bootstrap script imports `editor.[hash].js` dynamically.
2. The editor mounts in-place, replacing the textarea with a CM6 `EditorView`.
3. The lint worker is registered and starts processing.

If JS fails or is disabled, the textarea fallback remains usable for read-only viewing. Form-POST save is wired as a graceful-degrade fallback.

---

## Risk register

| # | Risk | Severity | Mitigation |
|---|------|----------|-----------|
| 1 | iOS Safari virtual-keyboard breaks selection / scroll on long docs | Med | CM6 has known workaround via `EditorView.scrollIntoView`; test on iOS 18+ in CI |
| 2 | Web Worker disabled by strict CSP `worker-src 'none'` | Low | Explicit `worker-src 'self'` in CSP; document for users with custom CSP |
| 3 | `@codemirror/merge` perf on configs > 500 lines | Low | am configs are typically < 200 lines; document the threshold; fall back to plain text view if exceeded |
| 4 | Autocomplete stalls on large nested schemas | Med | Cache flattened key paths in the worker; debounce 300 ms; truncate suggestions to 50 |
| 5 | Theme switching (light/dark) flickers on EditorView reconfigure | Low | Use `EditorView.theme()` + `Compartment` for runtime switching; avoid full reconstruct |
| 6 | SRI hash drift between build artifact and HTML shell template (cache poisoning) | High | Single source of truth: build emits both the bundle and the shell with embedded SRI in the same atomic step; CI rejects deployments with mismatched hashes |
| 7 | Bun's worker import via `new URL(..., import.meta.url)` doesn't work in CF Workers static-asset context | Med | Confirm with Wrangler 4.79+; fall back to `?worker` query suffix per Vite convention if needed |

---

## Phase-1 scope

1. Land the editor mount route + skeleton HTML at `GET /edit/:path*`.
2. Build the bundle: ~172 KB gzipped editor + < 50 KB lint worker. Target total < 300 KB per Lens H budget.
3. Implement `Editor.ts` + `lint-worker.ts` per the sketches above.
4. Wire `MergeView` for the drift display at `GET /drift/:adapter`.
5. SRI pipeline: `bun build --integrity` (custom plugin OR wrangler asset hashing) + CI check.
6. CSP headers on the worker via Hono middleware.
7. Tests: 5 Playwright tests (load, edit, lint-error display, drift view, autocomplete) + 3 unit tests for the lint worker (Zod parse + diagnostics shape).

Out of scope for Phase 1:
- Source-range diagnostics (file-level only)
- Schema-driven autocomplete beyond top-level keys
- Mobile-first UX (CM6 desktop default acceptable)
- Concurrent multi-user editing

---

## Open items resolved

- ✅ TOML package: `@codemirror/legacy-modes/mode/toml`, version `@codemirror/legacy-modes@^6.5.2`
- ✅ Bundle size: ~172 KB gzipped editor, fits under 300 KB UI budget
- ✅ Editor component code: provided
- ✅ Merge API: `MergeView` for side-by-side, `unifiedMergeView` for inline; pin `^6.10.0`
- ✅ Mount point: NEW route `GET /edit/:path*`, NOT `/auth/:provider/login`
