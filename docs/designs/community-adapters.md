# Community Adapter Loading

## Problem Statement

ADR-0011 established that all 13 IDE adapters ship built into the agent-manager binary.
This was the right call: Bun-compiled binaries cannot load external JavaScript at
runtime (`import()` resolves against the embedded virtual filesystem, not the real one).

But the negative consequence is real: community members who want to add adapters for
new tools (Zed, Void, PearAI, Aide, etc.) must submit PRs to the main repo and wait
for a release. This creates a bottleneck. The "subprocess escape hatch" described in
ADR-0011 was designed but never built.

This document designs the community adapter system that makes that escape hatch real.

## Design Goals

1. **Zero friction install:** `am adapter install <source>` from npm, git, or local path
2. **Same interface:** Community adapters implement the same `Adapter` interface as built-ins
3. **Runtime loading:** Adapters run as child processes, not dynamic imports
4. **Config-driven:** Adapter settings live in the same TOML config as everything else
5. **Safe by default:** Clear trust model -- users opt in to running community code
6. **Discoverable:** Users can find adapters through search and a naming convention

## Prior Art

### How Other Tools Handle Community Extensions

| System | Discovery | Install | Loading | Trust Model |
|--------|-----------|---------|---------|-------------|
| **Claude Code plugins** | `plugin.json` manifest | `claude plugin add` | In-process (hooks, agents, skills) | Explicit user approval per plugin |
| **VS Code extensions** | Marketplace + `package.json` | `code --install-extension` | Extension host (separate process) | Marketplace review + sandboxed API |
| **Homebrew taps** | `brew tap user/repo` | Formula from tap git repo | Separate install via formula | User trusts the tap author |
| **ESLint plugins** | npm search `eslint-plugin-*` | `npm install` | `require()` from `node_modules` | npm package trust (no sandbox) |
| **Telegraf inputs** | Built-in or `execd` plugin | Config file | Subprocess (execd) or built-in | Config author controls what runs |
| **Terraform providers** | Registry (registry.terraform.io) | `terraform init` auto-downloads | Separate binary via gRPC | Registry signing + checksums |
| **MCP servers** | mcp-registry, npm | `am install <pkg>` | Subprocess (stdio/SSE) | User trusts the package author |

**Key insight:** The systems most relevant to agent-manager are Telegraf's `execd` model
(subprocess, line protocol over stdio) and Terraform's provider model (separate binary,
structured IPC). Both avoid dynamic code loading entirely.

agent-manager already uses the subprocess-over-stdio pattern for MCP servers. Community
adapters should follow the same pattern: a separate process that speaks a defined
protocol over stdin/stdout.

## Architecture

### Overview

```
am apply
  |
  +-- Built-in adapters (in-process, lazy factory)
  |     claude-code, cursor, windsurf, ...
  |
  +-- Community adapters (subprocess, JSON-RPC over stdio)
        am-adapter-zed (npm package)
        am-adapter-void (git clone)
        ~/my-adapter (local path)
```

Built-in adapters continue to work exactly as they do today. Community adapters are
loaded as child processes that communicate via JSON-RPC 2.0 over stdin/stdout -- the
same transport MCP servers use, which agent-manager already knows how to manage.

### Adapter Protocol: JSON-RPC over stdio

The community adapter is a standalone executable (Node.js script, Bun binary, Python
script, Go binary -- any language) that reads JSON-RPC requests from stdin and writes
responses to stdout.

**Methods** (1:1 mapping to the `Adapter` interface):

| Method | Params | Result |
|--------|--------|--------|
| `adapter/meta` | `{}` | `AdapterMeta` |
| `adapter/detect` | `{ projectPath?: string }` | `DetectResult` |
| `adapter/import` | `ImportOptions` | `ImportResult` |
| `adapter/export` | `{ config: ResolvedConfig, options: ExportOptions }` | `ExportResult` |
| `adapter/diff` | `{ config: ResolvedConfig }` | `DiffResult` |
| `adapter/schema` | `{}` | `{ server?: JSONSchema, instruction?: JSONSchema, global?: JSONSchema }` |

The schema method returns JSON Schema (not Zod) since community adapters may be written
in any language. agent-manager converts JSON Schema to Zod internally for validation.

**Lifecycle:**

1. `am` spawns the adapter process on first use
2. Sends `adapter/meta` to get name, version, capabilities
3. Calls methods as needed (detect, import, export, diff)
4. Process stays alive for the duration of the `am` command (avoids repeated startup)
5. Process is killed when `am` exits

**Example exchange:**

```
--> {"jsonrpc":"2.0","id":1,"method":"adapter/meta","params":{}}
<-- {"jsonrpc":"2.0","id":1,"result":{"name":"zed","displayName":"Zed","version":"0.2.0","capabilities":["mcp","instructions"]}}

--> {"jsonrpc":"2.0","id":2,"method":"adapter/detect","params":{"projectPath":"/Users/dev/myproject"}}
<-- {"jsonrpc":"2.0","id":2,"result":{"installed":true,"version":"0.174.0","paths":{"configDir":"/Users/dev/.config/zed"}}}
```

### Package Structure

Community adapters are npm packages (or git repos, or local directories) with a
standard layout:

```
am-adapter-zed/
  package.json          # name, version, "am-adapter" keyword, bin entry
  bin/
    adapter.js          # entry point (or adapter.ts compiled to JS)
  src/
    detect.ts
    import.ts
    export.ts
    diff.ts
    schema.ts
  README.md
```

**package.json requirements:**

```json
{
  "name": "am-adapter-zed",
  "version": "0.2.0",
  "keywords": ["am-adapter"],
  "am-adapter": {
    "name": "zed",
    "displayName": "Zed",
    "minAmVersion": "0.3.0",
    "capabilities": ["mcp", "instructions"]
  },
  "bin": {
    "am-adapter-zed": "./bin/adapter.js"
  }
}
```

The `am-adapter` field in package.json provides metadata without needing to spawn
the process. The `bin` field ensures the adapter is executable after npm install.

**Naming convention:** `am-adapter-<name>` (like `eslint-plugin-<name>`). This enables
npm search discovery and avoids namespace collisions.

### Installation

```bash
# From npm
am adapter install am-adapter-zed

# From git
am adapter install https://github.com/user/am-adapter-zed.git

# From local path (for development)
am adapter install ./my-adapter

# With version pinning
am adapter install am-adapter-zed@0.2.0
```

**What `am adapter install` does:**

1. **Resolve source:** npm package, git URL, or local path
2. **Download/clone** to `~/.config/agent-manager/adapters/<name>/`
3. **Run `npm install --production`** (or `bun install`) in the adapter directory
4. **Validate:** Spawn the adapter, call `adapter/meta`, verify it speaks the protocol
5. **Check compatibility:** Compare `minAmVersion` against the running `am` version
6. **Register** in `~/.config/agent-manager/adapters.toml`:

```toml
[adapters.zed]
source = "npm:am-adapter-zed@0.2.0"
command = "~/.config/agent-manager/adapters/zed/bin/adapter.js"
installed_at = "2026-04-14T10:30:00Z"
checksum = "sha256:abc123..."
```

7. **Auto-commit** the adapters.toml change (git-backed config)

### Storage Layout

```
~/.config/agent-manager/
  config.toml             # existing core config
  adapters.toml           # community adapter registry (new)
  adapters/               # installed adapter packages (new)
    zed/
      package.json
      bin/adapter.js
      node_modules/
    void/
      ...
```

The `adapters/` directory is gitignored (it contains node_modules). The `adapters.toml`
file is version-controlled and contains enough information to reinstall everything:
`am adapter install --restore` reads adapters.toml and reinstalls all listed adapters.

### Configuration in TOML

Community adapters participate in the same config system as built-ins:

```toml
# Global config.toml

# Per-server adapter overrides (same pattern as built-in adapters)
[servers.my-server.adapters.zed]
some_zed_specific_field = "value"

# Global adapter settings
[adapters.zed]
theme = "dark"
workspace_dir = "~/projects"
```

The `[adapters.zed]` section is validated against the adapter's schema (fetched via
`adapter/schema` and converted from JSON Schema to Zod).

### Registry Integration

The `registry.ts` module is extended to be aware of community adapters:

```typescript
// Extended registry.ts (pseudocode)

const BUILT_IN_FACTORIES: Record<string, AdapterFactory> = { /* existing 13 */ };

export async function getAdapter(name: string): Promise<Adapter | undefined> {
  // 1. Check built-in first (fast path)
  const builtIn = BUILT_IN_FACTORIES[name];
  if (builtIn) {
    const cached = adapterCache.get(name);
    if (cached) return cached;
    const adapter = await builtIn();
    adapterCache.set(name, adapter);
    return adapter;
  }

  // 2. Check community adapters
  const community = await getCommunityAdapter(name);
  if (community) return community;

  return undefined;
}

export function listAdapters(): string[] {
  return [
    ...Object.keys(BUILT_IN_FACTORIES),
    ...listCommunityAdapters(),
  ];
}
```

A `CommunityAdapterProxy` class wraps the subprocess and implements the `Adapter`
interface, translating each method call to a JSON-RPC request:

```typescript
class CommunityAdapterProxy implements Adapter {
  private process: ChildProcess;
  private rpc: JsonRpcClient;

  meta: AdapterMeta;  // populated from adapter/meta call
  schema: AdapterSchema;  // populated from adapter/schema call

  detect(): DetectResult {
    return this.rpc.call("adapter/detect", {});
  }

  import(options: ImportOptions): ImportResult {
    return this.rpc.call("adapter/import", options);
  }

  export(config: ResolvedConfig, options: ExportOptions): ExportResult {
    return this.rpc.call("adapter/export", { config, options });
  }

  diff(config: ResolvedConfig): DiffResult {
    return this.rpc.call("adapter/diff", { config });
  }
}
```

### CLI Commands

Extend the existing `am adapter` command:

```
am adapter list                          # Shows both built-in and community
am adapter install <source> [--version]  # Install community adapter
am adapter remove <name>                 # Uninstall community adapter
am adapter update [name]                 # Update one or all community adapters
am adapter info <name>                   # Show adapter details, source, version
am adapter verify <name>                 # Re-validate an installed adapter
am adapter create <name>                 # Scaffold a new adapter project
```

The `am adapter list` output distinguishes between types:

```
Name             Display Name         Source     Capabilities                    Detected
---------------- -------------------- --------- ------------------------------ ----------
claude-code      Claude Code          built-in  mcp, instructions, ...         yes (2.3)
cursor           Cursor               built-in  mcp, instructions, agents      yes (0.47)
...
zed              Zed                  npm       mcp, instructions              yes (0.174)
void             Void                 git       mcp                            no
```

### Scaffolding

`am adapter create` generates a starter project:

```bash
am adapter create my-tool
# Creates:
#   am-adapter-my-tool/
#     package.json       # pre-filled with am-adapter metadata
#     tsconfig.json
#     src/
#       index.ts         # JSON-RPC server boilerplate
#       detect.ts        # detect() stub
#       import.ts        # import() stub
#       export.ts        # export() stub
#       diff.ts          # diff() stub
#       schema.ts        # empty schemas
#     test/
#       detect.test.ts   # test stubs
#     README.md
```

The scaffolded project includes a ready-to-run JSON-RPC server that handles the
protocol boilerplate. Adapter authors only need to fill in the four core methods.

## Security & Trust Model

### Threat Model

Community adapters are untrusted code that runs with the same permissions as the
`am` process. They can:

- Read/write any file the user can access
- Make network requests
- Execute arbitrary commands

This is the same trust model as npm packages, MCP servers, VS Code extensions,
and Homebrew formulae. There is no sandbox.

### Mitigations

1. **Explicit install:** Users must run `am adapter install` -- adapters are never
   auto-discovered or auto-loaded. This is an opt-in trust decision.

2. **Source pinning:** `adapters.toml` records the exact source, version, and content
   checksum. `am adapter verify` re-validates the installed files against the recorded
   checksum.

3. **Version compatibility:** The `minAmVersion` field prevents adapters from running
   against incompatible agent-manager versions (which could expose unexpected APIs).

4. **Warning on install:** `am adapter install` prints a clear warning:

   ```
   Warning: Community adapters run with your full user permissions.
   Only install adapters from authors you trust.

   Installing am-adapter-zed@0.2.0 from npm
   Source: https://www.npmjs.com/package/am-adapter-zed
   Author: @zed-community

   Continue? [y/N]
   ```

5. **No implicit execution:** Community adapters only run when `am` commands
   explicitly invoke them. They don't run in the background or at startup.

6. **Audit trail:** Every install, update, and remove is recorded in the git-backed
   config with a commit message. `am adapter list` shows what's installed and from where.

### Future: Sandboxing

If demand warrants it, a future version could add optional sandboxing:

- **macOS:** `sandbox-exec` with a restrictive profile (fs read-only except specific paths)
- **Linux:** `bwrap` / `firejail` with mount namespace isolation
- **Cross-platform:** Deno-style permission flags in the adapter manifest

This is explicitly out of scope for v1. The MCP ecosystem has established that
subprocess-with-user-trust is an acceptable model.

## Versioning & Compatibility

### Adapter Protocol Version

The protocol includes a version negotiation step:

```
--> {"jsonrpc":"2.0","id":0,"method":"adapter/initialize","params":{"protocolVersion":"1.0","amVersion":"0.3.0"}}
<-- {"jsonrpc":"2.0","id":0,"result":{"protocolVersion":"1.0","adapterVersion":"0.2.0"}}
```

If the protocol versions are incompatible, `am` prints a clear error:

```
error: am-adapter-zed requires protocol v2.0, but am 0.3.0 supports v1.0
  hint: upgrade agent-manager with `brew upgrade am` or `npm update -g agent-manager`
```

### Semantic Versioning

- **Protocol version** follows semver. Minor bumps add optional methods. Major bumps
  may remove or change existing methods.
- **Adapter versions** follow npm semver. `adapters.toml` can pin exact versions or
  ranges.
- **`minAmVersion`** in the adapter manifest prevents running against too-old a host.

### Update Flow

```bash
# Update a specific adapter
am adapter update zed

# Update all community adapters
am adapter update

# Check for updates without installing
am adapter update --dry-run
```

Update checks the source (npm registry, git remote) for newer versions, respects
version pinning in `adapters.toml`, and re-validates after update.

## Discovery

### npm Search

The `am-adapter` keyword in package.json enables npm search:

```bash
npm search am-adapter
# or via am:
am adapter search zed
```

### GitHub Topic

Encourage adapter authors to use the `am-adapter` GitHub topic for discoverability.

### Registry Page (Future)

A curated list on the agent-manager wiki or docs site. Not built for v1 -- the npm
keyword convention is sufficient for early community growth.

### `am adapter search`

Wraps npm search with the `am-adapter` keyword filter and formats results:

```bash
am adapter search zed

  am-adapter-zed         0.2.0   Zed editor adapter for agent-manager
  am-adapter-zed-rules   0.1.0   Zed rules/snippets adapter (community)

  2 packages found. Install with: am adapter install <name>
```

## SDK / Helper Library

To reduce boilerplate, publish `@agent-manager/adapter-sdk` (npm package):

```typescript
import { createAdapterServer } from "@agent-manager/adapter-sdk";

const server = createAdapterServer({
  meta: {
    name: "zed",
    displayName: "Zed",
    version: "0.2.0",
    capabilities: ["mcp", "instructions"],
  },
  detect: () => { /* ... */ },
  import: (options) => { /* ... */ },
  export: (config, options) => { /* ... */ },
  diff: (config) => { /* ... */ },
  schema: { /* JSON Schema objects */ },
});

server.listen(); // reads stdin, writes stdout
```

The SDK handles:
- JSON-RPC protocol parsing and serialization
- Protocol version negotiation
- Error formatting
- TypeScript types for all request/response shapes
- A test harness for validating adapters locally

This SDK is optional. Adapter authors who prefer Python, Go, or Rust can implement
the JSON-RPC protocol directly.

## Implementation Plan

### Phase 1: Protocol & Proxy (v0.4.0)

- Define the JSON-RPC adapter protocol spec
- Implement `CommunityAdapterProxy` class
- Extend `registry.ts` to load community adapters from `adapters.toml`
- Add `adapters.toml` parsing and management
- Wire community adapters into `am apply`, `am import`, `am status`

### Phase 2: Install & Manage (v0.4.0)

- `am adapter install` from npm, git, and local path
- `am adapter remove`
- `am adapter update`
- `am adapter verify`
- Trust warning UX
- Auto-commit to git-backed config

### Phase 3: SDK & Scaffolding (v0.5.0)

- Publish `@agent-manager/adapter-sdk` to npm
- `am adapter create` scaffolding command
- `am adapter search` wrapping npm search
- Documentation: "Creating a Community Adapter" guide

### Phase 4: Ecosystem Growth (v0.6.0+)

- Curated adapter list on docs site
- Adapter testing CI template (GitHub Actions)
- Optional sandboxing for high-security environments
- Adapter telemetry (opt-in usage stats for adapter authors)

## Open Questions

1. **Should community adapters support `sessionReader`?** The `SessionReader` interface
   (used by claude-code and codex-cli adapters) provides session history access. This
   could be exposed via additional JSON-RPC methods, but it's complex. Propose: defer
   to Phase 3.

2. **Auto-detection for community adapters?** Built-in adapters auto-detect installed
   tools. Community adapters could do the same (run `detect()` on all installed
   adapters at startup). However, spawning N subprocess just to check detection adds
   latency. Propose: community adapters require explicit enablement in config, no
   auto-detection.

3. **Adapter conflicts?** What if a community adapter and a built-in adapter both claim
   the same tool? Propose: built-in always wins. If a community adapter has the same
   name as a built-in, `am adapter install` warns and requires `--force`.

4. **Cross-platform adapters?** Some adapter authors may only test on macOS. The
   protocol is platform-agnostic, but the adapter's detect/import/export logic may
   have platform-specific bugs. Propose: adapter manifest declares supported platforms,
   `am adapter install` warns on unsupported platforms.
