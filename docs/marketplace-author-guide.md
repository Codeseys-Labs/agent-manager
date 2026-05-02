# Marketplace Author Guide

This guide walks through building a **marketplace** for agent-manager (am).
A marketplace is a git repository that bundles one or more **plugins** —
each plugin is a directory containing a `plugin.json` manifest plus any
supporting files. Users subscribe to your marketplace with
`am marketplace add <git-url>`, then install individual plugins from it.

**Audience:** You want to publish a curated bundle of MCP servers, skills,
agents, and/or community adapters for a specific workflow or team. You own
a git repo and understand semantic versioning.

**Distinction from community adapters:** if you want to ship support for a
new AI CODING TOOL (Cursor, Zed, PearAI, Void…), read
[community-adapter-authoring.md](./community-adapter-authoring.md). This
guide is about bundled PLUGINS (MCP servers + skills + agents).

## Table of contents

1. [Quickstart](#quickstart)
2. [Repository layout](#repository-layout)
3. [Plugin manifest reference](#plugin-manifest-reference)
4. [Security expectations](#security-expectations)
5. [Preview + subscribe flow](#preview--subscribe-flow)
6. [Testing locally](#testing-locally)
7. [Publishing + versioning](#publishing--versioning)
8. [Relationship to ADR-0027 community adapters and ADR-0035 community shims](#relationship-to-adr-0027-community-adapters-and-adr-0035-community-shims)

## Quickstart

Minimum viable marketplace — one plugin, one MCP server:

```
my-marketplace/                 # your git repo root
└── utils/                      # a plugin directory
    └── plugin.json             # the manifest
```

`utils/plugin.json`:

```json
{
  "name": "utils",
  "description": "Filesystem + fetch utilities for Claude Code and friends",
  "version": "0.1.0",
  "author": { "name": "Your Name", "email": "you@example.com" },
  "servers": {
    "fetch": {
      "command": "uvx",
      "args": ["mcp-server-fetch"],
      "transport": "stdio"
    }
  }
}
```

Users subscribe and install:

```bash
am marketplace add https://github.com/you/my-marketplace
am marketplace install utils
```

That's it — two shell commands from the user's perspective.

## Repository layout

Marketplaces support **three** layouts. am's scanner detects them in this
order and picks the first that matches:

### Layout A: flat (one plugin per top-level directory)

```
my-marketplace/
├── README.md
├── utils/
│   └── plugin.json
└── team-prompts/
    ├── plugin.json
    └── skills/
        └── code-review.md
```

### Layout B: `plugins/` subdirectory

```
my-marketplace/
├── README.md
└── plugins/
    ├── utils/
    │   └── plugin.json
    └── team-prompts/
        └── plugin.json
```

Useful when your repo also contains docs, CI, examples, or unrelated
material. am's scanner checks `plugins/*` if present and ignores the
top-level directory structure.

### Layout C: single plugin at the repo root

```
my-marketplace/                    # repo = plugin
├── README.md
└── plugin.json
```

For single-plugin marketplaces. Discouraged for anything user-facing
(hard to evolve to multi-plugin without breaking existing subscribers).

### What the scanner ignores

- Hidden directories (`.git`, `.github`, `.claude-plugin`, anything starting with `.`)
- Files at the repo root that are not `plugin.json`
- Directories that contain no `plugin.json` (scanned but skipped, no warning)

## Plugin manifest reference

`plugin.json` shape (from `src/marketplace/types.ts:68-78`):

| Field | Required | Type | Purpose |
|---|---|---|---|
| `name` | ✓ | string | Plugin ID. Must be unique within your marketplace. Lowercase + dashes. |
| `description` | ✓ | string | One-line summary shown in `am marketplace list`. |
| `version` |   | string | SemVer recommended. Not enforced; used in provenance tracking. |
| `author` |   | `{ name, email? }` | Credit + support contact. |
| `servers` |   | `Record<string, PluginServerConfig>` | MCP servers to add to the user's catalog. |
| `skills` |   | `string[]` | Paths (relative to plugin dir) to skill markdown files. |
| `agents` |   | `Record<string, PluginAgentConfig>` | Agent profiles to add. |
| `adapter` |   | `PluginAdapterConfig` | ONE community adapter (ADR-0027). Most plugins should NOT use this field. |

### `PluginServerConfig` detail

```json
{
  "command": "uvx",
  "args": ["mcp-server-fetch"],
  "env": { "FOO": "bar" },
  "transport": "stdio",
  "url": "https://..."
}
```

- `command` + `args` for stdio transports.
- `url` for `streamable-http` / `sse`.
- `env` values are **not** encrypted at install time. If a plugin requires
  API keys, document the key name in the plugin's README and let the user
  provide it via `am secret set`. Do NOT ship secrets in `plugin.json`.

### `PluginAgentConfig` detail

```json
{
  "name": "code-reviewer",
  "description": "Reviews a diff for bugs and style",
  "prompt": "You are a code reviewer. ...",
  "prompt_file": "agents/code-reviewer.md",
  "model": "claude-sonnet",
  "tools": ["fetch"]
}
```

Use `prompt_file` (a path relative to the plugin dir) for prompts longer
than ~20 lines.

## Security expectations

All marketplace authors are expected to honor these rules. am's tooling
enforces some automatically; the rest are social contract.

### Enforced by am

- **SHA pinning.** Marketplaces are cloned once and pinned to a commit
  SHA. Updates require explicit `am marketplace update <name>` and show
  a SHA diff before applying.
- **TOFU (trust on first use).** When you add a new marketplace, am shows
  the remote URL, resolved commit, and plugin count. You approve once.
- **`--ignore-scripts` on npm installs.** Community adapters installed via
  a marketplace never run npm lifecycle scripts (no `postinstall` hooks).
- **Clone-size + timeout caps.** Marketplaces that exceed ~100MB or take
  >30s to clone are rejected at add time.

### Expected of marketplace authors

- **Pin your own dependencies.** If your plugin's MCP server uses `npx`
  or `uvx`, pin a specific version: `["mcp-server-fetch@1.2.3"]`, not
  `@latest`. `@latest` exposes your users to upstream regressions.
- **Declare secret dependencies.** Document every env var your plugin
  needs in a README inside the plugin directory. Users will grep it
  when things don't work.
- **Don't embed credentials.** Not in `plugin.json`, not in committed
  `.env.example`, not anywhere. The user's `am secret set` is the
  contract.
- **Keep `plugin.json` minimal.** Anything with state (cache dirs, log
  dirs) belongs in the plugin's server code, not the manifest.
- **Declare breaking changes.** Bump the major version in `version`
  when you change a server's `command` or rename a plugin.

## Preview + subscribe flow

As a user experience check, your marketplace should answer these
questions from `am marketplace list` + `am marketplace info`:

| User asks | Answer from `plugin.json` |
|---|---|
| "What MCP servers will this add?" | `servers` keys |
| "What secrets will I need?" | README prose (not the manifest) |
| "What does this plugin do?" | `description` |
| "Who wrote it?" | `author.name` + your git repo URL |
| "Is it being maintained?" | Last commit date + your release cadence |

If any answer requires the user to clone-and-read-the-code, you've
under-invested in docs.

## Testing locally

Before pushing, test locally with a file:// URL:

```bash
# From your marketplace repo
am marketplace add file://$(pwd)

# Install a plugin
am marketplace install utils

# Inspect what landed in the user's catalog
am list servers

# Uninstall + remove
am marketplace uninstall utils
am marketplace remove my-marketplace
```

Local marketplaces are not SHA-pinned (the source is your working tree),
so `am marketplace list` labels them `[local]` — useful for iterating
without git pushes.

Automated testing against real `am`: commit your repo, `am marketplace add <file://...>` in a tmp dir, run your assertions, then `am marketplace remove <name>`. No public fixtures yet — this is a known gap (plan: `am marketplace validate <path>` subcommand lands in a future release).

## Publishing + versioning

agent-manager does not host a marketplace index today. You publish by:

1. Push to GitHub/GitLab/Codeberg as a public git repo.
2. Share the `am marketplace add <url>` one-liner in your README.
3. (Optional) File a PR adding your marketplace to
   [AWESOME-MARKETPLACES.md](https://github.com/Codeseys-Labs/agent-manager)
   (**note:** that file doesn't exist yet — pending curated-index work
   from the pillar-review Tier D).

For versioning, tag semver on the repo AND bump `version` in each
plugin's manifest when it changes. Users who pinned with
`am marketplace add <url>#<tag>` can upgrade deliberately.

## Relationship to ADR-0027 community adapters and ADR-0035 community shims

Three concepts sometimes confused:

- **Marketplace** (this guide): git repo of plugins. Users subscribe;
  plugins are MCP servers + skills + agents. ADR-0024, ADR-0032.
- **Community adapter** (ADR-0027): support for a new AI coding TOOL
  (Cursor, Zed, Void). Shipped as a standalone subprocess speaking
  JSON-RPC to am. Can be installed standalone via `am adapter install`
  OR bundled in a marketplace plugin's `adapter` field.
- **Community shim** (ADR-0035, proposed): wrapper for a non-ACP CLI
  (aider, amazon-q, cody) so `am run` can drive it. Shipped via a
  separate `shims.toml` registration path (not via marketplace).

If you're writing a plugin that adds MCP servers / skills / agents, you
want a **marketplace** (this guide).

If you're writing support for a new IDE / editor, you want a **community
adapter**.

If you're writing a wrapper for a non-ACP CLI, wait for ADR-0035 to be
accepted and then follow that path.

## Known gaps and upcoming improvements

These are tracked in the pillar-review synthesis at
`docs/research/2026-05-02-all-pillars-review/04-marketplace.md`:

- No `am marketplace validate <path>` CLI subcommand yet (authors
  reverse-engineer manifest from code). Planned.
- Duplicate plugin names across marketplaces are first-match-wins with
  no namespacing. Planned: ambiguity prompt.
- No marketplace-of-marketplaces index. Planned: curated list.
- Plugin-level manifest differences from Claude Code's
  `.claude-plugin/plugin.json` are discovered at install time, not
  validated at author time. Planned: shared schema.

Expect these to land incrementally. Until they do, stick close to the
hello-world shape in this guide and your marketplace will Just Work.

## Reference

- `src/marketplace/types.ts` — the authoritative `PluginManifest` shape
- `src/marketplace/scanner.ts` — what the install-time scanner accepts
- `src/marketplace/installer.ts` — what install actually does
- `src/commands/marketplace.ts` — the CLI surface
- [ADR-0024](../ADRs/0024-mcp-registry-integration.md) — Registry vs Marketplace distinction
- [ADR-0027](../ADRs/0027-community-adapter-loading.md) — community adapter protocol
- [ADR-0032](../ADRs/0032-terminology-glossary.md) — terminology lock
- `docs/research/2026-05-02-all-pillars-review/04-marketplace.md` —
  the "what's rough" review that motivated this guide
