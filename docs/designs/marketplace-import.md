# Design: Marketplace Import

**Date:** 2026-04-14
**Status:** Draft
**Related:** [ADR-0024](../../ADRs/0024-mcp-registry-integration.md) (MCP Registry), [Brownfield Import](brownfield-import.md)

## Problem

IDE tools have their own ecosystems for distributing functionality beyond MCP servers:

- **Claude Code** has plugins (skills, hooks, agents) distributed via `enabledPlugins`
  in settings and `plugin.json` manifests
- **VS Code** (and Cursor, Kiro, Windsurf) has extensions that can register MCP servers
  via `contributes.mcpServers` in `package.json`
- **The MCP Registry** at `registry.modelcontextprotocol.io` is a standalone catalog

Currently, `am import` only reads native MCP server configs (the `mcpServers` key in
config files). It misses:

1. MCP servers registered by VS Code extensions (not in any JSON config file)
2. Claude Code plugins that bundle MCP servers, skills, or agents
3. The relationship between a marketplace-installed item and its MCP server config

Users have no way to say "import everything I've installed" — they can only import
what's explicitly in config files.

## Research

### Claude Code Plugins

Claude Code plugins are distributed as npm packages with a `plugin.json` manifest:

```json
{
  "name": "my-plugin",
  "version": "1.0.0",
  "skills": [
    {
      "name": "my-skill",
      "description": "Does a thing",
      "path": "skills/my-skill/SKILL.md"
    }
  ],
  "hooks": [...],
  "mcpServers": {
    "my-server": {
      "command": "node",
      "args": ["dist/server.js"]
    }
  }
}
```

Installed plugins are tracked in `~/.claude/settings.json`:

```json
{
  "enabledPlugins": [
    "@anthropic/plugin-foo",
    "@company/plugin-bar"
  ]
}
```

Plugin metadata lives in `~/.claude/plugins/<package-name>/plugin.json`.

**Key insight:** A single Claude Code plugin can bundle MCP servers AND skills AND
hooks. Current `am import claude-code` only captures the MCP servers from
`~/.claude.json`, not the plugin-bundled ones.

### VS Code Extensions with MCP Servers

VS Code extensions can declare MCP servers in their `package.json`:

```json
{
  "contributes": {
    "mcpServers": {
      "my-server": {
        "command": "node",
        "args": ["${extensionPath}/dist/server.js"],
        "env": {}
      }
    }
  }
}
```

Installed extensions live in `~/.vscode/extensions/<publisher.name-version>/`.
The extension manifest is at `package.json` in that directory.

**Variants by tool:**
- Cursor: `~/.cursor/extensions/`
- Kiro: `~/.kiro/extensions/`
- Windsurf: `~/.windsurf/extensions/`

VS Code also has a CLI: `code --list-extensions` returns installed extension IDs.
Cursor: `cursor --list-extensions`. These CLIs may not be available on all systems.

### MCP Registry Relationship

The MCP Registry (`registry.modelcontextprotocol.io`) is independent of IDE
marketplaces. A server can be:
- In the registry only (standalone MCP server)
- In a VS Code extension only (extension-bundled)
- In both (published to registry AND bundled in extension)
- In a Claude Code plugin only

am already integrates with the registry via `am search` / `am install` (ADR-0024).
Marketplace import is about capturing what's **already installed** in a tool, not
discovering new items.

## Design

### Scope: Import Installed Items Only

`am import --marketplace` imports items **already installed** in a tool.
It does NOT browse or install from a marketplace catalog — that's `am search` / `am install`.

```
┌──────────────────────────────────────────────────────────┐
│                    Import Sources                         │
│                                                          │
│  am import claude-code          ← config files (today)   │
│  am import --marketplace claude-code  ← plugins (NEW)    │
│  am import --marketplace vscode       ← extensions (NEW) │
│                                                          │
│  am search / am install         ← registry catalog       │
│  (already exists, ADR-0024)                              │
└──────────────────────────────────────────────────────────┘
```

### Marketplace Scanner Interface

Each adapter that supports marketplace scanning implements an optional method:

```typescript
interface MarketplaceItem {
  id: string;                      // Package/extension ID
  name: string;                    // Human-readable name
  version: string;
  source: "claude-plugin" | "vscode-extension" | "cursor-extension" | "kiro-extension";
  servers: ImportedServer[];       // MCP servers bundled in this item
  skills: ImportedSkill[];         // Skills bundled (Claude Code plugins)
  metadata: MarketplaceMetadata;
}

interface MarketplaceMetadata {
  publisher?: string;
  repository?: string;
  installPath: string;             // Where the item lives on disk
  manifestPath: string;            // Path to plugin.json or package.json
}

// Extension to Adapter interface
interface Adapter {
  // ... existing methods ...
  scanMarketplace?(): MarketplaceResult;
}

interface MarketplaceResult {
  items: MarketplaceItem[];
  warnings: string[];
}
```

### Claude Code Plugin Scanner

Reads installed plugins and extracts their MCP servers and skills:

```typescript
function scanClaudePlugins(homeDir: string): MarketplaceResult {
  const items: MarketplaceItem[] = [];
  const warnings: string[] = [];

  // 1. Read enabledPlugins from ~/.claude/settings.json
  const settingsPath = join(homeDir, ".claude", "settings.json");
  const settings = readJsonSync(settingsPath);
  const enabledPlugins: string[] = settings?.enabledPlugins ?? [];

  // 2. For each enabled plugin, read its plugin.json
  for (const pluginId of enabledPlugins) {
    const pluginDir = join(homeDir, ".claude", "plugins", pluginId);
    const manifestPath = join(pluginDir, "plugin.json");

    const manifest = readJsonSync(manifestPath);
    if (!manifest) {
      warnings.push(`Plugin ${pluginId}: no plugin.json found`);
      continue;
    }

    const servers: ImportedServer[] = [];
    const skills: ImportedSkill[] = [];

    // Extract MCP servers
    if (manifest.mcpServers) {
      for (const [name, config] of Object.entries(manifest.mcpServers)) {
        servers.push({
          name,
          command: config.command,
          args: config.args,
          env: config.env,
          scope: "global",
          tags: [`plugin:${pluginId}`],
        });
      }
    }

    // Extract skills
    if (manifest.skills) {
      for (const skill of manifest.skills) {
        skills.push({
          name: skill.name,
          path: join(pluginDir, skill.path),
          description: skill.description,
        });
      }
    }

    items.push({
      id: pluginId,
      name: manifest.name ?? pluginId,
      version: manifest.version ?? "unknown",
      source: "claude-plugin",
      servers,
      skills,
      metadata: {
        publisher: manifest.author,
        repository: manifest.repository,
        installPath: pluginDir,
        manifestPath,
      },
    });
  }

  return { items, warnings };
}
```

### VS Code Extension Scanner

Scans installed extensions for `contributes.mcpServers`:

```typescript
function scanVSCodeExtensions(extensionsDir: string): MarketplaceResult {
  const items: MarketplaceItem[] = [];
  const warnings: string[] = [];

  // List extension directories
  const dirs = readdirSync(extensionsDir).filter(d =>
    statSync(join(extensionsDir, d)).isDirectory()
  );

  for (const dir of dirs) {
    const extPath = join(extensionsDir, dir);
    const pkgPath = join(extPath, "package.json");
    const pkg = readJsonSync(pkgPath);
    if (!pkg) continue;

    // Check for contributes.mcpServers
    const mcpServers = pkg.contributes?.mcpServers;
    if (!mcpServers || typeof mcpServers !== "object") continue;

    const servers: ImportedServer[] = [];
    for (const [name, config] of Object.entries(mcpServers)) {
      servers.push({
        name,
        command: resolveExtensionVars(config.command, extPath),
        args: (config.args ?? []).map(a => resolveExtensionVars(a, extPath)),
        env: config.env,
        scope: "global",
        tags: [`extension:${pkg.publisher}.${pkg.name}`],
      });
    }

    if (servers.length > 0) {
      items.push({
        id: `${pkg.publisher}.${pkg.name}`,
        name: pkg.displayName ?? pkg.name,
        version: pkg.version,
        source: "vscode-extension",
        servers,
        skills: [],
        metadata: {
          publisher: pkg.publisher,
          repository: pkg.repository?.url,
          installPath: extPath,
          manifestPath: pkgPath,
        },
      });
    }
  }

  return { items, warnings };
}

// Resolve ${extensionPath} variables in extension configs
function resolveExtensionVars(value: string, extPath: string): string {
  return value.replace(/\$\{extensionPath\}/g, extPath);
}
```

Extension directories by tool:

| Tool | macOS | Linux |
|------|-------|-------|
| VS Code | `~/Library/Application Support/Code/User/extensions/` | `~/.vscode/extensions/` |
| Cursor | `~/Library/Application Support/Cursor/User/extensions/` | `~/.cursor/extensions/` |
| Kiro | `~/Library/Application Support/Kiro/User/extensions/` | `~/.kiro/extensions/` |
| Windsurf | `~/Library/Application Support/Windsurf/User/extensions/` | `~/.windsurf/extensions/` |

### Provenance Tracking

Marketplace-imported items get a `_marketplace` metadata field, similar to
the `_registry` field from ADR-0024:

```toml
[servers.my-plugin-server._marketplace]
source = "claude-plugin"           # or "vscode-extension", "cursor-extension"
package = "@anthropic/plugin-foo"  # Plugin/extension ID
version = "1.2.0"
imported_at = "2026-04-14T10:30:00Z"
install_path = "~/.claude/plugins/@anthropic/plugin-foo"
```

Schema addition:

```typescript
export const MarketplaceProvenanceSchema = z.object({
  source: z.enum([
    "claude-plugin",
    "vscode-extension",
    "cursor-extension",
    "kiro-extension",
    "windsurf-extension",
  ]),
  package: z.string(),
  version: z.string(),
  imported_at: z.string(),
  install_path: z.string().optional(),
});
```

This enables:
- `am update` to check if the source extension/plugin has been updated
- `am status` to detect when a marketplace item has been uninstalled
- Audit trail for where each server came from

### CLI Interface

```bash
# Import installed Claude Code plugins
am import --marketplace claude-code

# Import VS Code extensions that register MCP servers
am import --marketplace vscode

# Import from all detected tools (configs + marketplace)
am import auto --marketplace

# Preview what marketplace items would be imported
am import --marketplace claude-code --dry-run

# JSON output with provenance
am import --marketplace vscode --json
```

New flag on `am import`:

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--marketplace` | boolean | false | Include marketplace items (plugins, extensions) |

When combined with `auto`, marketplace scanning runs for all detected adapters
that implement `scanMarketplace()`.

### Integration with Brownfield Merge

Marketplace import feeds into the same brownfield merge pipeline from the
companion design doc. A server discovered via marketplace scanning is treated
identically to one discovered via config file reading:

```
Config file import ─────┐
                        ├──> Unified ImportedServer[] ──> Merge Pipeline
Marketplace scan ───────┘
```

The only difference is provenance: marketplace-imported servers get `_marketplace`
metadata, config-imported servers don't (unless they already have `_registry`).

### Output Format

```
Marketplace Scan: Claude Code
──────────────────────────────
  Plugins found: 3

  @anthropic/plugin-foo (v1.2.0)
    Servers: my-server, other-server
    Skills: my-skill

  @company/plugin-bar (v0.5.0)
    Servers: bar-server
    Skills: (none)

  @local/plugin-baz (v2.0.0)
    Servers: (none)
    Skills: baz-skill, baz-helper

  Total: 3 servers, 3 skills to import

Marketplace Scan: VS Code
──────────────────────────
  Extensions with MCP servers: 2

  publisher.extension-a (v3.1.0)
    Servers: ext-server-a

  publisher.extension-b (v1.0.0)
    Servers: ext-server-b1, ext-server-b2

  Total: 3 servers to import
```

## Implementation

### Files to create/modify

| File | Changes |
|------|---------|
| `src/adapters/types.ts` | Add `MarketplaceItem`, `MarketplaceMetadata`, `MarketplaceResult` types. Add optional `scanMarketplace()` to `Adapter` interface. Add `"marketplace"` to `Capability` type. |
| `src/adapters/claude-code/marketplace.ts` | **New.** `scanClaudePlugins()` — reads `enabledPlugins` + `plugin.json` manifests. |
| `src/adapters/claude-code/index.ts` | Wire `scanMarketplace` method. Add `"marketplace"` to capabilities. |
| `src/adapters/cursor/marketplace.ts` | **New.** `scanCursorExtensions()` — reads extension `package.json` for `contributes.mcpServers`. |
| `src/adapters/copilot/marketplace.ts` | **New.** Same pattern for VS Code extensions. |
| `src/core/schema.ts` | Add `MarketplaceProvenanceSchema`, add `_marketplace` to `ServerSchema`. |
| `src/commands/import.ts` | Add `--marketplace` flag. Call `scanMarketplace()` on adapters, merge results into import pipeline. |

### Phased rollout

**Phase 1: Claude Code plugins** — Highest value, most predictable format.
Read `enabledPlugins` + `plugin.json`, import servers and skills.

**Phase 2: VS Code extensions** — Broader ecosystem. Scan extension dirs for
`contributes.mcpServers`. Works for Cursor, Kiro, Windsurf too (same format).

**Phase 3: Provenance-based updates** — `am update --marketplace` checks if
source plugins/extensions have new versions with changed MCP configs.

### Edge cases

| Case | Handling |
|------|----------|
| Plugin installed but disabled | Import with `enabled: false` |
| Extension path contains `${extensionPath}` | Resolve to absolute path at import time |
| Same MCP server in config AND plugin | Detected as conflict in brownfield merge pipeline |
| Plugin has no MCP servers (only skills/hooks) | Import skills; skip if no entities requested |
| Extension directory missing/corrupt | Warn and skip |
| Multiple VS Code variants (Code, Cursor, Kiro) all have same extension | Deduplicate via identity matching |

## Testing Strategy

- Unit tests for `scanClaudePlugins()` with mock plugin directory structures
- Unit tests for `scanVSCodeExtensions()` with mock extension dirs
- Unit tests for `resolveExtensionVars()` path substitution
- Integration: marketplace + config import into brownfield merge pipeline
- Fixture-based: sample `plugin.json` and `package.json` files

## Non-Goals

- Browsing or installing from marketplace catalogs (use `am search` / `am install` for the MCP registry)
- Managing plugin/extension lifecycle (install, uninstall, update) — that's the IDE's job
- Importing non-MCP extension functionality (themes, language support, etc.)
