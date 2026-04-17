---
status: accepted
date: 2026-04-16
---

# ADR-0027: Community Adapter Loading via Subprocess IPC

## Context

ADR-0011 established that all adapters are built into the agent-manager binary due to a
hard technical constraint: Bun-compiled binaries cannot load external JavaScript at
runtime. This was the correct decision for launch -- single binary, zero plugins, all
13 adapters tested together.

However, ADR-0011 explicitly identified the negative consequence: "Community can't
independently ship adapters (yet)" and designed (but did not build) a subprocess escape
hatch for future use.

Community demand is arriving. Users want adapters for Zed, Void, PearAI, Aide, and
other emerging AI coding tools. The current path requires a PR to the main repo plus a
release cycle for each new adapter. This bottleneck will worsen as the AI coding tool
landscape fragments.

The adapter interface (`detect`, `import`, `export`, `diff`, `schema`) already operates
on serializable data -- no opaque objects, closures, or process-local state. This makes
it naturally IPC-friendly.

agent-manager also has prior art with subprocess-over-stdio communication: MCP servers
are already managed as child processes speaking JSON-based protocols. The infrastructure
for process lifecycle management, stdio piping, and error handling exists.

## Decision

Implement community adapter loading using **JSON-RPC 2.0 over stdio**, following the
Telegraf `execd` model and reusing the subprocess patterns already established for MCP
servers.

### Protocol

Community adapters are standalone executables (any language) that read JSON-RPC requests
from stdin and write responses to stdout. The protocol maps 1:1 to the existing
`Adapter` interface:

| JSON-RPC Method | Maps To | Direction |
|-----------------|---------|-----------|
| `adapter/initialize` | Protocol handshake | am -> adapter |
| `adapter/meta` | `Adapter.meta` | am -> adapter |
| `adapter/detect` | `Adapter.detect()` | am -> adapter |
| `adapter/import` | `Adapter.import()` | am -> adapter |
| `adapter/export` | `Adapter.export()` | am -> adapter |
| `adapter/diff` | `Adapter.diff()` | am -> adapter |
| `adapter/schema` | `Adapter.schema` (as JSON Schema) | am -> adapter |

The `initialize` method negotiates protocol version and checks compatibility:

```json
{"jsonrpc":"2.0","id":0,"method":"adapter/initialize",
 "params":{"protocolVersion":"1.0","amVersion":"0.3.0"}}
```

### Installation

```bash
am adapter install am-adapter-zed          # npm
am adapter install git+https://...         # git
am adapter install ./local-adapter         # local path
am adapter install am-adapter-zed@0.2.0    # pinned version
```

Adapters are installed to `~/.config/agent-manager/adapters/<name>/` and registered
in `~/.config/agent-manager/adapters.toml` (git-tracked, reinstallable).

### Package Convention

npm packages use the `am-adapter-<name>` naming convention (like `eslint-plugin-*`)
with an `am-adapter` keyword and metadata in `package.json`:

```json
{
  "name": "am-adapter-zed",
  "keywords": ["am-adapter"],
  "am-adapter": {
    "name": "zed",
    "displayName": "Zed",
    "minAmVersion": "0.3.0",
    "capabilities": ["mcp", "instructions"]
  },
  "bin": { "am-adapter-zed": "./bin/adapter.js" }
}
```

### Registry Integration

`registry.ts` is extended: `getAdapter()` checks built-in factories first (fast path),
then falls back to community adapters loaded from `adapters.toml`. A
`CommunityAdapterProxy` class implements the `Adapter` interface by forwarding each
method call as a JSON-RPC request to the child process.

Built-in adapters always take precedence over community adapters with the same name.

### Trust Model

Community adapters run with full user permissions (same as npm packages, MCP servers,
and VS Code extensions). Mitigations:

- Explicit `am adapter install` required (no auto-discovery or auto-loading)
- Interactive trust warning with source, author, and version before install
- Source pinning and content checksums in `adapters.toml`
- `minAmVersion` compatibility check
- Git-backed audit trail for all install/update/remove operations

### SDK

An optional `@agent-manager/adapter-sdk` npm package provides TypeScript boilerplate
for the JSON-RPC server, types, and a test harness. Adapter authors using other
languages implement the protocol directly.

## Consequences

### Positive

- Community can ship adapters independently without PRs to the main repo
- Any language can implement adapters (not just TypeScript)
- Protocol is the same pattern as MCP servers -- no new infrastructure concepts
- Built-in adapters are unaffected -- zero performance regression for existing users
- Clear upgrade path: popular community adapters can be promoted to built-in
- Version pinning and checksums prevent supply chain surprises

### Negative

- Subprocess overhead: ~50-100ms per adapter spawn (mitigated by keeping the process
  alive for the command duration and only spawning enabled adapters)
- Schema uses JSON Schema instead of Zod (community adapters can't use Zod directly);
  requires JSON Schema -> Zod conversion in the proxy layer
- Community adapters won't appear in auto-detection by default (explicit config
  required) -- this is also a security feature
- Additional testing surface: the JSON-RPC protocol must be tested end-to-end, not
  just the adapter logic
- Adapter SDK is another package to maintain

### Neutral

- The `adapters.toml` file is a new config file alongside `config.toml`, but follows
  the same TOML + git-backed pattern
- npm distribution of am still runs interpreted and could theoretically use in-process
  loading, but the subprocess protocol works for both compiled and interpreted modes --
  one path is simpler than two

## Alternatives Considered

- **Dynamic import (require/import at runtime):** Rejected in ADR-0011 -- Bun compiled
  binaries cannot resolve imports against the real filesystem.

- **xcaddy-style rebuild:** Users would run `am build --with am-adapter-zed` to compile
  a custom binary with additional adapters baked in. Rejected: requires users to have
  Bun installed, breaks the single-binary distribution model, and creates N custom
  binaries to manage.

- **gRPC subprocess protocol:** Rejected as overly heavy. JSON-RPC over stdio is
  simpler, has no additional dependencies, and matches the existing MCP server pattern.
  gRPC would require protobuf compilation and a runtime library in every adapter.

- **WASM plugins:** Rejected: WASM sandboxing is attractive for security, but the
  adapter interface requires filesystem access (reading native config files), which
  breaks the WASM sandbox model. The WASI extensions for filesystem access are immature.

- **Shared library loading (FFI):** Rejected: platform-specific (.so/.dylib/.dll),
  fragile ABI, no language portability. Much worse than subprocess IPC.

- **In-process loading for npm-only distribution:** Only enable community adapter
  loading when am runs interpreted (via npx/bunx), not compiled. Rejected: creates
  two different feature sets for the same tool, confusing for users and adapter authors.

## References

- [ADR-0011: Built-In Adapters](./0011-built-in-adapters.md) -- established the
  built-in model and designed (but deferred) the subprocess escape hatch
- [Community Adapters Design](../docs/designs/community-adapters.md) -- full design
  document with implementation plan, CLI commands, SDK, and open questions
- [Adapter Development Guide](../docs/adapter-development-guide.md) -- existing guide
  for built-in adapter development
- [Telegraf execd plugin](https://github.com/influxdata/telegraf/tree/master/plugins/inputs/execd) --
  prior art for subprocess-based plugin loading
- [Terraform Provider Protocol](https://developer.hashicorp.com/terraform/plugin/framework) --
  prior art for gRPC-based plugin loading (more complex than needed here)
