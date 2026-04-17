# Community Adapter Authoring Guide

This guide walks through building a community adapter for agent-manager (am).
Community adapters let you ship support for a new AI coding tool without
getting a PR merged into am itself — they install from npm, git, or a local
path and speak JSON-RPC over stdio to am's loader.

**Audience:** You want to ship an adapter for Zed, Void, PearAI, or any tool
not in the 13 built-ins. Your adapter is a standalone executable.

## Table of Contents

1. [How it works](#how-it-works)
2. [The protocol contract](#the-protocol-contract)
3. [Package structure](#package-structure)
4. [Hello-world adapter](#hello-world-adapter)
5. [Local development workflow](#local-development-workflow)
6. [Security expectations](#security-expectations)
7. [Publishing](#publishing)
8. [Testing against a real am](#testing-against-a-real-am)

## How it works

am treats every adapter as an instance of the `Adapter` interface (see
`src/adapters/types.ts`). Built-ins live in the compiled binary. Community
adapters are spawned as child processes; am's `CommunityAdapterProxy`
implements the same interface by forwarding every call as JSON-RPC 2.0 over
the child's stdin/stdout.

Install flow:

```
am adapter install <source>      # npm package, git URL, or local:./path
  ├─ resolves source type
  ├─ validates adapter name (regex: ^[a-z0-9][a-z0-9_-]{0,63}$)
  ├─ spawns the adapter to run the handshake
  ├─ computes sha256 of the entrypoint
  └─ writes to <config>/adapters.toml with source, command, installed_at, checksum
```

Load flow:

```
am apply (or any command that needs adapters)
  ├─ reads adapters.toml
  ├─ for each entry: verifies sha256 (unless source starts with local:)
  ├─ spawns subprocess, sends adapter/initialize
  ├─ caches the proxy for the duration of the am command
  └─ calls detect/import/export/diff via JSON-RPC as needed
```

## The protocol contract

The contract is JSON-RPC 2.0 over stdio — one JSON object per line (newline-delimited).

### Required RPC methods

Your adapter MUST handle these requests from am:

| Method | Purpose | Params shape | Result shape |
|---|---|---|---|
| `adapter/initialize` | Handshake | `{ protocolVersion: "1.0", amVersion: string }` | `{ protocolVersion: "1.0", adapterVersion: string }` |
| `adapter/meta` | Static metadata | `{}` | `AdapterMeta` |
| `adapter/schema` | Schema definitions | `{}` | `AdapterSchema` |
| `adapter/detect` | Is tool installed? | `{}` | `DetectResult` |
| `adapter/import` | Read tool's native config | `{ projectPath?: string }` | `ImportResult` |
| `adapter/export` | Generate tool's native config from am config | `{ config: ResolvedConfig, options?: ExportOptions }` | `ExportResult` |
| `adapter/diff` | Compare am config to tool's config on disk | `{ config: ResolvedConfig }` | `DiffResult` |

Shapes (from `src/adapters/types.ts`):

```typescript
interface AdapterMeta {
  name: string;             // "zed"; must match adapter install name
  displayName: string;      // "Zed"
  version: string;          // adapter version (your own)
  capabilities: string[];   // e.g. ["servers", "instructions"]
}

interface AdapterSchema {
  // Optional. Declares config fields your adapter understands.
  // Can be empty ({}).
}

interface DetectResult {
  installed: boolean;
  version?: string;
  paths?: {
    configDir?: string;
    binary?: string;
  };
}

interface ImportResult {
  servers: Record<string, ServerConfig>;
  instructions?: Record<string, InstructionConfig>;
  skills?: Record<string, SkillConfig>;
  warnings?: string[];
}

interface ExportResult {
  files: Array<{ path: string; content: string; mode?: number }>;
  warnings?: string[];
}

interface DiffResult {
  status: "in-sync" | "drift" | "missing";
  changes: Array<{ type: "add" | "remove" | "modify"; path: string; detail?: string }>;
}
```

### Protocol rules

- **One JSON object per line** (newline-terminated). Do not pretty-print.
- **Every request has a numeric `id`.** Responses must echo it verbatim.
- **Errors** use the JSON-RPC error envelope: `{ jsonrpc: "2.0", id, error: { code, message, data? } }`.
- **stderr is for diagnostics only.** Warnings, progress, debug output — none of it is parsed. Do NOT emit JSON on stderr.
- **Keep the subprocess alive.** am reuses a single child for all calls in a command. Don't exit after the first RPC.
- **Exit on stdin EOF.** When am closes stdin (command finished), shut down cleanly.
- **Protocol version is "1.0".** If the `amVersion` in the handshake is too old for your adapter's `minAmVersion`, return a JSON-RPC error with code `-32000`.

## Package structure

### As an npm package

```
am-adapter-zed/
├── package.json
├── bin/
│   └── am-adapter-zed           # the executable (node/bun/python — anything)
├── src/
│   └── index.ts                 # your adapter logic
├── README.md
└── LICENSE
```

`package.json`:

```json
{
  "name": "am-adapter-zed",
  "version": "0.1.0",
  "bin": {
    "am-adapter-zed": "bin/am-adapter-zed"
  },
  "am-adapter": {
    "name": "zed",
    "displayName": "Zed",
    "capabilities": ["servers", "instructions"],
    "minAmVersion": "0.4.0"
  }
}
```

am strips the `am-adapter-` prefix when deriving the adapter name, so users
install with `am adapter install am-adapter-zed` and the adapter is registered
as `zed`.

### As a git repo

Same layout. Any directory with a top-level `bin/adapter.js` (or language
equivalent) will work. The install flow clones, runs `npm install --ignore-scripts`
(scripts are disabled to block lifecycle-hook RCE), and registers the adapter.

### As a local directory

During development, install with `am adapter install local:./path/to/adapter`.
am will not compute or verify checksums for local adapters (user-owned code
under active change).

## Hello-world adapter

A minimal adapter in ~30 lines of TypeScript:

```typescript
#!/usr/bin/env bun
// bin/am-adapter-mytool

interface Request { jsonrpc: "2.0"; id: number; method: string; params: any; }
function reply(id: number, result: any) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
}

let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk.toString();
  let newline: number;
  while ((newline = buffer.indexOf("\n")) !== -1) {
    const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
    if (!line.trim()) continue;
    const req: Request = JSON.parse(line);
    switch (req.method) {
      case "adapter/initialize":
        reply(req.id, { protocolVersion: "1.0", adapterVersion: "0.1.0" });
        break;
      case "adapter/meta":
        reply(req.id, { name: "mytool", displayName: "MyTool", version: "0.1.0", capabilities: ["servers"] });
        break;
      case "adapter/schema":
        reply(req.id, {});
        break;
      case "adapter/detect":
        reply(req.id, { installed: false });
        break;
      case "adapter/import":
        reply(req.id, { servers: {}, warnings: [] });
        break;
      case "adapter/export":
        reply(req.id, { files: [], warnings: [] });
        break;
      case "adapter/diff":
        reply(req.id, { status: "in-sync", changes: [] });
        break;
      default:
        process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: req.id, error: { code: -32601, message: "Method not found" } }) + "\n");
    }
  }
});
process.stdin.on("end", () => process.exit(0));
```

Make it executable: `chmod +x bin/am-adapter-mytool`.

## Local development workflow

Fastest iteration loop:

```bash
# 1. Install your WIP adapter from the local path
am adapter install local:./path/to/am-adapter-mytool

# 2. Verify the handshake + meta
am adapter verify mytool

# 3. List it alongside built-ins
am adapter list

# 4. Exercise import/export/diff via am commands
am import --adapter mytool
am apply
am diff
```

When you're done, `am adapter remove mytool` cleans up the adapters.toml
entry. No files under your project are touched.

Tips:

- **Print to stderr liberally.** `console.error("[mytool] importing X")` is
  visible under `am -v` and doesn't interfere with the protocol.
- **Don't buffer stdout.** Flush after every response line. For Node:
  `process.stdout.write(...)` is unbuffered to a TTY but line-buffered to a
  pipe — if you see hangs, force-flush.
- **Crash early, loudly.** On a malformed request, throw with a clear
  message; am will surface the stderr in its warning.

## Security expectations

1. **Checksums are enforced.** On install, am computes sha256 of your
   entrypoint and pins it in adapters.toml. On every subsequent load, the
   hash is verified; a mismatch refuses to spawn the adapter. If your
   entrypoint changes (new release), the user must reinstall with `--force`
   to re-pin.
2. **`--ignore-scripts` is mandatory.** am installs community adapters with
   `npm install --ignore-scripts`. Your package MUST NOT rely on
   `postinstall`, `prepare`, or any lifecycle hook for correctness. Bundle
   or copy assets ahead of publishing.
3. **Adapter name regex.** The derived name from your package (`am-adapter-<name>`)
   must match `^[a-z0-9][a-z0-9_-]{0,63}$`. Traversal / empty / too-long /
   uppercase names are rejected.
4. **No file writes outside the config dir.** Your adapter's export MUST
   return files to am for writing — don't touch the filesystem directly.
   am writes atomically (tmp + rename) and respects profiles.
5. **No network calls on load.** `adapter/initialize` and `adapter/detect`
   run synchronously on every am invocation; they must be fast and offline.
   Heavy work belongs in `import`/`export`.
6. **Subprocess isolation.** You have no sandbox. Treat your code as
   privileged; avoid spawning further subprocesses unless absolutely
   necessary, and never pass user-controlled strings to `sh -c`.

## Publishing

**npm:**

```bash
npm publish    # or: npm publish --provenance (recommended)
```

Users install with `am adapter install am-adapter-mytool` (or
`am-adapter-mytool@0.2.0` for a pinned version).

**git:**

Push to any public git host. Tag releases with SemVer (`v0.1.0`). Users
install with `am adapter install https://github.com/you/am-adapter-mytool.git`.

**marketplace:**

See `src/marketplace/` — if your adapter is part of a wider plugin repo
(skills + servers + adapter bundled), add a `.am-plugin/plugin.json`
manifest listing the adapter. `am marketplace install <name>` will pick it
up. The marketplace pins the git commit SHA, prompts the user for trust on
first-add, and refuses to install if the SHA drifts.

## Testing against a real am

Checklist for release:

- [ ] `am adapter install local:./my-adapter` succeeds
- [ ] `am adapter verify mytool` shows correct meta + version
- [ ] `am adapter list` includes your adapter with capabilities
- [ ] `am import --adapter mytool` reads real tool config (or returns empty gracefully)
- [ ] `am apply` writes correct files at correct paths
- [ ] `am diff` reports `in-sync` after apply
- [ ] Kill your subprocess mid-call → am surfaces a clean warning, not a hang
- [ ] Remove the adapter binary → `am adapter verify` fails with a clear error
- [ ] Rename the binary → `am apply` logs the checksum mismatch and skips

## Further reading

- `src/adapters/types.ts` — full Adapter interface + result shapes
- `src/adapters/community/proxy.ts` — the client side of the protocol
- `src/adapters/community/loader.ts` — checksum and lifecycle
- `src/commands/adapter.ts` — install/verify/remove flow
- ADR-0027 — rationale for subprocess IPC over plugin dlopen
- ADR-0030 — how community adapters fit into the unified agent registry
