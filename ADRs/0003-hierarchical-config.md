---
status: accepted
date: 2026-04-07
---

# ADR-0003: Hierarchical Config — Global + Project Layers

## Context

Users need configuration at two scopes:
1. **Global** — their personal catalog of all servers, skills, plugins, profiles
   (consistent across all projects on all machines)
2. **Project** — project-specific servers, instructions, and overrides
   (shared with the team via the project's git repo)

This mirrors established patterns: git (`.gitconfig` + `.git/config`),
Claude Code (`~/.claude.json` + `.mcp.json`), npm (`.npmrc` global + project).

Additionally, machine-specific values (secrets, paths, personal preferences) need
a local-only layer that never syncs.

## Decision

Two config layers plus local overrides:

```
~/.config/agent-manager/config.toml      # Global (git-synced via am's repo)
~/.config/agent-manager/config.local.toml # Global-local (gitignored)
<repo>/.agent-manager.toml               # Project (git-synced via project repo)
<repo>/.agent-manager.local.toml         # Project-local (gitignored)
```

**Resolution order (highest wins):**
```
CLI flags → ENV vars → project-local → project → global-local → global → defaults
```

**Composition rules:**
- Servers: union (project adds to global, never removes)
- Skills/Plugins: union (additive)
- Settings: key-level override (project overrides global per-key)
- Env vars: key-level override
- Profiles: project selects which global profile to activate via `profile = "work"`
- Instructions: union (project adds its own instructions)
- Adapter sections: deep merge (project adapter config merges into global)

**Key design choices:**
- Project config uses the SAME schema as global config (no separate format to learn)
- Project config is additive — it can add servers and override settings, but cannot
  remove global servers (use profiles for that)
- `.agent-manager.toml` is intended to be committed to the project repo for team sharing
- `.agent-manager.local.toml` is always gitignored (personal project overrides)
- `--global` and `--project` flags on CLI commands scope writes to the right file

## Consequences

### Positive
- Team leads can define required project servers in `.agent-manager.toml`
- Team members get project servers automatically on `am apply`
- Personal preferences stay in global or local configs, never leak to team
- Familiar pattern (same as git, npm, cargo, most dev tools)
- One schema to learn — project config is a subset of global config

### Negative
- Two files to understand (though project config is optional)
- "Where did this server come from?" requires tracing the hierarchy
  (mitigation: `am list servers --explain` shows source per server)
- Additive-only project config can't remove a global server
  (mitigation: use profiles — project selects a profile that excludes the server)

### Neutral
- Projects without `.agent-manager.toml` still work — global config applies directly
- Teams without agent-manager can still use the repo — IDE-specific files can be
  committed alongside `.agent-manager.toml`

## Alternatives Considered

- **Single flat config:** Rejected because it forces choosing between "personal catalog"
  and "team shared" — can't have both.
- **Three layers (global/workspace/project):** Rejected as over-engineered. Workspaces
  can be modeled as profiles within the global config.
- **Project config can remove global servers:** Rejected because it creates confusing
  behavior where a project could silently disable servers you expect to have.

## References

- [05-toml-profile-configuration-design.md](../research/05-toml-profile-configuration-design.md) — mise directory hierarchy, Cargo workspace patterns
- [04-agent-ide-config-format-survey.md](../research/04-agent-ide-config-format-survey.md) — how each tool handles global vs project scoping
