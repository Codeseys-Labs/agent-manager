# Research Output: Lens G - ADR-0045 CodeMirror 6 Implementation

## Findings

### Bundle Architecture & Delivery
CodeMirror 6 addresses the core size limitation of Monaco identified in ADR-0045. CM6 adopts a modular, tree-shakeable architecture centered around `@codemirror/state` and `@codemirror/view`. By only selectively importing required packages (`@codemirror/commands`, `@codemirror/search`, etc.), the bundle size drops significantly.

However, delivering CM6 from Cloudflare Workers introduces constraints. Standard CF Worker deploy processes (wrangler/esbuild) optimize for server-side code without native code-splitting out-of-the-box (though upcoming Wrangler updates improve dynamic imports). The optimal strategy is to build CM6 as an independent static asset (`editor.[hash].js`) mapping directly into the free-tier Worker asset bucket using Cloudflare's *Static Assets for Workers* which allows caching of standard HTML/JS frontends up to 100K files.
Dynamic imports from external CDNs (esm.sh) violate ADR-0045 §3 (SRI pinning/CSP rules).

### TOML Support
The ecosystem for CM6 TOML is fragmented but converging. There is no official first-party `@codemirror/lang-toml` package yet spanning version 6.12+. However, robust community implementations like `sgarciac/cm-toml-mode` or bridging `tree-sitter-toml` exist. Since `agent-manager` needs schema validation, we will couple a simple syntax highlighting mode with a Web Worker based linter leveraging Zod running within the host application.

### Diff View (Drift Detection)
`@codemirror/merge` provides diff side-by-side or unified merge views. Version 6.12+ features an efficient unified diff. A known issue exists on large inputs doing pure char-diffing, but config files are <200 LOC, easily managed. The merge extension is vital for am's drift detection display during remote editing.

### Testing strategy: Playwright vs. Vitest
Vitest Browser Mode and Playwright are both modern options, but CM6 relies extensively on complex DOM measurements and internal shadow elements to render correctly.
Vitest (with React Testing Library/JSDOM) often produces incredibly flaky snapshot tests against CodeMirror due to simulated layout measurements varying.
**Playwright Component Testing** (or pure E2E via Playwright) executing against a real rendering engine is essential. Avoid deep DOM snapshots; test by simulating keystrokes (`page.keyboard.type()`) and verifying surface-level UI/accessibility markers (`page.getByRole()`).

## Concrete bundle recipe
- Package `@codemirror/state`
- Package `@codemirror/view`
- Package `@codemirror/commands` (basic keymaps)
- Package `@codemirror/lint` (hooks to Zod validation)
- Extraneous packages stripped (e.g. no markdown, generic JS/TS modes).
- Build target: `editor.[hash].mjs`, loaded via `<script type="module" integrity="sha384-...">`.

## Test strategy
Playwright tests asserting UI render and typing behavior. Do not snapshot the internal CM6 DOM structure.

## Phase-1 scope
1. Implement the modular CodeMirror `Editor` React component integrating the Zod linter over a Web Worker.
2. Stub out syntax highlighting with a basic TOML legacy mode or minimalist community port pending tree-sitter WASM inclusion.
3. Replace the Monaco reference in `/auth/:provider/login` or wherever the frontend mounts.