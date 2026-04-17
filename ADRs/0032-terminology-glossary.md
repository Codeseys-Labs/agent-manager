---
status: accepted
date: 2026-04-17
---

# ADR-0032: Terminology Glossary

## Context

The iter4 vision audit (`docs/reviews/2026-04-17-iter4-system-critique/04-undocumented-pillars.md`)
found pervasive terminology drift:

- **"catalog"** (README + ADR-0031): ~17 mentions in `src/`
- **"config"** (ADRs 0001-0030, help output, most of the codebase): hundreds of mentions
- **"config.toml"** (schema, tests): file-level references
- **"AM repo" / "repo"** (some ADRs, install docs): the git-tracked dir
- **"Registry"** (MCP Package Registry, ADR-0024) and **"Marketplace"** (plugin marketplace, ADR-0027) are adjacent concepts frequently conflated.

ADR-0031 (pillars) introduced new terminology without reconciling with prior
ADRs. This ADR is the reconciliation.

## Decision

**Canonical terms and their scope:**

| Term | Definition | Example |
|---|---|---|
| **Catalog** | The declarative content — what the user has DECLARED (servers, skills, agents, instructions, profiles). The **content**, not the file. | "add this to your catalog", "listInstalled scans the catalog" |
| **Config** | The TOML file(s) that persist the catalog on disk. The **representation**. | "config.toml", "`readConfig` reads the config file" |
| **AM config dir** | The git-tracked directory that holds the config file + adapters.toml + state.toml + keys + wiki. | `~/.config/agent-manager/` (default) |
| **Resolved config** | The catalog after profile merging, env interpolation, and secret decryption — ready for adapters to consume. | `ResolvedConfig` TS type |
| **MCP Package Registry** (or just **Registry**) | The upstream catalog of published MCP server packages (npm, GitHub, etc.) that `am search/install/uninstall/update` browses. **Not** user-specific. | "ADR-0024 Registry", "am search tavily" |
| **Marketplace** | A user-subscribed git repo that supplies catalog entries (skills + MCP server bundles + plugins + agents). Multiple can be added; each is pinned to a commit SHA. **User-chosen**. | "ADR-0027 Marketplace", "am marketplace add https://..." |
| **Pillar** | One of the six product axes per ADR-0031. Stable, scope-gate reference. | "pillar 1 = catalog + git sync" |
| **Surface** | A specific user-facing touch-point of a pillar (a CLI command, an MCP tool, a UI screen). | "am mcp-serve is a surface of pillar 2" |
| **Runtime** | The binary/process that hosts an agent (Claude Code CLI, Cursor's agent daemon, etc.). | "ACP runtime binary" |
| **Agent** | A named entry in the unified registry with ACP and/or A2A endpoints. | "the `claude` agent" |
| **Adapter** | Code that translates between the catalog and a specific IDE's native config format. | "the claude-code adapter", "13 adapters" |

**Registry vs. Marketplace** — these are DIFFERENT things and must not be
conflated:

- **Registry**: public, upstream, npm-style. `am install tavily-mcp` pulls from
  here. Replaces "which MCP server package should I use." Singular global.
- **Marketplace**: private or community, git-backed, user-subscribed. `am
  marketplace add ...` adds a trusted source of curated bundles. Replicates
  Claude Code's plugin marketplace model. Plural per user.

**Catalog vs. Config** — consumers think in catalog ("my MCP servers"),
implementers read/write config (`config.toml`). User-facing docs prefer
catalog; implementation docs prefer config. Both are correct in their context.

**"Repo" is ambiguous** — avoid. Use "config dir" or "marketplace repo" or
"project repo" depending on which repo you mean.

## Consequences

### Positive

- Future audits, ADRs, and user docs have a single reference.
- Registry vs Marketplace confusion stops. Users searching for "how do I install
  an MCP server" don't get Marketplace docs by mistake.
- The pillars have a stable vocabulary for the "what pillar does this serve?"
  test.

### Negative

- ADRs 0001-0030 still use "config" where they should say "catalog" in
  user-facing sections. We are NOT rewriting them — the glossary maps the
  terms, which is enough for future contributors to navigate.
- Some CLI commands are now mis-named by this standard:
  - `am config` shows the **catalog** contents; by this ADR it should be
    `am catalog show`. Keep the current name for back-compat; document as
    acceptable legacy.

### Neutral

- No code change required by this ADR alone. Doc updates in README,
  AGENTS.md, CLAUDE.md already landed in iter4 Wave E.

## Alternatives Considered

**Unify on "config" everywhere**: Rejected — "catalog" better conveys
"declared content" vs "on-disk file." Keeps the pitch tight.

**Unify on "catalog" everywhere**: Rejected — too disruptive to rename
every `readConfig`/`writeConfig` call. File-level code naturally refers to
the config file.

**Merge Registry and Marketplace into one concept**: Rejected — they serve
different scenarios (public upstream vs user-subscribed).

## References

- `docs/reviews/2026-04-17-iter4-system-critique/04-undocumented-pillars.md` — original naming-drift finding
- ADR-0024 (MCP Package Registry)
- ADR-0027 (Community Adapter Loading / Marketplace model)
- ADR-0031 (Product Scope and Pillars)
