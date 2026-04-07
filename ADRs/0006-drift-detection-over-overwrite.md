---
status: accepted
date: 2026-04-07
---

# ADR-0006: Drift Detection Over Strict Overwrite

## Context

When users edit IDE config files directly (adding an MCP server in Claude Code,
changing a rule in Cursor), those changes exist only in the native config file —
not in agent-manager's TOML source of truth.

On the next `am apply`, agent-manager must decide: overwrite the user's changes
(Terraform model), or detect and surface the divergence (git status model)?

Strict overwrite is simpler to implement but creates a hostile experience: users WILL
edit IDE configs directly (it's the natural workflow), and silently destroying their
changes will make them distrust the tool.

## Decision

agent-manager uses **drift detection** as the default behavior:

- `am status` compares resolved config against current native files using each
  adapter's `diff()` method. Shows additions, removals, and modifications per tool.
- `am apply` checks for drift before writing. If drift is detected, it warns and
  offers options: `--force` to overwrite, or `am import <tool>` to adopt changes.
- `am apply --force` explicitly overrides drift detection (user opt-in to overwrite).

The UX flow:
```
$ am status
  Claude Code: ⚠ drift — +1 server (playwright-mcp) not in config.toml
  Cursor:      ✓ in sync

$ am apply
  ⚠ Drift detected in Claude Code. Options:
    am import claude-code    # adopt the changes into config.toml
    am apply --force         # overwrite with config.toml
    am apply --target cursor # skip Claude Code, apply others
```

## Consequences

### Positive
- Users never lose work — direct IDE edits are preserved until explicitly resolved
- Natural workflow: edit in IDE, periodically `am import` to adopt changes
- Builds trust: the tool respects user's existing workflow
- Clear mental model: config.toml is the intended state, IDE files are the actual state,
  `am status` shows the gap (like `terraform plan`)

### Negative
- Config can drift indefinitely if users ignore `am status`
  (mitigation: `am apply` warns; CI/CD can enforce sync)
- More complex than strict overwrite — need diff logic per adapter
- Users might be confused about which state is "correct"
  (mitigation: clear messaging — "config.toml is your source of truth")

### Neutral
- `--force` flag provides escape hatch for users who want strict overwrite behavior
- Drift detection reuses the adapter's `diff()` method — no extra infrastructure

## Alternatives Considered

- **Strict overwrite (Terraform model):** Rejected — users will edit IDE configs
  directly. Overwriting silently destroys their work.
- **Auto-import (Dropbox model):** Rejected — automatically importing IDE changes
  could corrupt the source of truth. Must be explicit.
- **Filesystem watcher:** Rejected — constant watching is resource-heavy and
  unnecessary. On-demand detection via `am status` is sufficient.

## References

- [02-git-as-backend-patterns.md](../research/02-git-as-backend-patterns.md) — chezmoi's "diff before apply" pattern
