---
status: accepted
date: 2026-04-07
---

# ADR-0002: Git-Backed Everything

## Context

agent-manager needs to sync configurations across machines. The research surveyed
several approaches:
- Cloud-hosted sync (Smithery model) — vendor lock-in, not self-hostable
- Local-only (MCPM model) — no cross-machine sync
- Git-based sync (chezmoi model) — self-hostable, version-controlled, familiar

Users already know git. Every developer has a GitHub or GitLab account. Git provides
version history, diffing, branching, conflict detection, and authentication for free.

The question was whether git should be an optional sync backend or the foundational
layer.

## Decision

**Git IS the foundation.** The agent-manager config directory (`~/.config/agent-manager/`)
is a git repository. Every mutation (add server, switch profile, import, edit) creates
a commit automatically. Sync is git push/pull.

Key behaviors:
- `am init` runs `git init` in the config directory
- `am add server ...` writes to config.toml AND commits: `"add server: <name>"`
- `am use <profile>` commits: `"switch profile: <old> → <new>"`
- `am import <tool>` commits: `"import: <tool> (N servers, M skills)"`
- `am undo` is `git revert HEAD` + `am apply`
- `am push` / `am pull` are `git push` / `git pull`
- `am log` is `git log --oneline` with agent-manager formatting
- `am remote add <url>` is `git remote add origin <url>`

Git operations use isomorphic-git (pure JS, no system git required) as the default,
with simple-git as an optional faster backend when system git is available.

Remote support: any git remote (GitHub, GitLab, Gitea, bare SSH repo). Self-hostable
by design — no proprietary sync service.

## Consequences

### Positive
- Version history for all config changes — rollback any mistake with `am undo`
- Cross-machine sync via any git remote (GitHub, GitLab, self-hosted)
- Familiar mental model for developers (push, pull, log, diff)
- Conflict detection and resolution via git's merge machinery
- No proprietary sync service required — fully self-hostable
- Config changes are auditable (who changed what, when)
- Branching allows experimental config changes

### Negative
- Every mutation creates a commit — potentially noisy git history
  (mitigation: squash option, or batch commits for multi-step operations)
- isomorphic-git is slower than system git for large repos
  (mitigation: config repos are tiny — kilobytes, not megabytes)
- Git concepts may intimidate non-developer users
  (mitigation: `am push/pull/undo` abstracts git behind friendly commands)
- Encrypted secrets in git require age key management on each machine

### Neutral
- `.gitignore` handles local-only files (config.local.toml, age keys, state.db)
- The git repo structure becomes part of the public API — changes need migration paths

## Alternatives Considered

- **Optional git sync (like MCPM):** Rejected because making git optional means two
  code paths (with-git, without-git) and users who start without git lose version
  history. Better to always have git, even if the remote is optional.
- **Cloud sync service:** Rejected because it contradicts the self-hostable principle
  and adds vendor dependency. Users who want cloud sync can use GitHub/GitLab.
- **File-based sync (rsync, Syncthing):** Rejected because it lacks version history,
  conflict resolution, and structured merge capability.

## References

- [02-git-as-backend-patterns.md](../research/02-git-as-backend-patterns.md) — chezmoi source-apply model, dotter, yadm
- [07-browser-ui-git-oauth.md](../research/07-browser-ui-git-oauth.md) — isomorphic-git for single-binary distribution
