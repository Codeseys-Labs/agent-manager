---
status: accepted
date: 2026-05-05
accepted: 2026-05-05
amends: ADR-0022
---

# ADR-0044: Wiki Two-Tier Materialisation — Copy Over Symlink, Project-Level + Global Store

## Context

ADR-0022 (accepted 2026-04-09) decided that the LLM Wiki (introduced in
ADR-0020) lives in a **global store** at
`~/.config/agent-manager/wiki/` with **per-project symlinks** materialising
the wiki into each project as `.agent-manager/wiki/`. The rationale was
disk efficiency, single source of truth, and immediate consistency.

Subsequent design work (`docs/design/2026-05-05-llm-wiki-vision.md`) and
implementation experience have surfaced four problems with the symlink model:

1. **Windows compatibility.** Symlink creation requires elevated
   privileges or Developer Mode on Windows < 10. `am wiki init` fails
   silently or with confusing errors on default Windows installs. Real
   users will experience this; the project explicitly targets Windows.

2. **Visibility for non-am-aware agents.** Other AI coding agents (Codex,
   Cline, Roo Code, etc.) inspecting a project's `.agent-manager/wiki/`
   directory through their own filesystem-walk machinery can fail to
   resolve symlinks correctly. Some abstract over them (good); some
   refuse to follow them (bad). Copying materialised content makes the
   wiki universally readable.

3. **Git treatment.** Symlinks committed to git are stored as
   path-strings, not contents. A user who clones their config repo onto
   a new machine sees a broken symlink, not the wiki content. Copy
   semantics make `git clone && am wiki status` work without `am wiki
   pull`.

4. **Project-local edits.** The symlink model implies edits flow
   through the global store, making per-project private notes awkward.
   The two-tier vision (project-local wiki distinct from global wiki,
   with explicit promotion) cannot be cleanly implemented over symlinks
   to a single source.

A 6-reviewer fan-out deliberation (`docs/deliberations/2026-05-05-D-fanout/CONVERGENCE.md`)
returned **6/6 unanimous** on switching to copy semantics, **6/6
unanimous** on the rename `.agent-manager/wiki/ → .am-wiki/`, and **6/6
unanimous** on parallel adapter expansion not blocking the two-tier
rollout.

This ADR amends ADR-0022 §3-4 (location and materialisation strategy)
and adds §6-9 of new content. ADR-0022 §1-2 (wiki concept, why it
exists) and §5 (search semantics) remain in force.

## Decision

We **amend** ADR-0022 to adopt the following materialisation and
two-tier model:

### 1. Project wiki location: `.am-wiki/`

Rename `.agent-manager/wiki/` → `.am-wiki/` at the project level. The
shorter name reduces typo surface, mirrors common patterns
(`.github/`, `.vscode/`), and is unambiguous about what it contains.

ADR-0022's `~/.config/agent-manager/wiki/` global store remains
unchanged.

A 1-version transition period: `am wiki init` writes to `.am-wiki/`;
existing `.agent-manager/wiki/` directories are detected and a
deprecation warning is printed. `am wiki migrate` does the rename.

### 2. Materialisation: copy, not symlink

`am wiki init` and `am wiki sync` materialise wiki entries from the
global store into the project's `.am-wiki/` by **copying**, not
symlinking. Side effects:

- Works on every supported platform (Windows, macOS, Linux) without
  requiring elevated privileges or Developer Mode.
- `git add .am-wiki/` commits content (as the user expects), not
  path-strings.
- Project-local edits diverge from the global store until explicitly
  reconciled.
- Disk overhead is real but bounded (wikis are bytes, not gigabytes).

### 3. Sync direction: push-only MVP, opt-in pull

For the MVP:

- `am wiki promote <slug>` and frontmatter `promote: true` push
  project-local entries up to the global store.
- `am wiki pull` (explicit, opt-in) materialises new entries from the
  global store down to the current project. Not invoked by default.
- Bidirectional sync (global changes propagating down to all projects
  automatically) is **not** in MVP. Deferred to a future ADR if user
  demand surfaces.

Rationale: bidirectional sync against multiple independent project
checkouts requires a state-tracking layer (which entries this project
already absorbed, which it deliberately did not). That's a quarter-bet,
not a sprint.

### 4. Default `.gitignore` posture

`.am-wiki/` is **gitignored by default** until ADR-0042 secrets
integration is end-to-end live (i.e., until age-encryption is enforced
on any wiki content that could reasonably contain secrets). Users who
want to commit `.am-wiki/` can opt in by removing it from
`.gitignore` and accepting responsibility for any leaked content.

Once ADR-0042 is fully integrated and `am wiki sanitize` exists, this
default flips to committed. That flip is a separate ADR.

### 5. Promotion gesture: frontmatter + command

Both:

- **Frontmatter flag** `promote: true` declares intent in the entry
  itself (visible in version control, survives directory moves).
- **Command** `am wiki publish <slug>` does the actual move + global
  store commit.

The flag without the command is a no-op until the user runs publish.
The command without the flag is also valid (explicit promotion).

This dual gesture matches Decap CMS's Editorial Workflow and gives
users both implicit ("flag this in passing") and explicit ("ship this
now") modes.

### 6. AGENTS.md schema for wiki

Each `.am-wiki/` is created with an `AGENTS.md` schema doc generated
from a hardcoded template. The template is **version-pinned** in the
file's frontmatter (`schema_version: 1.0`). Custom edits to AGENTS.md
are preserved by `am wiki sync`; the version pin is updated only by
`am wiki upgrade-schema`.

Per-project full customisation is **not** in MVP. Users who want a
custom schema can edit AGENTS.md after init; we document that future
schema upgrades may overwrite. Per-project schemas-from-scratch are an
extension point in v2.

### 7. Parallel adapter expansion (does NOT block)

The cross-tool harvest gap (currently 2 of 13 IDE adapters can read
sessions for wiki ingestion) is **a separate workstream**. The two-tier
materialisation ships independently. Adapter expansion happens in
parallel; the wiki tier model is layout-correct even with only 2/13
adapters supplying content.

### 8. Tier model: two-tier MVP, extensible

Two tiers in the MVP:

- **Project-local** wiki at `.am-wiki/` (project-specific notes,
  pre-promotion drafts, project-private content).
- **Global** wiki at `~/.config/agent-manager/wiki/` (cross-project
  knowledge, shared across all the user's projects).

The on-disk layout reserves `.am-wiki/workspaces/<name>/` for a future
**workspace** tier (e.g., monorepo packages, multi-repo workspaces) so
adding it later does not require schema migration. Users in a monorepo
today are well-served by a single project tier.

### 9. Implementation surface

- `src/wiki/storage.ts` — gain `materialiseProject()` (copy-based) and
  `pushToGlobal()`.
- `src/commands/wiki/init.ts` — write `.am-wiki/` instead of
  `.agent-manager/wiki/`; copy global entries marked with `auto-pull`
  frontmatter or none if global store is empty.
- `src/commands/wiki/publish.ts` — new command for §5.
- `src/commands/wiki/migrate.ts` — new command for §1 transition.
- `src/commands/wiki/pull.ts` — new command for §3.
- `src/wiki/agents-md-template.ts` — hardcoded template per §6.
- Default `.gitignore` template gains `.am-wiki/` per §4.

## Consequences

### Positive

- Windows users have a working wiki out-of-the-box.
- Cross-tool agent compatibility (any agent that reads a directory can
  read `.am-wiki/`).
- Project-local notes are first-class.
- Two-tier model gives users a natural promotion gesture for cross-
  project knowledge.

### Negative

- Disk overhead — wikis duplicated across projects. Mitigated by wikis
  being small (bytes, not gigabytes); future v2 can add hardlink
  optimisation if pain emerges.
- Sync UX is more complex than symlink (project-local edits can
  diverge). The `am wiki status` command (existing) remains the way to
  see divergence; `am wiki publish` resolves it.
- One-time migration cost for users with existing `.agent-manager/wiki/`
  directories (handled by `am wiki migrate`).

## Verification gates (resolved — ADR promoted to `accepted` 2026-05-05)

All gates below held at promotion time. Implementation evidence in commits
`270b939`, `479f61f`, `3026d5f` (Wave A/B/C of the ADR-0044 rollout).

1. **Implementation lands.** ✓ Resolved. `am wiki init`, `am wiki migrate`,
   `am wiki publish`, `am wiki pull` all implemented in `src/commands/wiki.ts`
   and wired into the `wiki` subcommand table. CLI sanity confirmed via
   `bun run dev wiki --help` (W-C10): all four verbs appear.
2. **Migration tested on a fixture project.** ✓ Resolved. `am wiki migrate`
   round-trips `.agent-manager/wiki/` → `.am-wiki/` with backup; covered by
   the wiki test suite (Wave B).
3. **`AGENTS.md` template version-pin enforced** by validator. ✓ Resolved.
   Template generated with `schema_version: 1.0` frontmatter; `am wiki sync`
   preserves user edits and leaves the pin untouched.
4. **Documentation updated.** ✓ Resolved. `docs/wiki.md` and the vision doc
   reflect `.am-wiki/` + the two-tier model; in-help text lists the new
   verbs.
5. **ADR-0022 status updated** to reference this ADR. ✓ Resolved.
   ADR-0022 frontmatter carries `status: superseded-in-part-by-ADR-0044` +
   `amended_by: ADR-0044`; a cross-reference note covers the symlink
   helpers retained for backward compatibility (see ADR-0022).
6. **Default `.gitignore` posture.** ✓ Resolved. `am wiki init` calls
   `ensureAmWikiGitignore(projectDir)` (src/commands/wiki.ts) which adds
   `.am-wiki/` to the project `.gitignore` by default, per §4. Flip to
   committed-by-default is gated on ADR-0042 and will be a separate ADR.

## References

- [ADR-0020](0020-llm-wiki-introduction.md) — wiki concept (unchanged)
- [ADR-0022](0022-wiki-location-strategy.md) — original location
  strategy (this ADR amends §3-4)
- [ADR-0042](0042-universal-secrets-strategy.md) — secrets backend
  (gates the gitignore-default flip in §4)
- `docs/design/2026-05-05-llm-wiki-vision.md` — vision doc that
  informed this ADR
- `docs/deliberations/2026-05-05-D-fanout/CONVERGENCE.md` — 6-way
  fan-out deliberation establishing 6/6 unanimous on B1, B2, B7
