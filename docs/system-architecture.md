# System Architecture Guide

> Technical reference for how `am` is structured internally. For contributors building
> new features and AI agents that need to understand the codebase to make changes.
>
> All file paths are relative to the repository root. All type names reference actual
> TypeScript types in the codebase.

---

## 1. System Overview

`am` follows a **Layered Core + Dual-Axis Adapter Extensions** architecture (ADR-0001,
ADR-0013). Four interface layers (CLI, MCP, TUI, Web) all route through a single core
engine, which delegates to two adapter axes: IDE adapters (13 tools) and platform
adapters (3 git hosts).

### Layer Diagram

```mermaid
graph TD
    subgraph Interfaces
        CLI["CLI<br/>(citty + clack)<br/>src/cli.ts"]
        MCP["MCP Server<br/>(JSON-RPC 2.0 over stdio)<br/>src/mcp/server.ts"]
        TUI["TUI<br/>(Silvery + React)<br/>src/tui/"]
        Web["Web UI<br/>(Hono)<br/>src/web/"]
    end

    subgraph Core["Core Engine (src/core/)"]
        ConfigMod["Config Store<br/>config.ts<br/>TOML read/write, 4-layer merge"]
        Resolver["Profile Resolver<br/>resolver.ts<br/>inheritance chains, tag activation"]
        Secrets["Encryption<br/>secrets.ts<br/>AES-256-GCM, interpolation"]
        GitMod["Git Operations<br/>git.ts<br/>isomorphic-git"]
        Schema["Schema<br/>schema.ts<br/>Zod validation"]
        SessionMod["Session<br/>session.ts<br/>types, filter, format"]
    end

    subgraph IDE["IDE Adapters (src/adapters/)"]
        CC["claude-code"]
        CU["cursor"]
        CP["copilot"]
        WS["windsurf"]
        KI["kiro"]
        More["+ 8 more"]
    end

    subgraph Platform["Platform Adapters (src/platforms/)"]
        GH["github.ts"]
        GL["gitlab.ts"]
        Bare["bare.ts"]
    end

    subgraph Storage
        ConfigFiles["~/.config/agent-manager/<br/>config.toml, state.toml,<br/>key.txt, .git/"]
        NativeFiles["Native IDE configs<br/>~/.claude.json,<br/>.cursor/mcp.json, ..."]
    end

    CLI --> Core
    MCP --> Core
    TUI --> Core
    Web --> Core

    Core --> IDE
    Core --> Platform

    IDE --> NativeFiles
    Platform --> GitRemotes["Git Remotes"]
    Core --> ConfigFiles
```

### Data Flow Summary

All user-facing operations follow the same pattern:
1. **Interface** receives user intent (CLI command, MCP tool call, web API request)
2. **Core** loads config, resolves profile, decrypts secrets, builds `ResolvedConfig`
3. **IDE adapters** translate `ResolvedConfig` into native config files (export) or
   parse native files back into core format (import)
4. **Platform adapters** handle git remote authentication and key storage for push/pull

---

## 2. Core Engine

The core engine in `src/core/` owns the universal data model, config loading and
merging, profile resolution, encryption, git operations, and session types.

### Type Relationships

```mermaid
classDiagram
    class Config {
        settings?: Settings
        servers?: Record~string, Server~
        skills?: Record~string, Skill~
        instructions?: Record~string, Instruction~
        agents?: Record~string, AgentProfile~
        profiles?: Record~string, Profile~
        adapters?: Record~string, unknown~
    }

    class ResolvedConfig {
        servers: Record~string, ResolvedServer~
        instructions: Record~string, ResolvedInstruction~
        skills: Record~string, ResolvedSkill~
        agents: Record~string, ResolvedAgent~
        profile: string
        adapters: Record~string, Record~
    }

    class ResolvedServer {
        name: string
        command: string
        args: string[]
        env: Record~string, string~
        transport: string
        tags: string[]
        enabled: boolean
        adapters: Record~string, Record~
    }

    class ResolvedInstruction {
        name: string
        content: string
        scope: string
        globs: string[]
        targets: string[]
        adapters: Record~string, Record~
    }

    class ResolvedSkill {
        name: string
        path: string
        description: string
        tags: string[]
        adapters: Record~string, Record~
    }

    class ResolvedAgent {
        name: string
        description: string
        prompt: string
        model: string
        tools: string[]
        mcp_servers: string[]
        adapters: Record~string, Record~
    }

    Config --> ResolvedConfig : buildResolvedConfig
    ResolvedConfig --> ResolvedServer
    ResolvedConfig --> ResolvedInstruction
    ResolvedConfig --> ResolvedSkill
    ResolvedConfig --> ResolvedAgent
```

### Config Loading Pipeline

`loadResolvedConfig()` in `src/core/config.ts` implements the 4-layer merge:

```mermaid
flowchart TD
    Start["loadResolvedConfig()"]
    Start --> Read1["tryReadConfig(config.toml)"]
    Read1 --> Merge1["mergeConfigs(result, config.local.toml)"]
    Merge1 --> Read3["tryReadProjectConfig(.agent-manager.toml)"]
    Read3 --> Merge2["mergeConfigs(result, projectToConfig(proj))"]
    Merge2 --> Read4["tryReadProjectConfig(.agent-manager.local.toml)"]
    Read4 --> Merge3["mergeConfigs(result, projectToConfig(projLocal))"]
    Merge3 --> Result["Merged Config"]

    style Start fill:#e0e0ff
    style Result fill:#e0ffe0
```

Each `mergeConfigs(a, b)` call applies these rules:
- **Servers, skills, instructions, agents, profiles**: spread merge (`{...a, ...b}`) --
  same-name key in `b` wins
- **Settings**: spread merge -- per-key override
- **Adapters**: spread merge by adapter name

### Profile Resolution

`resolveProfile()` in `src/core/resolver.ts` walks the inheritance chain:

```mermaid
flowchart TD
    Input["resolveProfile('work', config)"]
    Input --> Chain["Build chain: work -> base"]
    Chain --> Reverse["Reverse: base, work"]
    Reverse --> Walk["Walk chain parent-first"]

    Walk --> Arrays["Arrays: union, parent first<br/>servers, skills, agents, instructions"]
    Walk --> Tables["Tables: shallow merge, child wins<br/>env, adapters"]
    Walk --> Tags["server_tags: resolve to server names<br/>via resolveServerTags()"]

    Arrays --> Result["ResolvedProfile"]
    Tables --> Result
    Tags --> Result
```

Tag resolution: `resolveServerTags()` scans the server catalog and returns all server
names whose tags overlap with the requested `server_tags` array. Disabled servers
(`enabled = false`) are skipped.

---

## 3. Adapter Architecture

All 13 IDE adapters implement the `Adapter` interface defined in `src/adapters/types.ts`.

### Adapter Interface

```mermaid
classDiagram
    class Adapter {
        +meta: AdapterMeta
        +detect() DetectResult
        +import(options: ImportOptions) ImportResult
        +export(config: ResolvedConfig, options: ExportOptions) ExportResult
        +diff(config: ResolvedConfig) DiffResult
        +schema: AdapterSchema
        +sessionReader?: SessionReader
    }

    class AdapterMeta {
        +name: string
        +displayName: string
        +version: string
        +capabilities: Capability[]
    }

    class DetectResult {
        +installed: boolean
        +version?: string
        +paths: Record~string, string~
    }

    class ImportResult {
        +servers: ImportedServer[]
        +instructions: ImportedInstruction[]
        +skills: ImportedSkill[]
        +warnings: string[]
    }

    class ExportResult {
        +files: WrittenFile[]
        +warnings: string[]
    }

    class DiffResult {
        +status: string
        +changes: DiffChange[]
    }

    class SessionReader {
        +hasSessionStorage() boolean
        +listSessions(project?) Promise~SessionSummary[]~
        +loadSession(id) Promise~Session~
    }

    Adapter --> AdapterMeta
    Adapter --> DetectResult
    Adapter --> ImportResult
    Adapter --> ExportResult
    Adapter --> DiffResult
    Adapter --> SessionReader
```

### Adapter Lifecycle

```mermaid
sequenceDiagram
    participant Core as Core Engine
    participant Registry as registry.ts
    participant Adapter as IDE Adapter

    Note over Core,Adapter: Discovery Phase
    Core->>Registry: listAdapters()
    Registry-->>Core: ["claude-code", "cursor", ...]
    Core->>Registry: getAdapter("claude-code")
    Registry->>Registry: Check cache
    Registry->>Adapter: import("./claude-code/index.ts")
    Adapter-->>Registry: claudeCodeAdapter
    Registry-->>Core: Adapter instance (cached)

    Note over Core,Adapter: Detection Phase
    Core->>Adapter: adapter.detect()
    Adapter-->>Core: { installed: true, paths: {...} }

    Note over Core,Adapter: Import Phase
    Core->>Adapter: adapter.import({ projectPath })
    Adapter-->>Core: { servers: [...], instructions: [...] }

    Note over Core,Adapter: Export Phase
    Core->>Adapter: adapter.export(resolvedConfig, options)
    Adapter-->>Core: { files: [...], warnings: [...] }

    Note over Core,Adapter: Drift Detection Phase
    Core->>Adapter: adapter.diff(resolvedConfig)
    Adapter-->>Core: { status: "drifted", changes: [...] }
```

### Registry: Lazy Loading + Caching

The adapter registry in `src/adapters/registry.ts` uses a lazy factory pattern:

```typescript
const ADAPTER_FACTORIES: Record<string, AdapterFactory> = {
  "claude-code": async () => {
    const { claudeCodeAdapter } = await import("./claude-code/index.ts");
    return claudeCodeAdapter;
  },
  // ... 12 more
};
const adapterCache = new Map<string, Adapter>();
```

Key properties:
- **Lazy loading**: adapter code is only imported when first requested via `getAdapter()`
- **Cache**: once loaded, the adapter instance is cached in `adapterCache`
- **Detection**: `getDetectedAdapters()` iterates all factories, loads each adapter,
  and returns only those where `detect().installed === true`

### Two-Phase Validation (ADR-0007)

Validation happens in two passes:

1. **Phase 1 -- Core validation**: `ConfigSchema.parse(parsed)` in `src/core/schema.ts`
   validates all core fields strictly. Adapter sections (`[servers.X.adapters.Y]`)
   are typed as `z.record(z.string(), z.unknown()).optional()` -- preserved but not
   validated.

2. **Phase 2 -- Adapter validation**: Each adapter's `schema` property contains Zod
   schemas for its own section. When the adapter processes its data (during import or
   export), it validates its portion.

This allows adding adapter-specific fields without changing the core schema.

### Adapter File Structure

Each adapter follows the same directory layout:

```
src/adapters/<name>/
  index.ts    -- wires detect + import + export + diff into Adapter object
  detect.ts   -- checks if tool is installed, returns config file paths
  import.ts   -- parses native config files into ImportResult
  export.ts   -- writes ResolvedConfig to native config files
  diff.ts     -- structural comparison for drift detection
  schema.ts   -- Zod schemas for adapter-specific TOML fields
```

---

## 4. Platform Adapter Architecture

Platform adapters handle git remote detection, authentication, and encryption key
storage for the three supported git hosting platforms.

### Platform Detection

```mermaid
flowchart LR
    URL["Remote URL<br/>(git@github.com:user/repo.git)"]
    URL --> Detect["detectPlatform(url)<br/>src/platforms/registry.ts"]
    Detect --> Order["Ordered by specificity"]

    Order --> GH["github.ts<br/>detect: contains 'github.com'"]
    Order --> GL["gitlab.ts<br/>detect: contains 'gitlab'"]
    Order --> Bare["bare.ts<br/>fallback: always matches"]

    GH --> Features1["login, storeKey,<br/>retrieveKey, createRepo"]
    GL --> Features2["login, storeKey,<br/>retrieveKey"]
    Bare --> Features3["No auth,<br/>no key storage"]
```

### GitPlatformAdapter Interface

```typescript
interface GitPlatformAdapter {
  meta: { name: string; displayName: string };
  detect(remoteUrl: string): boolean;
  login?(): Promise<AuthResult>;
  isAuthenticated?(): Promise<boolean>;
  storeKey?(repoUrl: string, key: string): Promise<void>;
  retrieveKey?(repoUrl: string): Promise<string | null>;
  createRepo?(name: string, options: RepoOptions): Promise<string>;
}
```

Detection is ordered by specificity in `src/platforms/registry.ts`: GitHub first,
GitLab second, bare as fallback. The `PLATFORMS` array order matters -- the first
adapter whose `detect()` returns `true` wins.

The `storeKey()` and `retrieveKey()` methods enable encryption key distribution
through platform-native secret stores (GitHub Secrets, GitLab CI/CD Variables).
The bare adapter has no key storage capability.

---

## 5. MCP Server Architecture

`am mcp-serve` implements a JSON-RPC 2.0 server over stdio, exposing 14 tools
across 3 permission tiers.

### Server Architecture

```mermaid
graph TD
    Stdin["stdin<br/>(newline-delimited JSON-RPC)"]
    Stdin --> Parser["Line parser<br/>(buffer + split on newline)"]
    Parser --> Dispatch["handleRequest()"]

    Dispatch --> Init["initialize<br/>(return capabilities)"]
    Dispatch --> ToolsList["tools/list<br/>(return 14 tool defs)"]
    Dispatch --> ToolsCall["tools/call"]

    ToolsCall --> FindTool["Find tool by name"]
    FindTool --> PermCheck["checkPermission(tier, settings)"]

    PermCheck --> Denied["Permission denied<br/>(isError: true)"]
    PermCheck --> Handler["Tool handler function"]

    Handler --> ConfigLoad["loadConfigAndProfile()"]
    ConfigLoad --> Result["JSON result"]
    Result --> Stdout["stdout<br/>(JSON-RPC response)"]
```

### Tool Registry Pattern

Tools are defined as `ToolEntry` objects in the `defineTools()` function:

```typescript
interface ToolEntry {
  def: McpToolDef;           // name, description, inputSchema
  tier: ToolTier;            // "read-only" | "write-local" | "write-remote"
  handler: (args) => Promise<unknown>;
}
```

### Permission Gate Logic

```typescript
function checkPermission(tier, settings) {
  if (tier === "read-only" || tier === "write-local") return { allowed: true };
  if (tier === "write-remote") {
    if (settings?.mcp_serve?.allow_push) return { allowed: true };
    return { allowed: false, reason: "..." };
  }
}
```

Key security measures:
- `am_config_show` redacts all `enc:v1:*` values to `[encrypted]`
- Write-remote tools require explicit config opt-in
- `am_apply` is write-local (only writes local native config files)

### All 14 Tools

| Tool | Tier | Purpose |
|------|------|---------|
| `am_list_servers` | read-only | List MCP servers in catalog |
| `am_list_profiles` | read-only | List profiles with active indicator |
| `am_status` | read-only | Drift detection + git sync state |
| `am_config_show` | read-only | Show resolved config (secrets redacted) |
| `am_session_list` | read-only | List sessions across tools |
| `am_session_export` | read-only | Export session with filters |
| `am_session_search` | read-only | Full-text search across sessions |
| `am_add_server` | write-local | Add server to catalog + commit |
| `am_remove_server` | write-local | Remove server + commit |
| `am_use_profile` | write-local | Switch active profile |
| `am_import` | write-local | Import from native config |
| `am_apply` | write-local | Generate native IDE configs |
| `am_sync_push` | write-remote | Push config to git remote |
| `am_sync_pull` | write-remote | Pull config from git remote |

---

## 6. Encryption Architecture

`am` uses AES-256-GCM symmetric encryption via Web Crypto API for secrets in TOML.
Implementation is in `src/core/secrets.ts`.

### Crypto Pipeline

```mermaid
sequenceDiagram
    participant Caller
    participant Secrets as secrets.ts
    participant WebCrypto as Web Crypto API

    Note over Caller,WebCrypto: Key Generation
    Caller->>Secrets: generateKey()
    Secrets->>WebCrypto: subtle.generateKey("AES-GCM", 256)
    WebCrypto-->>Secrets: CryptoKey
    Secrets->>WebCrypto: subtle.exportKey("raw", key)
    Secrets-->>Caller: base64 string

    Note over Caller,WebCrypto: Encryption
    Caller->>Secrets: encryptValue(plaintext, key)
    Secrets->>WebCrypto: crypto.getRandomValues(12 bytes)
    Note over Secrets: Random IV per encryption
    Secrets->>WebCrypto: subtle.encrypt({name: "AES-GCM", iv}, key, encoded)
    Secrets-->>Caller: "enc:v1:ivBase64:ciphertextBase64"

    Note over Caller,WebCrypto: Decryption
    Caller->>Secrets: decryptValue("enc:v1:...", key)
    Secrets->>Secrets: Parse prefix, split IV and ciphertext
    Secrets->>WebCrypto: subtle.decrypt({name: "AES-GCM", iv}, key, ct)
    Secrets-->>Caller: plaintext string
```

### Key Functions

| Function | File | Purpose |
|----------|------|---------|
| `generateKey()` | `secrets.ts` | Generate 256-bit AES key, return base64 |
| `importKey(base64)` | `secrets.ts` | Import base64 string as CryptoKey |
| `loadKey(configDir)` | `secrets.ts` | Load key from env var or file |
| `saveKey(configDir, base64)` | `secrets.ts` | Write key to `.agent-manager/key.txt` (mode 0o600) |
| `encryptValue(plaintext, key)` | `secrets.ts` | AES-256-GCM encrypt, return `enc:v1:...` |
| `decryptValue(encrypted, key)` | `secrets.ts` | Decrypt `enc:v1:...`, passthrough non-encrypted |
| `isEncrypted(value)` | `secrets.ts` | Check if string starts with `enc:v1:` |
| `interpolateEnv(config)` | `secrets.ts` | Resolve `${VAR}` references synchronously |
| `interpolateEnvAsync(config, opts)` | `secrets.ts` | Resolve vars + decrypt `enc:v1:` values |

### Key Storage Locations

| Location | Priority | Use Case |
|----------|----------|----------|
| `AM_ENCRYPTION_KEY` env var | 1 (highest) | CI/CD, containers |
| `.agent-manager/key.txt` file | 2 | Local development (default) |
| Platform secrets (GitHub/GitLab) | via `am push` | Cross-machine distribution |

### HKDF for Session Cookies

The Cloudflare Workers web UI (`src/web/worker.ts`) uses HKDF to derive a separate
AES-256-GCM key from the `SESSION_SECRET` for encrypting session cookies. This is
separate from the config encryption pipeline:

```typescript
async function deriveKey(secret: string): Promise<CryptoKey> {
  const keyMaterial = await crypto.subtle.importKey("raw", encode(secret), "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey({
    name: "HKDF", hash: "SHA-256",
    salt: encode("agent-manager-session"),
    info: encode("aes-gcm-key"),
  }, keyMaterial, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}
```

---

## 7. Session Harvest Architecture

Session harvest (ADR-0016) provides cross-tool AI coding session discovery, export,
and search. The implementation spans `src/core/session.ts` (types and pure functions)
and adapter-level `SessionReader` implementations.

### Session Type Model

```mermaid
classDiagram
    class Session {
        +id: string
        +adapter: string
        +project?: string
        +messages: Message[]
        +startedAt: Date
        +endedAt?: Date
        +metadata?: Record
    }

    class Message {
        +role: string
        +content: string
        +timestamp?: Date
        +toolCalls?: ToolCall[]
    }

    class ToolCall {
        +name: string
        +input?: unknown
        +output?: string
    }

    class SessionSummary {
        +id: string
        +adapter: string
        +project?: string
        +messageCount: number
        +startedAt: Date
        +endedAt?: Date
        +estimatedTokens?: number
    }

    class SessionReader {
        +hasSessionStorage() boolean
        +listSessions(project?) Promise~SessionSummary[]~
        +loadSession(id) Promise~Session~
    }

    class SessionFilter {
        +roles?: string[]
        +noTools?: boolean
        +noSystem?: boolean
        +query?: string
    }

    Session --> Message
    Message --> ToolCall
    SessionReader --> SessionSummary
    SessionReader --> Session
```

### Filter Pipeline

`filterMessages()` in `src/core/session.ts` applies filters in a fixed order:

```mermaid
flowchart LR
    Input["All messages"]
    Input --> RoleFilter["Role filter<br/>(keep only specified roles)"]
    RoleFilter --> ToolFilter["noTools filter<br/>(remove role=tool)"]
    ToolFilter --> SystemFilter["noSystem filter<br/>(remove role=system)"]
    SystemFilter --> QueryFilter["Query filter<br/>(text search in content)"]
    QueryFilter --> Output["Filtered messages"]
```

### Formatting

Two output formatters:
- `formatMarkdown(session, filter?)` -- generates a markdown document with headers
  per message, tool call blocks, and session metadata
- `formatJson(session, filter?)` -- returns a JSON-serializable object with ISO
  timestamps, message array, and metadata

Token estimation: `estimateTokens(text)` uses a rough 4-characters-per-token
heuristic, suitable for cost estimation and sorting.

### Adapter Support

SessionReader is optional on the `Adapter` interface. Currently implemented by:
- **Claude Code**: reads JSONL from `~/.claude/projects/<encoded-path>/*.jsonl`
- **Codex CLI**: reads JSONL from `~/.codex/sessions/YYYY/MM/DD/*.jsonl`

Other adapters do not implement `SessionReader` because their tools either do not
persist sessions locally or use undocumented formats.

---

## 8. Web Architecture

`am` includes two web deployments: a local Hono server for desktop use and a
Cloudflare Workers deployment for browser-based management from any device.

### Local Server vs Cloudflare Workers

```mermaid
graph TD
    subgraph Local["Local Server (src/web/server.ts)"]
        HonoLocal["Hono on Bun<br/>am serve"]
        HonoLocal --> REST["REST API<br/>/api/config, /api/servers,<br/>/api/profiles, /api/status"]
        HonoLocal --> SSE["SSE Events<br/>/api/events<br/>(30s status updates)"]
        HonoLocal --> Static["Static HTML<br/>src/web/public/"]
        REST --> CoreLocal["Core Engine<br/>(direct function calls)"]
    end

    subgraph Cloud["Cloudflare Workers (src/web/worker.ts)"]
        HonoCloud["Hono on Workers"]
        HonoCloud --> OAuth["GitHub OAuth<br/>/auth/github/login<br/>/auth/github/callback"]
        HonoCloud --> CloudAPI["REST API<br/>/api/repos, /api/config/:owner/:repo,<br/>/api/servers/:owner/:repo"]
        OAuth --> Cookies["Encrypted cookies<br/>(AES-GCM via HKDF)"]
        CloudAPI --> GitHubAPI["GitHub API<br/>(Contents, OAuth)"]
    end
```

### Key Architectural Differences

| Aspect | Local Server | Cloudflare Workers |
|--------|-------------|-------------------|
| Config access | Direct filesystem | GitHub API |
| Authentication | None (localhost) | GitHub OAuth |
| Session storage | None needed | Encrypted cookies |
| State | Full core engine | Stateless (zero KV/D1/R2) |
| Apply support | Yes (`/api/apply`) | No (no filesystem) |
| Real-time | SSE events | Not implemented |

### OAuth Flow (Cloudflare Workers)

```mermaid
sequenceDiagram
    participant Browser
    participant Workers as Cloudflare Workers
    participant GitHub as GitHub OAuth

    Browser->>Workers: GET /auth/github/login
    Workers->>Workers: Generate CSRF state
    Workers->>Workers: Encrypt state into cookie (HKDF + AES-GCM)
    Workers-->>Browser: 302 to GitHub OAuth + state cookie

    Browser->>GitHub: Authorize app
    GitHub-->>Browser: 302 callback with code + state

    Browser->>Workers: GET /auth/github/callback?code=X&state=Y
    Workers->>Workers: Decrypt state cookie, verify CSRF
    Workers->>GitHub: Exchange code for access token
    GitHub-->>Workers: access_token
    Workers->>Workers: Encrypt token into session cookie
    Workers-->>Browser: 302 to / + session cookie

    Note over Browser,Workers: Subsequent API calls
    Browser->>Workers: GET /api/config/:owner/:repo
    Workers->>Workers: Decrypt session cookie
    Workers->>GitHub: GET /repos/:owner/:repo/contents/config.toml
    GitHub-->>Workers: File contents
    Workers-->>Browser: Parsed TOML config
```

### Stateless Design (ADR-0015)

The Workers deployment uses zero persistent storage. Config lives in the user's
GitHub repository (accessed via API). Sessions use AES-GCM encrypted cookies
derived via HKDF from the `SESSION_SECRET`. Each cookie contains the GitHub
access token encrypted with a 256-bit key. No KV, D1, or R2 bindings are used.

---

## 9. TUI Architecture

The terminal UI (`am tui`) uses Silvery (a React-for-terminals framework) with
Flexily for layout (ADR-0018).

### Component Hierarchy

```mermaid
graph TD
    TUI["am tui<br/>src/tui/index.tsx"]
    TUI --> App["App.tsx<br/>Root component<br/>Tab navigation + key handling"]

    App --> Dashboard["Dashboard.tsx<br/>Server count, profile,<br/>git status, quick actions"]
    App --> Profiles["ProfileSwitcher.tsx<br/>Interactive profile list<br/>with arrow-key selection"]
    App --> Status["StatusView.tsx<br/>Per-tool drift status<br/>change details"]
    App --> Help["HelpView.tsx<br/>Keybindings reference"]

    App --> Data["data.ts<br/>Load TUI data from core"]
    Data --> Core["Core Engine"]
```

### Views and Navigation

The TUI has four views, switchable via tab bar or keyboard shortcuts:

| View | Key | Component | Data Source |
|------|-----|-----------|-------------|
| Dashboard | `1` | `Dashboard.tsx` | Config, git status, adapter list |
| Profiles | `2` or `p` | `ProfileSwitcher.tsx` | Profile definitions |
| Status | `3` or `t` | `StatusView.tsx` | `adapter.diff()` per tool |
| Help | `?` | `HelpView.tsx` | Static keybindings |

Global keybindings: `q` (quit), `s` (sync), `a` (apply), `Tab` (cycle views).

### Why Silvery (ADR-0018)

Silvery replaced Ink because Ink's Yoga WASM dependency breaks `bun build --compile`.
Silvery uses Flexily (pure TypeScript layout engine) which compiles cleanly into the
single binary. The migration preserved all existing views and the React-like component
model (JSX, hooks, declarative rendering).

---

## 10. Build System

The build system in `scripts/build.ts` produces single-binary executables via
`bun build --compile`.

### Build Pipeline

```mermaid
flowchart LR
    Source["src/cli.ts<br/>(entry point)"]
    Source --> Patch["Patch @silvery/create<br/>(stub ag-term/buffer)"]
    Patch --> Compile["bun build --compile<br/>--minify<br/>--sourcemap=linked"]
    Compile --> Externalize["Externalize optional deps<br/>yoga-wasm-web<br/>@termless/*"]
    Externalize --> Binary["dist/am-darwin-arm64<br/>(single binary)"]
```

### The Silvery Patch Mechanism

`scripts/build.ts` patches `@silvery/create/src/create-app.tsx` before compilation.
The patch replaces a dynamic `require("@silvery/ag-term/buffer")` -- which only runs
on render mismatch detection -- with a no-op stub. This prevents a bundler resolution
failure without affecting runtime behavior.

The original file is backed up to `create-app.tsx.bak` and the patch is idempotent
(re-running build does not re-patch an already-patched file).

### Externalized Dependencies

Five optional Silvery dependencies are externalized via `--external` flags:

| Package | Why Externalized |
|---------|-----------------|
| `yoga-wasm-web` | WASM blob, not needed (Flexily replaces Yoga) |
| `yoga-wasm-web/auto` | Auto-loader for above |
| `@termless/core` | Headless testing framework, not needed at runtime |
| `@termless/xtermjs` | Xterm.js integration for testing |
| `@termless/ghostty` | Ghostty terminal integration for testing |

### Cross-Platform Targets

```mermaid
flowchart LR
    Build["scripts/build.ts"]
    Build -->|"--all"| All["All 5 targets"]
    Build -->|default| Mac["macOS ARM64 only"]
    Build -->|"--target bun-linux-x64"| Single["Specific target"]

    All --> T1["am-darwin-arm64"]
    All --> T2["am-darwin-x64"]
    All --> T3["am-linux-x64"]
    All --> T4["am-linux-arm64"]
    All --> T5["am-windows-x64.exe"]
```

---

## 11. Protocol Landscape

`am` sits at the center of three agent interoperability protocols (ADR-0017).

### Protocol Map

```mermaid
graph TD
    AM["am-cli<br/>(the central layer)"]

    subgraph Done["Integrated"]
        MCP["MCP<br/>(Agent-to-Tool)"]
    end

    subgraph Designed["Designed, Phase 2-3"]
        A2A["A2A<br/>(Agent-to-Agent)"]
    end

    subgraph Config["Config Management"]
        ACP["ACP<br/>(IDE-to-Agent)"]
    end

    AM --> MCP
    AM --> A2A
    AM --> ACP

    MCP --> MCPRole["am configures which tools<br/>agents use (servers in TOML)<br/>+ am IS an MCP server<br/>(am mcp-serve)"]

    A2A --> A2ARole["am will export AgentCards<br/>from agent profiles<br/>+ act as discovery hub<br/>+ broker delegation"]

    ACP --> ACPRole["am will configure which<br/>agents IDEs connect to<br/>(in IDE adapter configs)"]
```

### How Each Protocol Fits

| Protocol | am's Relationship | Status |
|----------|------------------|--------|
| **MCP** | am configures MCP servers AND implements an MCP server | Done (14 tools) |
| **A2A** | am will participate as discovery hub and delegation broker | Designed (ADR-0017 Phase 2-3) |
| **ACP** | am will generate ACP agent registrations in IDE configs | Designed (ADR-0017 Phase 1c) |

### Future Integration Points

- **A2A AgentCard export**: `am a2a export` generates AgentCards from `[agents]`
  profiles with `adapters.a2a` metadata
- **A2A server**: `am a2a serve` publishes all managed agents at
  `/.well-known/agent.json` for discovery
- **ACP config generation**: Kiro adapter extension to emit ACP agent registrations
  when Kiro ships its ACP config format

---

## 12. Data Flow Diagrams

### Export Flow: config.toml to Native Files

```mermaid
flowchart TD
    ConfigToml["config.toml<br/>(4 layers merged)"]
    ConfigToml --> LoadResolved["loadResolvedConfig()"]
    LoadResolved --> ProfileResolve["Resolve active profile<br/>(inheritance chain)"]
    ProfileResolve --> Interpolate["interpolateEnvAsync()<br/>1. Resolve ${VAR}<br/>2. Decrypt enc:v1:..."]
    Interpolate --> Build["buildResolvedConfig()<br/>Map servers, instructions,<br/>skills, agents"]
    Build --> ResolvedConfig["ResolvedConfig"]
    ResolvedConfig --> Detect["getDetectedAdapters()"]

    Detect --> CC["Claude Code<br/>adapter.export()"]
    Detect --> CU["Cursor<br/>adapter.export()"]
    Detect --> KI["Kiro<br/>adapter.export()"]
    Detect --> More["... other adapters"]

    CC --> CCFiles["~/.claude.json<br/>.mcp.json<br/>CLAUDE.md"]
    CU --> CUFiles["~/.cursor/mcp.json<br/>.cursor/rules/*.mdc"]
    KI --> KIFiles[".kiro/mcp.json<br/>.kiro/steering/*.md"]
```

### Import Flow: Native Files to config.toml

```mermaid
flowchart TD
    NativeFiles["Native config files<br/>(~/.claude.json,<br/>.cursor/mcp.json, ...)"]
    NativeFiles --> AdapterImport["adapter.import()"]
    AdapterImport --> ImportResult["ImportResult<br/>(servers, instructions, skills)"]
    ImportResult --> Dedup["Deduplicate<br/>1. Name match<br/>2. Package identity<br/>3. Command basename"]
    Dedup --> Merge["Merge into existing config"]
    Merge --> WriteConfig["writeConfig(config.toml)"]
    WriteConfig --> Commit["commitAll(configDir, message)"]
    Commit --> ConfigToml["config.toml<br/>(updated + committed)"]
```

### Full Round-Trip

```mermaid
flowchart LR
    subgraph Source["Source of Truth"]
        TOML["config.toml"]
    end

    subgraph Export["am apply"]
        ResolveExport["Resolve + decrypt<br/>+ build"]
    end

    subgraph Native["Native Configs"]
        Files["IDE-specific files"]
    end

    subgraph Import["am import"]
        Parse["Parse + dedup<br/>+ merge"]
    end

    subgraph Drift["am status"]
        Compare["Structural diff<br/>adapter.diff()"]
    end

    TOML --> ResolveExport --> Files
    Files --> Parse --> TOML
    Files --> Compare
    TOML --> Compare
    Compare --> DriftResult["in-sync / drifted / unmanaged"]
```
