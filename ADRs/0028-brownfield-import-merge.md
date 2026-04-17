---
status: accepted
date: 2026-04-16
---

# ADR-0028: Brownfield Import Merge

## Context

ADR-0005 established bidirectional adapters with import, export, and diff. The import
path (`am import`) handles the initial onboarding story: read native configs from
13 IDE tools and convert them into `config.toml`. ADR-0024 added registry integration
with provenance tracking for servers installed via `am install`.

However, the current import has a critical gap: **it does not handle brownfield state
where the user has already partially migrated.**

Real-world brownfield scenarios:

1. **Overlapping servers across tools.** User has `tavily-mcp` in Claude Code (via
   `bunx`), Cursor (via `npx`), and Kiro. Each has slightly different args and env
   vars. Import should reconcile these, not create duplicates or silently discard
   the richer configs.

2. **Partial migration.** User ran `am import auto` a month ago, then added 3 new
   servers in Claude Code and modified 2 existing ones. Running import again should
   detect what changed and merge intelligently, not skip everything because identities
   match.

3. **Encrypted vs raw secrets.** After initial import, secrets were encrypted via
   ADR-0023. A subsequent import from a different tool brings the same server with
   raw secret values. The merge must preserve encrypted refs while offering to update
   the underlying values.

Current behavior on identity match is a hard skip — the incoming server is silently
discarded. This is correct for greenfield (first import) but wrong for brownfield
(subsequent imports or multi-tool consolidation).

### Marketplace Gap

A related gap exists for marketplace-distributed items. Claude Code plugins and VS Code
extensions can bundle MCP servers, skills, and hooks. Current import only reads config
files (`~/.claude.json`, `.mcp.json`, etc.) and misses servers registered by installed
plugins or extensions. Users have no way to say "import everything I've installed."

## Decision

### 1. Brownfield Import Merge

Add a **merge phase** to the import pipeline that activates when `config.toml` already
contains servers (brownfield detection). The merge pipeline:

1. **Enhanced identity matching** — Two-tier: exact identity (package ID) and fuzzy
   identity (basename match, name match, endpoint match). Fuzzy matches are flagged
   for review, never auto-resolved.

2. **Conflict detection** — For each identity match with field differences, compute
   a structured diff (command, args, env vars, tags, description, adapter extras).

3. **Interactive resolution** — Display side-by-side diffs with resolution options:
   keep existing, use incoming, merge (union strategy), skip, or field-by-field edit.

4. **Auto mode** (`--auto` flag) — Non-interactive resolution using the "most complete
   config" heuristic. Exact matches with diffs get merged; fuzzy matches get skipped
   with warnings. Encrypted refs are always preserved.

5. **Brownfield report** — `am import --report` shows a summary of all conflicts,
   new servers, and orphaned servers without making changes.

The merge strategy for individual fields:

| Field | Strategy |
|-------|----------|
| command | Keep existing (proven working) |
| args | Union unique arguments |
| env vars | Merge; incoming wins on conflict; preserve encrypted refs |
| tags | Union both sets |
| description | Keep longer |
| enabled | Keep existing |
| _registry | Preserve existing provenance |
| adapter extras | Deep merge, incoming wins on key conflict |

Greenfield imports (empty config.toml) bypass the merge phase entirely — existing
append behavior is unchanged.

### 2. Marketplace Import

Add an optional `scanMarketplace()` method to the Adapter interface for tools that
have plugin/extension ecosystems:

```typescript
interface Adapter {
  // ... existing methods ...
  scanMarketplace?(): MarketplaceResult;
}
```

**Claude Code plugins:** Read `enabledPlugins` from `~/.claude/settings.json`,
then read each plugin's `plugin.json` manifest to extract bundled MCP servers
and skills.

**VS Code extensions:** Scan extension directories for `package.json` files
with `contributes.mcpServers`. Works for Cursor, Kiro, and Windsurf (same
extension format, different base directories).

Marketplace-imported items get a `_marketplace` provenance field (analogous to
`_registry` from ADR-0024):

```toml
[servers.plugin-server._marketplace]
source = "claude-plugin"
package = "@anthropic/plugin-foo"
version = "1.2.0"
imported_at = "2026-04-14T10:30:00Z"
```

CLI: `am import --marketplace <source>` or `am import auto --marketplace`.
Marketplace items feed into the same brownfield merge pipeline.

### 3. New CLI Flags

| Flag | Type | Description |
|------|------|-------------|
| `--auto` | boolean | Auto-resolve conflicts without prompting |
| `--marketplace` | boolean | Include marketplace items (plugins, extensions) |
| `--dry-run` | boolean | Show what would change, don't write |
| `--report` | boolean | Show brownfield report only |
| `--strategy` | enum | Default resolution strategy: merge, keep-existing, keep-incoming |

## Consequences

### Positive

- Brownfield users get intelligent merge instead of silent data loss
- Multi-tool consolidation preserves the best config from each tool
- Encrypted secrets are never accidentally downgraded to raw values
- Marketplace import captures servers that config-file import misses
- Provenance tracking enables audit trail and update detection
- Auto mode enables CI/headless workflows
- Greenfield behavior is completely unchanged (no regression risk)

### Negative

- Import command gains complexity (merge pipeline, conflict UI, fuzzy matching)
- Fuzzy identity matching may produce false positives on similar-but-different servers
  (mitigation: fuzzy matches always require user confirmation)
- Marketplace scanning depends on undocumented plugin/extension formats that may change
  (mitigation: graceful fallback with warnings on parse failure)
- Two new provenance types (`_marketplace`, enhanced `_registry`) widen the schema

### Neutral

- The Adapter interface gains an optional method (`scanMarketplace`) — existing
  adapters are unaffected unless they opt in
- `--auto` mode makes opinionated choices that may not match every user's preference
  (mitigation: clear `--json` output documenting every decision)

## Alternatives Considered

### 1. Always overwrite on re-import

Rejected. Overwriting destroys encrypted secret refs, user-customized tags and
descriptions, and any manual config adjustments. This was the original greenfield
design and is insufficient for brownfield.

### 2. Abort on any conflict

Rejected. Forcing users to manually resolve every difference in config files before
import is the status quo (they're already doing this by hand). The whole point of
`am import` is to automate this.

### 3. Separate `am merge` command

Considered. A dedicated merge command would keep `am import` simple. Rejected because
the brownfield scenario IS the import scenario — users run `am import auto` and
expect it to work whether config.toml is empty or populated. A separate command
creates cognitive overhead ("when do I import vs merge?").

### 4. Import marketplace index (not installed items)

Rejected for marketplace import. Browsing a marketplace catalog is a search operation
(`am search`), not an import. Users expect import to capture what they have NOW, not
what's available.

## References

- [ADR-0005](0005-bidirectional-adapters.md) — Bidirectional adapter contract
- [ADR-0023](0023-tiered-secret-detection.md) — Secret detection and encryption
- [ADR-0024](0024-mcp-registry-integration.md) — Registry integration and provenance
- [Brownfield Import Design](../docs/designs/brownfield-import.md)
- [Marketplace Import Design](../docs/designs/marketplace-import.md)
