---
status: accepted
date: 2026-04-07
---

# ADR-0008: Profile-Based Configuration Subsets

## Context

Users accumulate many MCP servers, skills, and plugins over time (20+ is common for
power users). Not all are needed in every context:
- Work requires Outlook, Slack, ticketing MCPs; personal projects don't
- Research requires deep search MCPs; day-to-day coding doesn't
- Minimal profiles improve startup time when many MCPs aren't needed

Users need a way to define named subsets and switch between them quickly.

## Decision

Profiles are named subsets of the global catalog. They use Cargo-style explicit
inheritance with `inherits` and Docker Compose-style tag-based server activation.

```toml
[profiles.base]
description = "Always-on utilities"
servers = ["fetch", "context7"]

[profiles.work]
inherits = "base"
servers = ["tavily", "exa"]
server_tags = ["work"]               # activates any server tagged "work"
skills = ["research-rabbithole"]
plugins = ["superpowers"]

[profiles.research]
inherits = "base"
server_tags = ["search", "research"]
skills = ["research-rabbithole"]
```

**Merge rules:**
- Lists (servers, skills, plugins, instructions): **union** — child adds to parent
- Tables (settings, env): **key-level override** — child key replaces parent key
- Tags (server_tags): **union** — tags from parent and child both activate servers

**Activation:**
- `am use <profile>` sets the active profile and auto-applies
- `profile = "<name>"` in `.agent-manager.toml` binds a project to a profile
- `[[auto_detect]]` rules select profiles by directory path prefix
- `--profile <name>` CLI flag overrides for a single command

**Single inheritance only:** Profiles have at most one parent via `inherits`. This
avoids diamond inheritance complexity. If users need combinations, they create a new
profile that explicitly lists everything.

**Independent validation:** OpenAI Codex CLI adopted the identical `[profiles.<name>]`
TOML pattern in 2025, providing strong independent validation of this design.

## Consequences

### Positive
- Quick context switching: `am use work` → `am use personal`
- Tag-based activation reduces config maintenance — tag a server once, it activates
  in every profile that uses that tag
- Inheritance reduces duplication — common base shared across profiles
- Project binding via `.agent-manager.toml` makes profile selection automatic
- Auto-detect by directory path eliminates manual switching for organized users

### Negative
- Single inheritance limits flexibility (no mixing two profiles)
  (mitigation: create a new profile that combines what you need)
- Tag-based activation can be surprising — tagging a server "work" silently adds it
  to every profile using `server_tags = ["work"]`
  (mitigation: `am profile show <name>` displays the computed active set)

### Neutral
- Profiles only select from the global catalog — they don't define new servers
  (project config handles project-specific servers via ADR-0003)

## Alternatives Considered

- **No profiles (flat config):** Rejected — users with 20+ servers need subsets.
- **Multiple inheritance:** Rejected — diamond problem, complex merge semantics,
  confusing for users.
- **Tag-only activation (no explicit server lists):** Rejected — too implicit.
  Users should be able to list servers explicitly OR use tags (or both).

## References

- [05-toml-profile-configuration-design.md](../research/05-toml-profile-configuration-design.md) — Cargo inherits, Docker Compose profiles, Codex convergence
