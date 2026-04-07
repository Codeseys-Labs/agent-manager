---
tags: [research/agent-manager, packaging/adapters, bun/compile, architecture]
created: 2026-04-07
updated: 2026-04-07
---

# Adapter Packaging Strategy: Built-In vs Side-Loaded

Research into whether a Bun-compiled CLI binary should ship with adapters built-in
(enable/disable via config) or side-load them at runtime. Covers Bun compile
limitations, prior art from Terraform/Caddy/Grafana/Telegraf/ESLint/Tauri, and a
practical recommendation.

---

## Executive Summary

**For a Bun-compiled binary, ship adapters built-in.** Runtime side-loading of
arbitrary TypeScript/JS from a compiled Bun binary is not reliably supported.
The practical path is: bundle all adapters at compile time, gate them via config,
and use a contrib/external adapter model only for edge cases via subprocess IPC
(not dynamic import).

---

## 1. Bun Compile + Dynamic Imports: What Actually Works

### 1.1 Static Imports: Fully Supported

Everything that `bun build --compile` can statically analyze gets bundled into the
single binary. This includes:
- Standard `import` / `require()` statements
- `import()` with **string literal** paths (e.g., `await import("./adapters/claude.ts")`)
- Files referenced via `import ... with { type: "file" }` with literal paths

### 1.2 Dynamic Imports: Partially Broken

Non-statically-analyzable dynamic imports **do not work** in compiled binaries:

```typescript
// WORKS in compiled binary (statically analyzable):
const mod = await import("./adapters/claude.ts");

// BROKEN in compiled binary (non-static path):
const name = "claude";
const mod = await import(`./adapters/${name}.ts`);  // fails at runtime
```

**Key issues documented in Bun's issue tracker:**

- **#11732** (open): Request for `--include` flag to bundle non-statically-analyzable
  dynamic imports. Not yet implemented. Deno solved this with `--include`.
- **#27058** (closed, not planned): Compiled executables cannot resolve external
  modules that weren't bundled. The Bun team considers this by-design.
- **#28042**: `--compile` with dynamic import results in `require_* is not defined`.
- **#6893** (open since 2023): Dynamic import in executable cannot find module.
- **#26653**: Plugin `onLoad` causes transitive dependencies to resolve from real
  filesystem paths at runtime (breaks when those paths don't exist on the target machine).

### 1.3 Code Splitting with --compile: Works But Not for Plugins

Bun supports `--compile --splitting`, which produces a main binary plus chunk files
that the binary loads at runtime:

```bash
bun build --compile --splitting ./src/entry.ts --outdir ./build
# Produces: ./build/entry (binary) + ./build/chunk-*.js
```

However, these chunks are **determined at compile time**. You cannot add new chunks
after compilation. This is code splitting for performance, not a plugin system.

### 1.4 Bun.plugin() API: Build-Time Only

`Bun.plugin()` provides `onResolve` and `onLoad` hooks that intercept module
resolution. These are powerful but:

- They run at **build time** (in the bundler) or at **Bun runtime startup** (via preload)
- They are **not available** inside a compiled binary to load external code
- The plugin API transforms how existing imports are resolved, it doesn't add a
  mechanism to load arbitrary external files from a compiled binary

### 1.5 The Hard Truth

**A `bun build --compile` binary cannot `import()` or `require()` files that
weren't bundled at compile time.** The binary embeds a virtual filesystem; imports
resolve against that VFS, not the real filesystem. External files simply don't exist
in its module graph.

The only way to "load" external code from a compiled binary is:
1. Read the file as text (`Bun.file("./plugin.js").text()`)
2. Dynamically evaluate it (security nightmare, no module semantics)
3. Spawn a subprocess that runs the external code

---

## 2. Terraform's Provider Evolution: The Canonical Migration

### 2.1 The Built-In Era (2014-2017, v0.1 through v0.9)

- All providers shipped inside the `terraform` binary
- ~70 providers by v0.10
- **Problems:**
  - Any provider bug fix required a full Terraform release
  - Release cadence bottleneck: AWS provider changes blocked on Terraform core releases
  - Binary size grew continuously
  - Community contributions were gated by core team release cycles
  - Testing matrix exploded (every provider tested against every core change)

### 2.2 The Split (v0.10, 2017)

- Providers became **separate Go binaries** with independent release cadences
- `terraform init` downloads provider binaries from the registry
- Communication via **gRPC** over the Terraform Plugin Protocol
- Each provider is a standalone executable that Terraform launches as a subprocess

### 2.3 Registry Distribution (v0.13, 2020)

- Community providers could be distributed via the Terraform Registry
- Automatic discovery and download during `terraform init`
- Lock files for reproducible provider versions

### 2.4 Key Lessons for agent-manager

| Terraform lesson | agent-manager implication |
|------------------|--------------------------|
| Built-in providers caused release coupling | Built-in adapters couple adapter updates to CLI releases |
| Separate binaries enabled independent release cadence | Would require adapter authors to compile/distribute binaries |
| gRPC protocol enabled language-agnostic plugins | Overkill for JS/TS adapters |
| Registry solved distribution | agent-manager would need its own registry infrastructure |
| Provider count grew from 70 to 4000+ | agent-manager targets ~10 adapters, not thousands |

**Critical difference:** Terraform has thousands of providers maintained by hundreds
of organizations. agent-manager has ~10 adapters maintained by one team. The
economics that drove Terraform's split don't apply here.

---

## 3. ESLint Flat Config: Import-Time Plugin Loading

### 3.1 How It Works

ESLint's flat config (`eslint.config.js`) loads plugins as **standard JS imports
at config evaluation time**:

```javascript
// eslint.config.js
import jsdoc from "eslint-plugin-jsdoc";

export default [{
  files: ["**/*.js"],
  plugins: { jsdoc },
  rules: { "jsdoc/require-description": "error" }
}];
```

### 3.2 Key Design Decisions

- **No magic resolution:** Plugins are npm packages you `import` directly
- **No naming convention enforcement:** The `eslint-plugin-` prefix is optional
- **Plugins are objects, not strings:** The config file hands ESLint a live object
  with rules, processors, etc.
- **Runtime plugins possible:** You can define a plugin inline without a package:

```javascript
import myRule from "./custom-rules/myrule.js";
export default [{
  plugins: { custom: { rules: { myrule: myRule } } },
  rules: { "custom/myrule": "error" }
}];
```

### 3.3 Implication for Bundled Tools

ESLint itself is **not compiled** -- it runs from node_modules. The flat config model
works because Node.js can resolve npm packages at runtime. For a compiled Bun binary,
this model breaks: there are no node_modules to import from.

**Lesson:** Import-time plugin loading is elegant for interpreted tools but
incompatible with single-binary distribution.

---

## 4. Caddy: Compile-Time Plugin Assembly

### 4.1 Architecture

Caddy is a single, self-contained, statically-linked Go binary with **zero runtime
dependencies**. Its plugin system uses **compile-time assembly**:

- Plugins are Go modules that call `caddy.RegisterModule()` in their `init()` function
- To add a plugin, you **recompile Caddy** with that plugin's import
- The `xcaddy` tool automates this: it creates a temporary Go module, adds your plugin
  imports, runs `go build`, and outputs a custom Caddy binary

```bash
# Build Caddy with two plugins:
xcaddy build \
  --with github.com/caddyserver/nginx-adapter \
  --with github.com/caddy-dns/cloudflare
```

### 4.2 Why No Runtime Loading?

From Caddy's architecture docs:

> "If there's no dynamic linking, then how can it be extended? Caddy sports a novel
> plugin architecture that expands its capabilities far beyond that of any other web
> server, even those with external (dynamically-linked) dependencies."

Caddy explicitly chose **no runtime plugin loading** because:
- Static binaries are simpler to deploy (no dependency management)
- No DLL hell / shared library version conflicts
- Security: all code is known at compile time
- Go's `plugin` package (for `.so` loading) is Linux-only and fragile

### 4.3 Community Request for Runtime Plugins

**Issue #7488** (Feb 2026): A contributor requested Go plugin (`.so`) loading
support. The issue was closed -- the Caddy team considers compile-time assembly
the correct approach.

### 4.4 Lesson for agent-manager

Caddy demonstrates that compile-time plugin assembly can scale to hundreds of
community plugins without runtime loading. The `xcaddy` pattern (custom build
tool) is viable when you need custom combinations. For agent-manager with ~10
adapters, simply bundling all of them is even simpler.

---

## 5. Grafana: Subprocess Plugin Model

### 5.1 Architecture

Grafana uses a **hybrid** plugin model:

- **Frontend plugins:** React/TypeScript bundles loaded by the browser at runtime
  from a plugin directory on disk. The Grafana server serves these as static assets.
- **Backend plugins:** Separate **Go binaries** that Grafana launches as subprocesses.
  Communication happens via **gRPC** (HashiCorp's Go Plugin System over RPC).

### 5.2 Plugin Lifecycle

1. Grafana discovers plugins from configured directories
2. Validates plugin signatures (security)
3. For backend plugins: configures gRPC client, launches the binary as a subprocess
4. Backend process communicates via gRPC for queries, health checks, streaming
5. If the plugin crashes, Grafana auto-restarts it

### 5.3 Key Design Point

Grafana's approach works because:
- Backend plugins are full Go binaries (compiled, self-contained)
- Frontend plugins are JS bundles loaded by the browser (not by a compiled binary)
- The gRPC boundary provides clean isolation and crash recovery

### 5.4 Lesson for agent-manager

The subprocess + IPC model is the only way to truly side-load code at runtime from
a compiled binary. But it requires each adapter to be a separate executable or
script that communicates via a defined protocol (JSON over stdin/stdout, gRPC, etc.).
This is heavy machinery for ~10 adapters.

---

## 6. Telegraf: Built-In + Execd Escape Hatch

### 6.1 Architecture

Telegraf ships as a **single Go binary** with ~300 built-in plugins compiled in.
All plugins implement Go interfaces (`inputs.Input`, `outputs.Output`, etc.) and
are registered via `init()` functions.

### 6.2 External Plugin Support: execd

For plugins that can't be built into the main binary, Telegraf provides the
`execd` shim:

- External plugin is a **separate executable** (compiled from Go using the shim)
- Telegraf launches it as a subprocess
- Communication via **stdin/stdout** using line protocol or JSON
- The shim makes it trivial to extract an internal plugin into an external one

```toml
[[inputs.execd]]
  command = ["/path/to/my-plugin", "-config", "/path/to/plugin.conf"]
  signal = "none"
```

### 6.3 Key Insight: Built-In Is the Default

Despite supporting external plugins, the **vast majority** of Telegraf's ~300
plugins are built-in. External plugins exist for:
- Proprietary/niche integrations
- Rapid community contributions that haven't been merged yet
- Plugins with license incompatibilities

### 6.4 Lesson for agent-manager

Telegraf validates the "built-in by default, subprocess escape hatch for edge cases"
pattern. With only ~10 adapters, agent-manager should follow this model.

---

## 7. Tauri: Compiled Core + JS Surface

### 7.1 Architecture

Tauri uses a **polyglot** plugin model:

- **Core:** Compiled Rust binary
- **Plugins:** Rust crates compiled into the binary at build time
- **JS surface:** Each plugin can expose a JavaScript/TypeScript API that runs
  in the webview (browser context), communicating with the Rust backend via IPC

```rust
// Plugin registration (Rust, compile-time)
tauri::Builder::default()
    .plugin(tauri_plugin_fs::init())
    .plugin(tauri_plugin_shell::init())
    .run(tauri::generate_context!())
```

### 7.2 Key Design Point

Tauri plugins are **always compiled in**. The JS component is a thin wrapper
over IPC commands to the Rust backend. There is no mechanism to load new Rust
plugins at runtime.

### 7.3 Lesson for agent-manager

Tauri confirms that even in a polyglot (compiled + scripted) system, plugin
registration happens at compile time. The scripted layer (JS) handles UI
concerns, not core plugin logic.

---

## 8. Real-World Bun CLI Tools with Plugins

### 8.1 The Search Results

After extensive searching, **no production Bun-compiled binaries that load
external plugins at runtime** were found. The Bun ecosystem's plugin story is
entirely about:

- **Bun.plugin() for the runtime:** Intercept module resolution during
  development (not in compiled binaries)
- **Build plugins for the bundler:** Transform files during `bun build`
  (compile-time only)
- **Preload scripts:** Run setup code before the main script (runtime only,
  not compiled)

### 8.2 What Bun CLI Tools Actually Do

Bun-compiled CLI tools in the wild:
- Bundle everything at compile time
- Use `process.argv` for configuration
- Read config files (JSON/TOML/YAML) for settings
- Have no plugin extensibility beyond what was compiled in

### 8.3 Lesson

The Bun ecosystem has not solved runtime plugin loading for compiled binaries.
This is a fundamental limitation of the compile-to-single-binary approach, not
a gap waiting to be filled.

---

## 9. Pattern Comparison Matrix

| Tool | Plugin binding | Discovery | Communication | Runtime loading? |
|------|---------------|-----------|---------------|------------------|
| **Terraform** | Separate binary | Registry + filesystem | gRPC (subprocess) | Yes (separate process) |
| **Caddy** | Compile-time import | xcaddy / manual | In-process (Go interface) | No |
| **Grafana** | Separate binary (backend) / JS bundle (frontend) | Plugin directory | gRPC (subprocess) | Yes (separate process) |
| **Telegraf** | Compile-time import (built-in) / separate binary (execd) | Config file | In-process / stdin-stdout | Partial (execd only) |
| **ESLint** | npm import at config time | node_modules | In-process (JS object) | Yes (interpreted) |
| **Tauri** | Compile-time crate | Cargo.toml | In-process (Rust trait) | No |
| **Bun compiled** | Compile-time bundle | Static analysis | In-process (JS import) | **No** |

---

## 10. Recommendation for agent-manager

### 10.1 Primary Strategy: Built-In Adapters

**Ship all adapters inside the compiled binary.** Gate activation via config:

```toml
[adapters]
enabled = ["claude-code", "cursor", "windsurf"]
# All adapters are compiled in; only enabled ones are active
```

**Rationale:**
1. Bun compiled binaries **cannot** load external JS/TS at runtime
2. agent-manager targets ~10 adapters, not thousands
3. Built-in means zero-install adapter setup for users
4. One binary, one version, one thing to debug
5. Adapter changes ship with CLI updates (acceptable at this scale)

### 10.2 Adapter Registration Pattern

Use a static registry pattern where all adapters are imported and registered
at compile time, but only instantiated when enabled:

```typescript
// adapters/registry.ts
import { ClaudeCodeAdapter } from "./claude-code.ts";
import { CursorAdapter } from "./cursor.ts";
import { WindsurfAdapter } from "./windsurf.ts";
// ... all adapters imported

export const ADAPTER_REGISTRY: Record<string, () => Adapter> = {
  "claude-code": () => new ClaudeCodeAdapter(),
  "cursor":      () => new CursorAdapter(),
  "windsurf":    () => new WindsurfAdapter(),
  // ... lazy factory functions, only called when enabled
};

export function getAdapter(name: string): Adapter {
  const factory = ADAPTER_REGISTRY[name];
  if (!factory) throw new Error(`Unknown adapter: ${name}`);
  return factory();
}
```

### 10.3 Escape Hatch: Subprocess Adapters (Future)

If a third-party adapter need ever arises, support it via subprocess IPC:

```toml
[adapters.custom.my-proprietary-agent]
command = ["node", "/path/to/my-adapter.js"]
protocol = "jsonrpc"  # or "json-lines"
```

The external adapter would be a standalone script/binary that speaks a defined
protocol over stdin/stdout. This mirrors Telegraf's `execd` pattern and
Terraform's subprocess model.

**Do not build this until there is a concrete need.** Design the adapter interface
to be IPC-friendly (request/response, no shared memory) so this escape hatch
remains viable without refactoring.

### 10.4 What to Avoid

| Anti-pattern | Why |
|-------------|-----|
| Dynamic `import()` for adapter loading | Broken in compiled Bun binaries |
| Plugin directory with `.ts` files | Can't be loaded at runtime from compiled binary |
| Runtime code evaluation for loading | Security problem, no module semantics, no types |
| Separate adapter binaries from day one | Over-engineering for ~10 adapters |
| Go-style compile-time assembly (xcaddy) | Would require users to have Bun installed to rebuild |

### 10.5 Release Strategy

Since adapters are built-in, the release workflow is:

1. Adapter author submits PR to agent-manager repo
2. CI tests the adapter against the target agent/IDE
3. Merge triggers a new CLI release
4. Users update via `am update` (downloads new binary)

This is the same model as Telegraf (300+ built-in plugins), Caddy (standard
modules), and Tauri (official plugins). It works well at the scale of 10-50
adapters.

---

## 11. Decision Summary

| Question | Answer |
|----------|--------|
| Can a Bun compiled binary load external JS/TS? | **No.** Not reliably. |
| Should adapters be built-in? | **Yes.** All adapters compiled into the binary. |
| How are adapters activated? | **Config-gated.** `enabled = ["claude-code", "cursor"]` |
| How are adapters registered? | **Static registry** with lazy factory functions. |
| What about third-party adapters? | **Subprocess IPC** escape hatch (build when needed). |
| What pattern does this follow? | **Telegraf model:** built-in default + execd escape hatch. |
| Release coupling concern? | Manageable at ~10 adapters. Not a real risk until 50+. |

---

## Sources

- Bun docs: Single-file executable -- https://bun.com/docs/bundler/executables
- Bun docs: Plugins -- https://bun.com/docs/runtime/plugins
- Bun issue #11732: Include non-static dynamic imports -- https://github.com/oven-sh/bun/issues/11732
- Bun issue #27058: Compiled executables cannot resolve external modules -- https://github.com/oven-sh/bun/issues/27058
- Bun issue #6893: Dynamic import in executable cannot find module -- https://github.com/oven-sh/bun/issues/6893
- Terraform: How Terraform works with plugins -- https://developer.hashicorp.com/terraform/plugin/how-terraform-works
- HashiCorp: Guide to Terraform versioning (provider evolution history) -- https://www.hashicorp.com/en/resources/a-guide-to-terraform-binary-provider-and-module-versioning
- ESLint: Flat config introduction -- https://eslint.org/blog/2022/08/new-config-system-part-2/
- ESLint: Migration guide -- https://eslint.org/docs/latest/use/configure/migration-guide
- Caddy: Architecture -- https://caddyserver.com/docs/architecture
- Caddy: Extending Caddy -- https://caddyserver.com/docs/extending-caddy
- xcaddy: Build Caddy with plugins -- https://github.com/caddyserver/xcaddy
- Caddy issue #7488: Allow loading Go plugins (closed) -- https://github.com/caddyserver/caddy/issues/7488
- Grafana: Plugin architecture -- via Mintlify grafana docs
- Grafana: Plugin backend system -- https://grafana.com/developers/plugin-tools/key-concepts/backend-plugins/
- Telegraf: External plugins -- https://docs.influxdata.com/telegraf/v1/configure_plugins/external_plugins/
- Telegraf: Execd shim -- https://github.com/influxdata/telegraf/blob/master/plugins/common/shim/README.md
- Tauri: Plugin Development -- https://tauri.app/develop/plugins
