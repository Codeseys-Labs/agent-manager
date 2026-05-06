---
status: superseded-in-part-by-ADR-0044
date: 2026-04-09
amended_by: ADR-0044
---

# ADR-0022: Wiki Location Strategy — Global Store with Project Symlinks

> **Status note (updated 2026-05-05).** ADR-0044 was promoted to
> `accepted` on 2026-05-05 and supersedes §3–§4 of this ADR. New
> projects materialise the wiki by **copying** into `.am-wiki/` (not
> symlinking into `.agent-manager/wiki/`) and default to a gitignored
> posture until ADR-0042 enforcement lands. §1–§2 (the wiki concept
> and single-source-of-truth rationale) and §5 (search semantics)
> remain in force as described.
>
> **Backward compatibility.** The symlink helpers originally specified
> here — `createProjectWikiLink(...)` and `ensureWikiGitignore(...)` —
> are **retained in the codebase** so that users with pre-existing
> `.agent-manager/wiki/` symlink layouts continue to function and can
> migrate on their schedule. They are **no longer the default path for
> new projects**: `am wiki init` now calls the copy-based materialiser
> + `ensureAmWikiGitignore(...)`, and `am wiki migrate` is the one-way
> upgrade from the legacy layout to the ADR-0044 layout. Removing the
> legacy helpers is a future cleanup ADR, gated on migration uptake.

## Context

The LLM Wiki (ADR-0020) needs a clear storage location model. Three questions:

1. **Where does a project's wiki live?** Sessions are harvested from project
   workspaces (Claude Code working in `~/code/my-app`). The extracted knowledge
   is inherently project-scoped — information about `my-app`'s architecture,
   decisions, and patterns.

2. **How does it sync?** The AM config directory (`~/.config/agent-manager/`)
   is a git repo (ADR-0002). Wiki data should participate in this git-backed
   sync so it follows the user across machines via `am push`/`am pull`.

3. **How does a project access its wiki?** Agents working in a project need
   to read the wiki. The wiki should be accessible from the project directory
   without requiring agents to know about `~/.config/agent-manager/`.

The stateless web UI (ADR-0015) also needs to browse wikis — it accesses the
user's git-backed AM repo, so the wiki must be inside that repo.

### Prior art

- **Obsidian**: Vaults live wherever the user puts them. No central registry.
  Discovery is manual. No cross-machine sync built-in (requires Obsidian Sync
  or git).
- **chezmoi**: All managed files live in `~/.local/share/chezmoi/` (the source
  directory). Targets are generated from the source. Cross-machine sync via git.
- **agent-manager config**: Global config at `~/.config/agent-manager/config.toml`,
  project config at `.agent-manager.toml`. Follows the hierarchical merge pattern
  (ADR-0003). Project config is committed to the project's git repo.

## Decision

### Dual-layer wiki with central storage and project symlinks

```
~/.config/agent-manager/               # Central AM repo (git-backed)
├── config.toml
├── wiki/
│   ├── global/                        # Cross-project knowledge
│   │   ├── index.json                 # MiniSearch index
│   │   ├── graph.json                 # Knowledge graph
│   │   ├── entities/
│   │   ├── concepts/
│   │   └── ...
│   └── projects/
│       ├── my-app/                    # Project-specific wiki
│       │   ├── index.json
│       │   ├── graph.json
│       │   ├── entities/
│       │   ├── concepts/
│       │   └── decisions/
│       └── another-project/
│           └── ...
└── .git/                              # All wiki content is committed here
```

```
~/code/my-app/                         # Project directory
├── .agent-manager/
│   └── wiki -> ~/.config/agent-manager/wiki/projects/my-app  # Symlink
├── .gitignore                         # Contains: .agent-manager/wiki
├── .agent-manager.toml                # Project config (committed normally)
└── src/
    └── ...
```

### Key design decisions

**1. The central AM repo is the single source of truth.**

All wiki data — global and per-project — lives inside `~/.config/agent-manager/wiki/`.
This directory is part of the git-backed AM repo. `am push` syncs it to the
user's git backend. `am pull` on another machine gets the full wiki. The
stateless web UI can browse it via the GitHub/GitLab API.

**2. Each project gets a subdirectory under `wiki/projects/<name>/`.**

The project name is derived from the git remote URL or directory name (consistent
with how session harvest identifies projects). Each project wiki has its own
MiniSearch index, knowledge graph, and page directories.

**3. Projects access their wiki via a symlink.**

When `am init` or `am wiki init` is run in a project directory, agent-manager
creates:
```
.agent-manager/wiki -> ~/.config/agent-manager/wiki/projects/<project-name>
```

This symlink is:
- **Gitignored by the project** — the wiki content never enters the project's
  git repo. It stays in the AM repo.
- **Transparent to agents** — an agent working in `~/code/my-app` can read
  `.agent-manager/wiki/entities/api-layer.md` without knowing it's a symlink
  into the central store.
- **Portable** — on another machine, `am pull` restores the wiki content and
  `am wiki init` recreates the symlink.

**4. Global wiki for cross-project knowledge.**

`wiki/global/` stores knowledge that isn't project-specific: general coding
patterns, tool preferences, personal conventions. The `am wiki` command without
a project context operates on the global wiki. Within a project, it operates
on the project wiki by default, with `--global` flag to access the global wiki.

**5. Local-only mode works without a git backend.**

If the user never runs `am push`, the wiki lives only at
`~/.config/agent-manager/wiki/` on the local machine. The symlink still works.
The git backend is optional — the local AM repo is always a git repo (for
`am undo`/`am log`), but pushing to a remote is not required.

### Project name resolution

```typescript
function resolveProjectName(projectDir: string): string {
  // 1. Check .agent-manager.toml for explicit name
  // 2. Extract from git remote URL: github.com/user/repo -> repo
  // 3. Fall back to directory basename
}
```

### Symlink management

```bash
am wiki init                  # Create symlink for current project
am wiki init --project foo    # Explicit project name
am wiki init --global         # No-op (global wiki always exists)
```

The symlink is created in `.agent-manager/wiki` (not `.agent-manager.toml` —
the wiki directory is separate from the config file). The `.agent-manager/`
directory may need to be created.

### Gitignore management

`am wiki init` appends `.agent-manager/wiki` to the project's `.gitignore`
if not already present. It does NOT modify `.agent-manager.toml` (which should
remain in the project's git).

### Wiki resolution in commands

```typescript
function resolveWikiDir(opts?: { global?: boolean }): string {
  if (opts?.global) return join(resolveConfigDir(), "wiki", "global");

  // Check if we're in a project with a symlink
  const projectConfig = resolveProjectConfig(process.cwd());
  if (projectConfig) {
    const projectDir = dirname(projectConfig);
    const wikiLink = join(projectDir, ".agent-manager", "wiki");
    if (existsSync(wikiLink)) return wikiLink; // follows symlink
  }

  // Fall back to global wiki
  return join(resolveConfigDir(), "wiki", "global");
}
```

### Session harvest integration

When `am wiki harvest` runs in a project directory:
1. Session harvest (ADR-0016) discovers sessions scoped to the project
2. NER extraction runs on session content
3. Wiki pages are written to the project's wiki (via the symlink)
4. The MiniSearch index is rebuilt for the project
5. The knowledge graph is updated
6. Changes are auto-committed in the AM repo

When `am wiki harvest --all` runs:
1. Sessions from all projects are discovered
2. Cross-project knowledge is extracted to the global wiki
3. Project-specific knowledge goes to the respective project wiki

### Context injection (future — Layer 3)

When `am apply` generates IDE configs, it can inject wiki context:
- Read the project wiki's `index.json` for page summaries
- Include high-confidence entries in the generated AGENTS.md / CLAUDE.md
- This gives agents immediate access to project knowledge on session start

## Consequences

### Positive

- **Single source of truth** — all wiki data in the git-backed AM repo
- **Cross-machine sync** — `am push`/`am pull` syncs wiki along with config
- **Web UI accessible** — stateless web UI can browse wikis via git API
- **Local-first** — works without any remote; syncing is opt-in
- **Agent-transparent** — agents see `.agent-manager/wiki/` as a regular directory
- **Project isolation** — each project's knowledge is separate
- **Global knowledge** — cross-project patterns live in `wiki/global/`

### Negative

- **Symlinks on Windows** — require elevator privileges or developer mode.
  Mitigation: on Windows, use a junction point (no elevation needed for dirs)
  or copy instead of symlink with a warning.
- **Stale symlinks** — if the AM config dir moves or is deleted, symlinks break.
  Mitigation: `am doctor` checks symlink targets.
- **Project name collisions** — two projects named "api" would conflict.
  Mitigation: use `remote-url-hash` as suffix for disambiguation.

### Neutral

- The wiki directory structure inside the AM repo becomes a committed API —
  changes need migration paths.
- The `.agent-manager/` directory in projects now serves dual purpose: config
  reference (`.agent-manager.toml`) and wiki symlink. This is consistent with
  how tools like `.git/` and `.vscode/` combine config and state.

## Alternatives Considered

### 1. Wiki lives in the project repo (committed)

Store wiki pages in `.agent-manager/wiki/` committed to the project's git.

**Rejected because**: project repos shouldn't contain AI-generated knowledge
with potentially sensitive session content. Also fragments the wiki across
N project repos instead of one central repo.

### 2. Wiki lives only in the central AM repo (no symlinks)

All wiki operations reference `~/.config/agent-manager/wiki/projects/<name>`
directly. No project-side symlink.

**Rejected because**: agents working in a project can't easily discover the
wiki. They'd need to know the AM config dir path. The symlink makes the wiki
discoverable from the project root.

### 3. Wiki lives only in the project (not in AM repo)

Each project manages its own wiki independently in `.agent-manager/wiki/`.

**Rejected because**: loses cross-machine sync (would need per-project wiki
push/pull), loses global wiki, and fragments the single-source-of-truth model.

### 4. Copy instead of symlink

Copy wiki content from AM repo to project on demand.

**Rejected because**: creates two copies that can diverge. Symlink ensures a
single physical copy. Reads and writes through the symlink go directly to the
AM repo.

## References

- [ADR-0002](0002-git-backed-everything.md) — git-backed config repo
- [ADR-0003](0003-hierarchical-config.md) — global + project config hierarchy
- [ADR-0015](0015-stateless-web-ui.md) — web UI accesses config via git API
- [ADR-0016](0016-session-harvest.md) — session harvest scoped to projects
- [ADR-0020](0020-session-knowledge-synthesis.md) — wiki storage layout (updated by this ADR)
