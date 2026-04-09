# Adapter Development Guide

This guide walks through creating a new adapter for agent-manager. An adapter is a
bidirectional translator between agent-manager's core TOML config and a specific AI
coding tool's native configuration files.

## What is an Adapter?

Every AI coding tool stores configuration differently -- Claude Code uses
`~/.claude.json` and `.mcp.json`, Cursor uses `~/.cursor/mcp.json`, Kiro uses
`.kiro/mcp.json`, Kilo Code uses `~/.kilo-code/mcp_settings.json` (JSONC format),
and so on.

An adapter handles three operations:

| Operation | Direction | Purpose |
|-----------|-----------|---------|
| **import** | native -> core | Read native config files, convert to core TOML format |
| **export** | core -> native | Take resolved config, write native config files |
| **diff** | compare | Structural comparison for drift detection |

Plus detection (is the tool installed?) and schema validation (Zod schemas for
adapter-specific TOML fields).

## Current Adapters

All 13 adapters are fully implemented with detect, import, export, and diff:

| Adapter | Tool | Key Complexity |
|---------|------|----------------|
| `claude-code` | Claude Code | Reference impl; identity.ts for server dedup, SessionReader |
| `codex-cli` | Codex CLI | YAML config format, AGENTS.md instructions, SessionReader |
| `copilot` | GitHub Copilot | Multi-file instructions (.instructions.md) |
| `cursor` | Cursor | .mdc frontmatter for scoped rules |
| `forgecode` | ForgeCode | Similar to Kilo Code format |
| `kilo-code` | Kilo Code | JSONC parsing (comments + trailing commas), identity.ts, modes |
| `kiro` | Kiro | Steering files with YAML frontmatter, identity.ts, specs |
| `windsurf` | Windsurf | Trigger-based rule frontmatter |
| `gemini-cli` | Gemini CLI | Simple JSON config, GEMINI.md instructions |
| `cline` | Cline | VS Code globalStorage paths, .clinerules |
| `roo-code` | Roo Code | VS Code globalStorage paths, modes support |
| `amazon-q` | Amazon Q | ~/.aws/amazonq/mcp.json |
| `continue` | Continue.dev | ~/.continue/config.json |

## The Adapter Interface

Defined in `src/adapters/types.ts`:

```typescript
interface Adapter {
  meta: AdapterMeta;                  // name, displayName, version, capabilities
  detect(): DetectResult;             // is this tool installed?
  import(options: ImportOptions): ImportResult;     // native -> core
  export(config: ResolvedConfig, options: ExportOptions): ExportResult;  // core -> native
  diff(config: ResolvedConfig): DiffResult;         // detect drift
  schema: AdapterSchema;              // Zod schemas for adapter TOML fields
}
```

**Key types:**

- `AdapterMeta` -- name, displayName, version, and a `capabilities` array declaring
  what this adapter supports (`mcp`, `instructions`, `permissions`, `models`, `skills`,
  `plugins`, `agents`, `hooks`, `modes`).
- `DetectResult` -- `{ installed: boolean, version?: string, paths: Record<string, string> }`
- `ImportResult` -- lists of `ImportedServer[]`, `ImportedInstruction[]`, `ImportedSkill[]`,
  plus `warnings: string[]`
- `ExportResult` -- `{ files: WrittenFile[], warnings: string[] }` where `WrittenFile`
  includes path, content, and a `written` boolean (false during dry-run)
- `DiffResult` -- `{ status: "in-sync" | "drifted" | "unmanaged", changes: DiffChange[] }`
- `AdapterSchema` -- Zod schemas for `server`, `instruction`, and `global` adapter sections

## Step-by-Step: Creating a New Adapter

We'll use a hypothetical "example-tool" adapter. Study the existing adapters for
patterns -- the Claude Code adapter is the reference implementation, while Windsurf
is the simplest and Kilo Code is the most complex.

### 1. Create the Directory

```bash
mkdir -p src/adapters/example-tool
```

### 2. Implement detect.ts

Check whether the tool is installed by looking for its config files or binary.

```typescript
import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { DetectResult } from "../types.ts";

export function detect(homeDir?: string): DetectResult {
  const home = homeDir ?? homedir();
  const paths: Record<string, string> = {};

  const configDir = join(home, ".example-tool");
  if (existsSync(configDir)) {
    paths.configDir = configDir;
  }

  const mcpJson = join(home, ".example-tool", "mcp.json");
  if (existsSync(mcpJson)) {
    paths.mcpConfig = mcpJson;
  }

  return {
    installed: Object.keys(paths).length > 0,
    paths,
  };
}
```

**Key pattern:** Accept an optional `homeDir` parameter. This lets tests override the
home directory to use temp fixtures instead of the real filesystem.

### 3. Implement import.ts

Read native config files and convert to the core `ImportResult` format.

- Read the tool's config files (JSON, YAML, TOML, JSONC, etc.)
- Convert servers to `ImportedServer[]` with `name`, `command`, `args`, `env`, `scope`
- Convert instructions to `ImportedInstruction[]`
- Put tool-specific fields (not in the core schema) into `adapterExtras`
- Use identity matching (see `claude-code/identity.ts`, `kilo-code/identity.ts`,
  `kiro/identity.ts`) for server deduplication

**Handle missing files gracefully:** Push a warning string, don't throw. The user
may have the tool installed but no servers configured.

**JSONC parsing note:** If the tool uses JSONC (JSON with Comments), see the
Kilo Code adapter's `jsonc.ts` for a lightweight parser that strips comments and
trailing commas before JSON.parse. This avoids a heavy dependency.

### 4. Implement export.ts

Take a `ResolvedConfig` and write the tool's native config files.

- Filter servers/instructions to those targeting this adapter
- Generate the tool's native file format
- Preserve existing non-managed fields (read the file first, merge, write back)
- Use `WrittenFile[]` for dry-run support -- set `written: false` when `dryRun` is true
- For instruction files, use the shared generators in `src/core/instructions.ts`:
  - `generateClaudeMd()` / `generateAgentsMd()` for marker-based formats
  - `generateCursorMdc()` for .mdc frontmatter
  - `generateWindsurfRule()` for .windsurf/rules format
  - `generateKiroSteering()` for .kiro/steering format
  - `generateCopilotInstruction()` for .github/instructions format

**Critical:** Always preserve fields you don't manage. If the native config has
`"theme": "dark"` and you only manage `mcpServers`, keep the theme setting.

### 5. Implement diff.ts

Compare the current resolved config against native files to detect drift.

- Read native config into a normalized object
- Compare against the resolved config field by field
- Apply normalization before comparing:
  - Sort object keys alphabetically
  - Treat missing/null as equivalent for optional fields
  - Normalize paths (resolve `~`, remove trailing slashes)
  - Treat `[]` and missing as equivalent for arrays

Return a `DiffResult`:

```typescript
{ status: "in-sync", changes: [] }              // everything matches
{ status: "drifted", changes: [...] }            // differences found
{ status: "unmanaged", changes: [] }             // native file doesn't exist
```

Each `DiffChange` specifies the entity type, name, change type (`added-locally`,
`removed-locally`, `modified`, `added-in-config`), and optional field-level details.

### 6. Implement schema.ts

Define Zod schemas for adapter-specific TOML fields. These validate the
`[servers.<name>.adapters.<your-adapter>]` and `[adapters.<your-adapter>]` sections.

```typescript
import { z } from "zod";
import type { AdapterSchema } from "../types.ts";

export const exampleServerSchema = z.object({
  // Fields specific to this tool's server config
}).passthrough();

export const exampleGlobalSchema = z.object({
  // Global adapter settings
}).passthrough();

export const exampleSchema: AdapterSchema = {
  server: exampleServerSchema,
  global: exampleGlobalSchema,
};
```

**Always use `.passthrough()`** on schemas so unrecognized fields are preserved rather
than stripped.

### 7. Wire Up index.ts

Export the adapter object that implements the full `Adapter` interface:

```typescript
import type { Adapter, Capability, ImportOptions, ImportResult,
  ExportOptions, ExportResult, ResolvedConfig, DiffResult } from "../types.ts";
import { detect } from "./detect.ts";
import { importConfig } from "./import.ts";
import { exportConfig } from "./export.ts";
import { diffConfig } from "./diff.ts";
import { exampleSchema } from "./schema.ts";

const CAPABILITIES: Capability[] = ["mcp", "instructions"];

export const exampleToolAdapter: Adapter = {
  meta: {
    name: "example-tool",
    displayName: "Example Tool",
    version: "0.1.0",
    capabilities: CAPABILITIES,
  },
  detect: () => detect(),
  import: (options: ImportOptions): ImportResult => importConfig(options),
  export: (config: ResolvedConfig, options: ExportOptions): ExportResult =>
    exportConfig(config, options),
  diff: (config: ResolvedConfig): DiffResult => diffConfig(config),
  schema: exampleSchema,
};
```

### 8. Register in registry.ts

Add a lazy factory entry to `src/adapters/registry.ts`:

```typescript
const ADAPTER_FACTORIES: Record<string, AdapterFactory> = {
  // ... existing adapters ...
  "example-tool": async () => {
    const { exampleToolAdapter } = await import("./example-tool/index.ts");
    return exampleToolAdapter;
  },
};
```

The lazy factory pattern means the adapter code is only loaded when requested.
All adapters ship in the binary but unused ones are never instantiated (ADR-0011).

### 9. Add Tests

Create `test/adapters/example-tool/` with test files mirroring the source modules:

```
test/adapters/example-tool/
  detect.test.ts        # Detection with mocked filesystem
  import.test.ts        # Import from fixture configs
  export.test.ts        # Export to temp directories, verify output
  diff.test.ts          # Drift detection scenarios
  roundtrip.test.ts     # Import -> export -> diff = in-sync
```

**Testing patterns from the existing adapters:**

- Use temp directories (`mkdtemp`) for filesystem tests
- Pass `homeDir` overrides to avoid touching the real home directory
- Create fixture JSON/TOML files in the temp dir before each test
- Verify `WrittenFile[]` contents in export tests without hitting disk (`dryRun: true`)
- The roundtrip test is the most valuable: import native config, export it back, run
  diff, and assert `status: "in-sync"`

Run tests:

```bash
bun test test/adapters/example-tool/
```

## Platform Adapter Development

Platform adapters in `src/platforms/` handle git remote URL detection and operations.
They are simpler than IDE adapters -- typically a single file.

### Interface

From `src/platforms/types.ts`:

```typescript
interface GitPlatformAdapter {
  meta: { name: string; displayName: string };
  detect(remoteUrl: string): boolean;
}
```

### Adding a Platform Adapter

1. Create `src/platforms/<name>.ts`
2. Implement the `GitPlatformAdapter` interface
3. Add to the `PLATFORMS` array in `src/platforms/registry.ts`
4. Order matters: more specific platforms first, `bare` is always last as fallback

Current platforms: GitHub, GitLab, bare git.

## Key Patterns

### homeDir Override

Every adapter function that touches the filesystem should accept an optional `homeDir`
parameter. This is the primary testing seam -- it lets tests point to a temp directory
instead of `~/`:

```typescript
export function detect(homeDir?: string): DetectResult {
  const home = homeDir ?? homedir();
  // ...
}
```

### JSONC Parsing

Some tools (Kilo Code, potentially others) use JSONC (JSON with Comments) for config
files. The Kilo Code adapter includes a lightweight JSONC parser at
`src/adapters/kilo-code/jsonc.ts` that strips `//` and `/* */` comments plus trailing
commas before feeding to `JSON.parse`. Use this pattern rather than adding a heavy
JSONC dependency.

### Shared Instruction Generation

The `src/core/instructions.ts` module provides format-specific generators:

| Function | Format | Used By |
|----------|--------|---------|
| `generateClaudeMd()` | `<!-- am:begin -->` markers in CLAUDE.md | Claude Code |
| `generateAgentsMd()` | `<!-- am:begin -->` markers in AGENTS.md | Codex CLI |
| `generateCursorMdc()` | YAML frontmatter `.mdc` files | Cursor |
| `generateWindsurfRule()` | Trigger-based `.md` rules | Windsurf |
| `generateKiroSteering()` | Inclusion-based steering `.md` | Kiro |
| `generateCopilotInstruction()` | `applyTo` frontmatter `.instructions.md` | Copilot |

New adapters should add a generator here if their instruction format differs from existing ones.

### WrittenFile[] for Dry-Run

Export returns `WrittenFile[]` with a `written` boolean. When `dryRun` is true, the
adapter builds the file contents but doesn't write them. This supports `am apply --dry-run`
and makes export easily testable.

### DiffResult for Drift Detection

The diff module does structural comparison, not textual diff. Normalize before
comparing (sort keys, strip defaults, resolve paths). This avoids false positives
from whitespace or key ordering differences.

### Graceful Missing Files

Never crash on missing files. If a config file doesn't exist, push a warning and
return empty results. The user may have the tool installed but not yet configured.

### Preserve Non-Managed Fields

When writing to an existing config file, read it first and merge. If `~/.cursor/mcp.json`
has settings beyond `mcpServers`, preserve them in the output.

### Normalize Before Comparing

In diff, normalize both sides before comparing:
- Sort object keys
- Treat `null`, `undefined`, and missing as equivalent for optional fields
- Treat `[]` and missing as equivalent for arrays
- Resolve `~` in paths

## Reference: Adapter Patterns

Study these adapters before writing a new one. Most follow the same structure
with different file paths and format-specific parsing.

| Adapter | Notable Features |
|---------|------------------|
| `claude-code` | Reference impl, identity.ts for server dedup, SessionReader |
| `codex-cli` | YAML config, AGENTS.md instructions, SessionReader |
| `copilot` | Multi-file .instructions.md with applyTo frontmatter |
| `cursor` | .mdc frontmatter rules, scoped instructions |
| `forgecode` | Similar structure to Kilo Code |
| `kilo-code` | JSONC parser, identity.ts, modes support |
| `kiro` | Steering files, identity.ts, spec awareness |
| `windsurf` | Simple adapter, good template for new ones |
| `gemini-cli` | Simple JSON config, GEMINI.md |
| `cline` | VS Code globalStorage paths, .clinerules |
| `roo-code` | VS Code globalStorage paths, modes |
| `amazon-q` | AWS-specific config paths |
| `continue` | ~/.continue/config.json |
