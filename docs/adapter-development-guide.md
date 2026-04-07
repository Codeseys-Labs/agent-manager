# Adapter Development Guide

This guide walks through creating a new adapter for agent-manager. An adapter is a
bidirectional translator between agent-manager's core TOML config and a specific AI
coding tool's native configuration files.

## What is an Adapter?

Every AI coding tool stores configuration differently -- Claude Code uses
`~/.claude.json` and `.mcp.json`, Cursor uses `~/.cursor/mcp.json`, Copilot uses
`.github/copilot-instructions.md`, and so on.

An adapter handles three operations:

| Operation | Direction | Purpose |
|-----------|-----------|---------|
| **import** | native -> core | Read native config files, convert to core TOML format |
| **export** | core -> native | Take resolved config, write native config files |
| **diff** | compare | Structural comparison for drift detection |

Plus detection (is the tool installed?) and schema validation (Zod schemas for
adapter-specific TOML fields).

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

We'll use a hypothetical "cursor" adapter as the example. The Claude Code adapter
(`src/adapters/claude-code/`) is the reference implementation -- 7 files, ~808 lines
total, with 5 test files (~1094 lines).

### 1. Create the Directory

```bash
mkdir -p src/adapters/cursor
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

  const configDir = join(home, ".cursor");
  if (existsSync(configDir)) {
    paths.configDir = configDir;
  }

  const mcpJson = join(home, ".cursor", "mcp.json");
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

- Read the tool's config files (JSON, YAML, TOML, etc.)
- Convert servers to `ImportedServer[]` with `name`, `command`, `args`, `env`, `scope`
- Convert instructions to `ImportedInstruction[]`
- Put tool-specific fields (not in the core schema) into `adapterExtras`
- Use `extractPackageId()` from the Claude Code adapter's `identity.ts` (or factor it
  out to a shared utility) for server deduplication

**Handle missing files gracefully:** Push a warning string, don't throw. The user
may have the tool installed but no servers configured.

### 4. Implement export.ts

Take a `ResolvedConfig` and write the tool's native config files.

- Filter servers/instructions to those targeting this adapter
- Generate the tool's native file format
- Preserve existing non-managed fields (read the file first, merge, write back)
- Use `WrittenFile[]` for dry-run support -- set `written: false` when `dryRun` is true
- For instruction files, use `<!-- am:begin -->` / `<!-- am:end -->` markers to
  manage a section within existing content

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

export const cursorServerSchema = z.object({
  // Fields specific to this tool's server config
}).passthrough();

export const cursorGlobalSchema = z.object({
  // Global adapter settings
}).passthrough();

export const cursorSchema: AdapterSchema = {
  server: cursorServerSchema,
  global: cursorGlobalSchema,
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
import { cursorSchema } from "./schema.ts";

const CAPABILITIES: Capability[] = ["mcp", "instructions", "permissions", "models"];

export const cursorAdapter: Adapter = {
  meta: {
    name: "cursor",
    displayName: "Cursor",
    version: "0.1.0",
    capabilities: CAPABILITIES,
  },
  detect: () => detect(),
  import: (options: ImportOptions): ImportResult => importConfig(options),
  export: (config: ResolvedConfig, options: ExportOptions): ExportResult =>
    exportConfig(config, options),
  diff: (config: ResolvedConfig): DiffResult => diffConfig(config),
  schema: cursorSchema,
};
```

### 8. Register in registry.ts

Add a lazy factory entry to `src/adapters/registry.ts`:

```typescript
const ADAPTER_FACTORIES: Record<string, AdapterFactory> = {
  "claude-code": async () => {
    const { claudeCodeAdapter } = await import("./claude-code/index.ts");
    return claudeCodeAdapter;
  },
  "cursor": async () => {
    const { cursorAdapter } = await import("./cursor/index.ts");
    return cursorAdapter;
  },
};
```

The lazy factory pattern means the adapter code is only loaded when requested.
All adapters ship in the binary but unused ones are never instantiated (ADR-0011).

### 9. Add Tests

Create `test/adapters/cursor/` with test files mirroring the source modules:

```
test/adapters/cursor/
  detect.test.ts        # Detection with mocked filesystem
  import.test.ts        # Import from fixture configs
  export.test.ts        # Export to temp directories, verify output
  diff.test.ts          # Drift detection scenarios
  roundtrip.test.ts     # Import -> export -> diff = in-sync
```

**Testing patterns from the Claude Code adapter:**

- Use temp directories (`mkdtemp`) for filesystem tests
- Pass `homeDir` overrides to avoid touching the real home directory
- Create fixture JSON/TOML files in the temp dir before each test
- Verify `WrittenFile[]` contents in export tests without hitting disk (`dryRun: true`)
- The roundtrip test is the most valuable: import native config, export it back, run
  diff, and assert `status: "in-sync"`

Run tests:

```bash
bun test test/adapters/cursor/
```

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

## Tools That Need Adapters

Based on research, these tools are candidates for adapters (priority from the design spec):

| Tool | Priority | Config Format | Key Files |
|------|----------|---------------|-----------|
| Cursor | P0 | JSON | `~/.cursor/mcp.json`, `.cursor/rules/*.mdc` |
| Windsurf | P1 | JSON + MD | `~/.windsurf/mcp.json`, `.windsurf/rules/*.md` |
| Copilot | P1 | JSON + MD | `.vscode/mcp.json`, `.github/instructions/*.md` |
| Cline | P1 | JSON | `~/.cline/mcp_settings.json` |
| Roo Code | P1 | JSON | `~/.roo-code/mcp_settings.json`, `.roo/` modes |
| Continue | P2 | JSON | `~/.continue/config.json` |
| Gemini CLI | P2 | JSON | `~/.gemini/settings.json`, `GEMINI.md` |
| Codex CLI | P2 | YAML + MD | `~/.codex/config.yaml`, `AGENTS.md` |
| Kilo Code | P2 | JSON | `~/.kilo-code/mcp_settings.json` |
| Kiro | P2 | JSON | `.kiro/mcp.json`, `.kiro/specs/` |
| ForgeCode | P2 | JSON | `~/.forgecode/mcp_settings.json` |
| Amazon Q | P2 | JSON | `.amazonq/mcp.json` |

## Reference: Claude Code Adapter

The Claude Code adapter is the reference implementation. File sizes:

| File | Lines | Purpose |
|------|-------|---------|
| `detect.ts` | 70 | Check for `~/.claude.json`, `~/.claude/`, project configs |
| `identity.ts` | 88 | Package ID extraction for server deduplication |
| `import.ts` | 182 | Read `~/.claude.json` + `.mcp.json` + `CLAUDE.md` |
| `export.ts` | 201 | Write `~/.claude.json` + `.mcp.json` + `CLAUDE.md` |
| `diff.ts` | 172 | Structural comparison with key sorting + normalization |
| `schema.ts` | 42 | Zod schemas for `always_allow`, `permission_mode`, etc. |
| `index.ts` | 53 | Wire everything together, export adapter object |
| **Total** | **808** | |

Tests (5 files, ~1094 lines):

| Test File | Lines | Covers |
|-----------|-------|--------|
| `detect.test.ts` | 90 | File existence, version detection, project paths |
| `import.test.ts` | 221 | Global + project servers, CLAUDE.md, malformed JSON |
| `export.test.ts` | 204 | File generation, marker preservation, dry-run |
| `diff.test.ts` | 240 | In-sync, drifted, added/removed servers, field changes |
| `roundtrip.test.ts` | 142 | Import -> export -> diff = in-sync |

Study these files before writing a new adapter. Most adapters will follow the same
structure with different file paths and format-specific parsing.
