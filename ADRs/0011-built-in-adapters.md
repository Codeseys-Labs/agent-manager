---
status: accepted
date: 2026-04-07
---

# ADR-0011: Built-In Adapters with Subprocess Escape Hatch

## Context

agent-manager adapters translate between the core TOML schema and native IDE config
files. We need to decide how adapters are packaged and loaded:

1. **Built-in:** All adapters compiled into the binary, enabled/disabled via config
2. **Side-loaded:** Adapters as npm packages loaded at runtime
3. **Hybrid:** Core adapters built-in, community adapters loaded dynamically

Research (doc 12) found a hard technical constraint: **Bun-compiled binaries cannot
load external JavaScript/TypeScript at runtime.** The binary embeds a virtual
filesystem; `import()` and `require()` resolve against it, not the real filesystem.
Non-statically-analyzable dynamic imports are broken (confirmed by Bun issues #11732,
#27058, #6893, #28042). No production Bun CLI tools with runtime plugin loading exist.

This eliminates Options 2 and 3 for compiled binary distribution.

## Decision

**All adapters are built into the binary**, following the Telegraf model (300+ plugins
compiled in, enabled by config). A subprocess IPC escape hatch is designed but not
built until community demand requires it.

### Built-In Adapter Registry

```typescript
// src/adapters/registry.ts
const ADAPTERS = {
  "claude-code": () => import("./claude-code"),
  "cursor":      () => import("./cursor"),
  "windsurf":    () => import("./windsurf"),
  "copilot":     () => import("./copilot"),
  "forgecode":   () => import("./forgecode"),
  "kilo-code":   () => import("./kilo-code"),
  "kiro":        () => import("./kiro"),
  "cline":       () => import("./cline"),
  "roo-code":    () => import("./roo-code"),
  "continue":    () => import("./continue"),
  "gemini-cli":  () => import("./gemini-cli"),
  "codex-cli":   () => import("./codex-cli"),
  "amazon-q":    () => import("./amazon-q"),
} as const;
```

All 13 adapters are imported, but only enabled ones are instantiated (lazy factory
pattern). The binary size impact is negligible — adapter code is kilobytes, while the
Bun runtime is 60+ MB.

### Adapter Enablement via Config

```toml
# ~/.config/agent-manager/config.toml
[settings]
# Explicitly enable adapters (default: auto-detect installed tools)
# adapters = ["claude-code", "cursor", "copilot"]

# Or rely on auto-detection (default behavior):
# am detects which tools are installed and enables their adapters
```

By default, agent-manager auto-detects installed tools using each adapter's `detect()`
method. Users can override with an explicit list.

### Future: Subprocess IPC Escape Hatch

For community adapters that can't be built-in, design (but don't build yet) a
Telegraf-style `execd` pattern:

```toml
# Future: external adapter via subprocess
[adapters.zed]
type = "external"
command = "am-adapter-zed"   # separate binary
transport = "stdio"           # JSON-RPC over stdin/stdout
```

The adapter interface (import/export/diff/detect) is already IPC-friendly — methods
accept and return serializable data. When community demand arrives, we add a thin
subprocess wrapper without changing the adapter contract.

### Adding a New Built-In Adapter

1. Create `src/adapters/<name>/` with `index.ts`, `schema.ts`, `test/`
2. Implement the `Adapter` interface (detect, import, export, diff)
3. Add to the registry in `src/adapters/registry.ts`
4. PR → release → users get it in the next `am` update

## Consequences

### Positive
- Single binary, zero plugins to install — "it just works"
- All adapters tested together — no version compatibility matrix
- No runtime loading complexity — simple static imports
- Auto-detection means zero config for most users
- Adapter code is tiny relative to binary size — no bloat concern

### Negative
- New adapters require a release of agent-manager
  (mitigation: adapters are simple to write; fast release cycle)
- Community can't independently ship adapters (yet)
  (mitigation: PRs welcome; subprocess escape hatch designed for future)
- All adapter code ships even if unused
  (mitigation: lazy factory — unused adapters are never instantiated;
  code size is negligible vs Bun runtime)

### Neutral
- npm distribution (`npx agent-manager`) runs interpreted — could theoretically
  load external adapters. But we don't optimize for this path; the compiled binary
  is the primary distribution.

## Alternatives Considered

- **npm packages loaded at runtime:** Rejected — Bun compile cannot load external
  modules from the real filesystem. Fundamental technical limitation.
- **Plugin directory with dynamic code execution:** Rejected — security risk, breaks
  tree-shaking, unreliable in compiled binaries.
- **xcaddy-style rebuild tool:** Rejected — requires users to have Bun installed
  and rebuild the binary to add adapters. Too much friction.
- **gRPC subprocess (Terraform model):** Rejected as premature — gRPC is heavy
  machinery for ~10 adapters. The simpler subprocess escape hatch (JSON-RPC over
  stdio) is designed but deferred.

## References

- [12-adapter-packaging-strategy.md](../research/12-adapter-packaging-strategy.md) — Bun compile limitations, Telegraf model, 7 systems surveyed
- [03-bunts-cross-platform-compilation.md](../research/03-bunts-cross-platform-compilation.md) — Bun compile targets and binary sizes
- [09-adapter-architecture-patterns.md](../research/09-adapter-architecture-patterns.md) — Terraform provider evolution, ESLint plugins
