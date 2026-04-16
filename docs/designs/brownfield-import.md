# Design: Brownfield Import Merge

**Date:** 2026-04-14
**Status:** Draft
**ADR:** [0028-brownfield-import-merge](../../ADRs/0028-brownfield-import-merge.md)

## Problem

A user has been manually managing MCP configs across Claude Code, Cursor, and Kiro
for months. Servers overlap — the same MCP server appears in multiple tools with
slightly different args, env vars, or names. The user has also partially migrated
some servers into `am.toml` already (brownfield state).

Current `am import` behavior:
1. Reads native configs via adapters
2. Deduplicates by **identity** (command+args → canonical package ID)
3. **Skips** any server whose identity matches an existing `config.toml` entry
4. Appends new servers verbatim

This fails three ways in brownfield scenarios:

| Failure | Example |
|---------|---------|
| **Silent data loss** | Cursor has `tavily-mcp` with `TAVILY_API_KEY=prod-key`; config.toml has it with `TAVILY_API_KEY=dev-key`. Import skips Cursor's version — prod key is lost. |
| **No conflict visibility** | User has no way to see *what* differs between the two versions before import discards one. |
| **Partial migration gaps** | User migrated 8 of 12 servers. The 4 remaining have slight command differences (e.g., `bunx` vs `npx`) that cause identity mismatch → duplicates. |

## Design

### Merge Pipeline

The brownfield import adds a **merge phase** between identity matching and config writing:

```
Adapters  ──import──>  Imported Servers
                            │
                   ┌────────┴────────┐
                   │  Identity Match  │  (existing extractServerIdentity)
                   └────────┬────────┘
                            │
              ┌─────────────┼─────────────┐
              │             │             │
           New          Duplicate     Conflict
         (no match)    (identical)   (same identity,
              │             │         different fields)
              │             │             │
           Add to        Skip          ┌──┴──┐
           config                   Interactive │
                                    resolution  │
                                       └──┬──┘
                                          │
                              ┌───────────┼───────────┐
                              │           │           │
                           Keep A     Keep B      Merge
                          (existing)  (incoming)  (union)
```

### Identity Matching (Enhanced)

The current `extractServerIdentity()` in `src/commands/import.ts` is good for
exact dedup but too coarse for merge. We need a **two-tier match**:

**Tier 1 — Exact identity match** (existing behavior):
Same canonical package ID → duplicate or conflict.

**Tier 2 — Fuzzy identity match** (new):
For servers that don't match on Tier 1, check:
- Command basename matches but runner differs (`npx tavily-mcp` vs `bunx tavily-mcp`)
- Name matches across adapters (both called `tavily` in different tools)
- Endpoint URL matches with different proxy wrappers

Fuzzy matches are flagged for user review, not auto-resolved.

```typescript
interface IdentityMatch {
  type: "exact" | "fuzzy";
  existingName: string;           // Name in config.toml
  incomingServer: ImportedServer;  // From adapter import
  identity: string;               // Canonical identity string
  fuzzyReason?: string;           // e.g., "command basename match", "name match"
}
```

### Conflict Detection

When identity matches but fields differ, compute a structured diff:

```typescript
interface ServerConflict {
  identity: string;
  existingName: string;
  existingServer: Server;         // From config.toml
  incomingServer: ImportedServer; // From adapter
  incomingSource: string;         // Adapter name (e.g., "cursor")
  diffs: FieldDiff[];
}

interface FieldDiff {
  field: string;          // "command" | "args" | "env.TAVILY_API_KEY" | "enabled" | ...
  existing: unknown;
  incoming: unknown;
  recommendation: "keep-existing" | "keep-incoming" | "merge";
}
```

**Diff field categories:**

| Category | Fields | Default recommendation |
|----------|--------|----------------------|
| Identity | command, args[0] (package) | Keep existing (already working) |
| Runner | command prefix (npx/bunx/uvx) | Keep existing |
| Arguments | args[1..n] | Merge (union unique args) |
| Env vars | env.* | Merge (incoming wins on conflict) |
| Metadata | description, tags | Merge (union tags, longer description) |
| State | enabled | Keep existing |
| Adapter extras | adapterExtras.* | Merge (per-adapter passthrough) |

### Resolution Strategies

#### Interactive Mode (default)

For each conflict, display a side-by-side diff and prompt:

```
╭─ Conflict: tavily-mcp ────────────────────────────────────╮
│                                                             │
│  Identity: tavily-mcp                                       │
│  Sources: config.toml (existing) vs cursor (incoming)       │
│                                                             │
│  command:  bunx tavily-mcp@latest                           │
│        vs  npx -y tavily-mcp@0.3.2                          │
│                                                             │
│  env.TAVILY_API_KEY:                                        │
│        A: ${TAVILY_API_KEY}  (encrypted ref)                │
│        B: tvly-prod-xxxxx   (raw value)                     │
│                                                             │
│  tags:                                                      │
│        A: [search, web]                                     │
│        B: [search]                                          │
│                                                             │
│  (k)eep existing  (u)se incoming  (m)erge  (s)kip           │
╰─────────────────────────────────────────────────────────────╯
```

Resolution actions:

| Key | Action | Behavior |
|-----|--------|----------|
| `k` | Keep existing | No changes to config.toml entry |
| `u` | Use incoming | Replace config.toml entry with incoming |
| `m` | Merge | Apply merge strategy (see below) |
| `s` | Skip | Do nothing, leave conflict unresolved |
| `e` | Edit | Open field-by-field selection (advanced) |

#### Merge Strategy

When the user selects merge (or `--auto` picks it):

1. **Command:** Keep existing (it's the one that's been working)
2. **Args:** Union of unique arguments, existing order preserved
3. **Env vars:**
   - Existing encrypted refs (`${VAR}`) are preserved
   - Incoming raw values are encrypted and added to `settings.env`
   - Incoming vars not in existing are added
   - Conflicting vars: incoming wins (it's the "newer" config)
4. **Tags:** Union of both tag sets
5. **Description:** Keep longer description, or incoming if existing is empty
6. **Enabled:** Keep existing state
7. **Adapter extras:** Deep merge, incoming wins on key conflict

```typescript
function mergeServers(existing: Server, incoming: ImportedServer): Server {
  return {
    command: existing.command,
    args: unionArgs(existing.args, incoming.args),
    env: mergeEnv(existing.env, incoming.env),
    transport: existing.transport,
    description: pickLonger(existing.description, incoming.description),
    tags: unionTags(existing.tags, incoming.tags),
    enabled: existing.enabled,
    _registry: existing._registry,  // Preserve provenance
    adapters: deepMerge(existing.adapters, adapterExtrasToAdapters(incoming)),
  };
}
```

#### Auto Mode (`--auto`)

`am import --auto <source>` resolves all conflicts without prompting:

1. Exact identity match + no field diffs → skip (already imported)
2. Exact identity match + field diffs → **merge** (union strategy above)
3. Fuzzy identity match → **skip** with warning (too risky to auto-resolve)
4. No match → **add** as new server

Auto mode picks the "most complete" config: the version with more env vars,
more args, and a description wins on ambiguous fields.

```typescript
function autoResolve(conflict: ServerConflict): "skip" | "merge" | "use-incoming" {
  if (conflict.diffs.length === 0) return "skip";

  // If existing has encrypted refs, always merge (don't lose encryption)
  const hasEncryptedRefs = Object.values(conflict.existingServer.env ?? {})
    .some(v => v.startsWith("${") && v.endsWith("}"));
  if (hasEncryptedRefs) return "merge";

  // If incoming has strictly more fields, use it
  const incomingCompleteness = computeCompleteness(conflict.incomingServer);
  const existingCompleteness = computeCompleteness(conflict.existingServer);
  if (incomingCompleteness > existingCompleteness * 1.2) return "use-incoming";

  return "merge";
}
```

### Brownfield State Detection

Before starting import, scan config.toml and all detected adapters to build
a **brownfield report**:

```typescript
interface BrownfieldReport {
  existingServers: number;            // Count in config.toml
  adapterServers: Map<string, number>; // Count per adapter
  conflicts: ServerConflict[];
  newServers: ImportedServer[];       // Only in adapters, not in config.toml
  orphanedServers: string[];          // In config.toml but not in any adapter
}
```

The report is shown before any merge actions:

```
Brownfield Import Report
────────────────────────
  config.toml:  12 servers
  claude-code:  15 servers (8 match, 4 conflicts, 3 new)
  cursor:       10 servers (6 match, 2 conflicts, 2 new)
  kiro:          8 servers (5 match, 1 conflict, 2 new)

  Conflicts:  7 servers need resolution
  New:        5 servers to add
  Orphaned:   2 servers only in config.toml (not in any tool)

  Run with --auto to auto-resolve, or continue for interactive merge.
```

### CLI Interface

```bash
# Interactive brownfield merge (default when config.toml exists)
am import auto

# Auto-resolve all conflicts
am import auto --auto

# Import from specific adapter with merge
am import cursor

# Preview conflicts without making changes
am import auto --dry-run

# Show brownfield report only
am import auto --report
```

New flags on `am import`:

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--auto` | boolean | false | Auto-resolve conflicts (no prompts) |
| `--dry-run` | boolean | false | Show what would change, don't write |
| `--report` | boolean | false | Show brownfield report only |
| `--strategy` | enum | merge | Default resolution: `merge`, `keep-existing`, `keep-incoming` |

### JSON Output

`am import auto --json` returns structured merge results:

```json
{
  "action": "import",
  "source": "auto",
  "brownfield": true,
  "report": {
    "existing": 12,
    "adapters": { "claude-code": 15, "cursor": 10, "kiro": 8 },
    "conflicts": 7,
    "new": 5,
    "orphaned": 2
  },
  "resolutions": [
    {
      "identity": "tavily-mcp",
      "action": "merge",
      "source": "cursor",
      "diffs": [
        { "field": "env.TAVILY_API_KEY", "action": "keep-existing" },
        { "field": "tags", "action": "merged", "result": ["search", "web"] }
      ]
    }
  ],
  "imported": 5,
  "merged": 4,
  "skipped": 3
}
```

## Implementation

### Files to modify

| File | Changes |
|------|---------|
| `src/commands/import.ts` | Add merge phase between identity match and write. Add `--auto`, `--dry-run`, `--report`, `--strategy` flags. |
| `src/core/merge.ts` | **New.** `ServerConflict`, `FieldDiff`, `BrownfieldReport` types. `detectConflicts()`, `mergeServers()`, `autoResolve()`, `computeCompleteness()` functions. |
| `src/lib/prompts.ts` | **New or extend.** Interactive conflict resolution UI (uses silvery TUI or falls back to readline). |
| `src/commands/import.ts` → `extractServerIdentity()` | Add fuzzy matching tier. |

### Migration path

The merge behavior activates automatically when `config.toml` already has servers.
First-time `am import auto` (greenfield) behaves exactly as today — no merge phase,
just append.

```typescript
const isBrownfield = config.servers && Object.keys(config.servers).length > 0;
if (isBrownfield) {
  // New merge pipeline
} else {
  // Existing append pipeline
}
```

### Edge cases

| Case | Handling |
|------|----------|
| Same server in 3+ adapters | Show all versions in conflict UI; user picks one or merges |
| Server in config.toml but no adapter | Listed as "orphaned" in report; not touched during import |
| Encrypted env ref vs raw value | Merge preserves encrypted ref; incoming raw value is offered as update |
| Server with `_registry` provenance | Registry metadata preserved; version tracked for `am update` |
| `--auto` with fuzzy matches | Always warns, never auto-resolves fuzzy matches |

## Testing Strategy

- Unit tests for `mergeServers()` with various field combinations
- Unit tests for `detectConflicts()` with overlapping adapter results
- Unit tests for fuzzy identity matching (runner swaps, name matches)
- Integration tests: multi-adapter import into pre-populated config.toml
- Snapshot tests for brownfield report output formatting
- E2E: `am import auto --auto --json` with fixture configs

## Future Extensions

- `am merge <file>` — merge an arbitrary TOML config file into config.toml
- `am import --adopt` — reverse orphan detection: adopt config.toml-only servers into native configs
- Conflict resolution history in git (auto-commit with resolution metadata in commit message)
