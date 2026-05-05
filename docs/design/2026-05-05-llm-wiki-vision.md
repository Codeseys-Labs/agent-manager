# Two-Tier LLM-Wiki Vision for `am`

**Date:** 2026-05-05 · **Status:** design proposal, pre-ADR
**Companion research:** `docs/research/2026-05-05-llm-wiki-prior-art.md`
**Proposes ADR-0044** amending ADR-0022 §Decision points 3-4 (the symlink
mechanic + project-side gitignore) only. ADR-0022's central claims
(global-as-source-of-truth, per-project subdir, local-only mode) are
preserved. This vision document does NOT itself amend ADR-0022; ADR-0044
will, if/when authored.

This doc argues for a hybrid: global source-of-truth stays in the am repo,
project-local content is a **committed sibling** rather than a symlink.

---

## Executive summary

Pillar 5 of `am` (ADR-0031) promises a Karpathy-style LLM wiki. Today we
have the plumbing: `src/wiki/` (storage, harvester, synthesizer, NER,
graph, sync, resolve), 17 `am wiki` subcommands, 5 `am_wiki_*` MCP tools,
and the sync pipeline M5.1/M5.2. What we do *not* have is a crisp story
for two things the maintainer called out: (a) what's global vs
project-local, and (b) how either tier becomes visible to an agent that
has never heard of `am`. This doc picks an opinionated answer — **global
wiki lives in the am config repo and syncs via `am push/pull`;
project-local wiki lives at `<project>/.am-wiki/` as *real files*
(not a symlink), is optionally committed to the project repo, and is
kept in sync with the global tier by `am wiki sync` in both directions**
— then lays out phasing, MCP surface, and the eight open decisions that
still need the maintainer's call.

---

## 1. Current state (inventory)

**Code (`src/wiki/`):** `types.ts` (WikiPage, KnowledgeEntry, KnowledgeGraph,
WikiIndex, EntityCategory), `storage.ts` (780 LOC — markdown CRUD, frontmatter,
MiniSearch BM25 index, `resolveWikiDir()` that already follows a symlink in
`.agent-manager/wiki` if present), `harvester.ts` (session → entries),
`synthesizer.ts` (distill → pages), `ner.ts`, `graph.ts`, `sync.ts` (M5.2
FF-only pipeline: auto-commit, pull, rollback-on-conflict, sidecar),
`resolve.ts` (M5.3-lite conflict resolver with path-traversal guard).

**CLI (`src/commands/wiki.ts`, 17 subcommands):** `search, add, show, delete,
ingest, harvest, synthesize, briefing, export, import, lint, graph, list,
path, sync, resolve, init`.

**MCP (`src/mcp/server.ts`):** 5 tools — `am_wiki_search`, `am_wiki_add`
(write-local), `am_wiki_synthesize` (write-local), `am_wiki_briefing`,
`am_wiki_harvest` (write-local). Grouped under `wiki`.

**Session harvest (`src/core/session.ts`):** `SessionReader` interface
(`hasSessionStorage`, `listSessions`, `loadSession`). **Coverage: 2/13
adapters** — only `claude-code` and `codex-cli`. This is the feed pipe for
the wiki and it is 85% empty.

**Existing design:** ADR-0016 (session harvest), ADR-0020 (three-layer
knowledge model: episodic → working → procedural), ADR-0022 (symlink model
— central storage + `~/project/.agent-manager/wiki -> ~/.config/agent-manager/wiki/projects/<name>`).

**What works today:** global wiki writes, project wiki *if the symlink is
manually initialised*, BM25 search, two-adapter harvest, git-backed sync
with FF-only conflict detection.

**What does not work:** the symlink breaks on Windows without developer
mode; `.agent-manager/wiki` is awkward (mixes config symlink with the
project's adapter-specific `.agent-manager.toml`); nothing propagates
global→project automatically; nothing lets a stranger agent in a project
find the wiki because the path (`.agent-manager/wiki`) is non-obvious
and there's no schema doc telling the agent where to look.

---

## 2. Proposed two-tier architecture

### 2.1 Storage layout

**Global tier (authoritative, git-backed via am config repo):**

```
~/.config/agent-manager/
├── config.toml
├── wiki/
│   ├── global/                          # cross-project knowledge
│   │   ├── topics/<slug>.md
│   │   ├── decisions/<slug>.md
│   │   ├── rules/<slug>.md
│   │   ├── sessions/<slug>.md
│   │   ├── index.json
│   │   └── graph.json
│   └── projects/<project>/              # per-project mirror authored here
│       ├── topics/...
│       ├── decisions/...
│       ├── rules/...
│       ├── index.json
│       └── graph.json
└── .git/                                # am repo, pushed via `am push`
```

**Project-local tier (visible, optional commit into project repo):**

```
~/code/my-app/
├── .am-wiki/
│   ├── AGENTS.md                        # schema doc (Karpathy pattern)
│   ├── topics/<slug>.md
│   ├── decisions/<slug>.md
│   ├── rules/<slug>.md
│   └── .am-wiki.json                    # sync state: upstream ref, last pull oid
├── .agent-manager.toml                  # project config (unchanged)
├── AGENTS.md                            # project AGENTS.md gets a pointer: "see .am-wiki/"
└── .gitignore                           # user's choice per §2.4
```

**Rename rationale:** `.am-wiki/` over ADR-0022's `.agent-manager/wiki/` —
shorter, memorable, unambiguous, distinct from the config dir. A single
`.am-wiki/AGENTS.md` at the top tells *any* agent (Claude Code, Cursor,
Continue, a human, a bot) what's in the folder and how to use it. That
schema doc is the Karpathy pattern's linchpin.

### 2.2 Copy, not symlink — the reversal of ADR-0022

**Rejected alternative (ADR-0022):** symlink `.am-wiki/` to
`~/.config/agent-manager/wiki/projects/<name>/`.

**Picked:** project-local is *real files*, copied/materialised by
`am wiki sync`, with a `.am-wiki/.am-wiki.json` sidecar recording the
upstream commit oid that the local copy tracks.

Why the reversal:

1. **Windows.** Symlinks require developer mode or admin. Junction points
   are directory-only and confuse git. Copy has zero platform caveats.
2. **Git of the project repo.** If the user chooses to commit `.am-wiki/`,
   a symlink serialises as a broken "special file" on other machines; a
   real directory commits clean.
3. **Portability across clones.** `git clone my-app` gets a `.am-wiki/`
   that works offline, without am installed, without the am config repo.
4. **Agents that don't know am.** An agent opening a freshly cloned repo
   reads `.am-wiki/AGENTS.md` and uses the wiki. Symlink-to-missing-target
   hides everything.

The cost is drift — two copies can diverge. We manage it the same way
`am` already manages config drift (ADR-0006): the sync pipeline is the
single reconciler. `am wiki sync` in a project directory is the operation
that makes the two copies agree.

### 2.3 Sync semantics

`am wiki sync` becomes **bidirectional and tier-aware**:

1. **Push direction — local → global.** Any new/modified file under
   `<project>/.am-wiki/` whose frontmatter tag set matches the project's
   identifier is copied into `~/.config/agent-manager/wiki/projects/<name>/`,
   committed in the am config repo, and optionally pushed to the user's
   git backend via the existing M5.2 pipeline.
2. **Pull direction — global → local.** For each entry under
   `~/.config/agent-manager/wiki/projects/<name>/` whose frontmatter declares
   `visibility: project` or `visibility: both`, materialise a copy under
   `<project>/.am-wiki/`. Entries tagged `visibility: global-only` stay out.
3. **Promotion — project → global-shared.** An entry authored locally with
   frontmatter `promote: true` (or added via `am wiki publish <slug>`) is
   copied into `~/.config/agent-manager/wiki/global/` in addition to the
   project mirror. This is the "I learned something here that applies
   everywhere" path.
4. **Conflict.** Same entry edited in both places since the last sync →
   fall through to the existing M5.3 resolve pipeline
   (`wiki-conflict.json` sidecar, per-file `keep-local | take-remote | edit`
   prompt). We already built this for the config repo; the wiki reuses it.

**Sync granularity.** Run on demand (`am wiki sync`), on `am pull`
(opt-in via `settings.wiki.sync_on_pull = true`), or on a timer (deferred —
PLAN-4 already defers `auto_sync_interval_seconds` until the timer exists,
per the sync.ts comment).

### 2.4 "Visible to agents that don't know am"

The project-local tier is **just markdown files in the project**. No API,
no daemon, no MCP required for *read*. An agent walking the tree sees
`.am-wiki/AGENTS.md` and understands the convention from that file alone.

Concretely, `am wiki init` in a project does:

1. Create `<project>/.am-wiki/` if absent.
2. Write `<project>/.am-wiki/AGENTS.md` with the Karpathy schema prose —
   "this folder is an LLM wiki, here is the layout, here is how to
   add a page, here is how to ask `am` to sync it if am is installed".
3. Append a pointer to the project's existing `AGENTS.md` / `CLAUDE.md` /
   `.cursor/rules/` / `.continue/rules/` (only the ones the user has;
   detected via the existing adapter `detect()` methods):
   > *Project wiki: read `.am-wiki/` for decisions, patterns, and
   > project-specific knowledge.*
4. Record in `.agent-manager.toml`: `[wiki] project_mirror = ".am-wiki"`.

Crucially, step 3 **augments** the existing rules files by *reference*
rather than by injection. We do not copy wiki content into AGENTS.md;
we add a one-line pointer. This keeps the rules files small and keeps
the wiki the single source.

### 2.5 `.gitignore` posture — maintainer's call (see Open Decision 4)

Default: **gitignored**. Users who want the wiki to travel with the
project repo explicitly add it. Mirrors ADR-0022's choice and avoids
"surprise" commits on first `am wiki init`. But if the maintainer wants
the aggressive-visibility default, flip to committed-by-default and add a
`--private` flag on init. Both are defensible.

**Phase-A precondition (added post-review).** If Open Decision 4
(gitignore default) flips to "committed-by-default", then ADR-0042
age-envelope integration is a Phase-A prerequisite, NOT Phase B.
Harvester output today contains raw session text that may include
prompts, error messages, and command output with embedded secrets.
Committing those to the project repo before envelope encryption is
available creates a leak path that gitignore alone does not protect
against (rebases, force-pushes, fork mirrors). If Phase A ships with
gitignore=on as the default, ADR-0042 stays Phase B; if it ships
with gitignore=off, ADR-0042 must land first.

---

## 3. Cross-tool harvest gap (2/13 adapters)

**The empty-shelf problem.** Without `SessionReader` implementations for
11 adapters, the wiki is fed only from Claude Code and Codex CLI. Pillar 5
of ADR-0031 is literally called out as "an empty shelf" without session
harvest. The two-tier design changes nothing about this gap; it exposes it.

**Recommendation:** parallel track, not precondition. Shipping the two-tier
structure *first* gives the 2/13 adapters a better home (project-visible
`.am-wiki/`) and makes the remaining 11 adapters a growth curve rather
than a blocker. Each new adapter instantly wins for every user of that
tool. Prioritise (by user count we can infer from GitHub stars of each
tool): Cursor, Cline, Roo Code, Continue.dev, Windsurf, Kilo Code — these
six cover the next 80% of active users. Gemini CLI, Amazon Q, Kiro,
ForgeCode, Copilot are long-tail.

Each adapter's `session.ts` is a self-contained JSONL/JSON parser plus a
`SessionReader` implementation, following the two examples in
`src/adapters/claude-code/session.ts` and `src/adapters/codex-cli/session.ts`.
Budget: ~1 day per adapter once format is documented; ~3 days when it is
not. Six adapters ≈ 2 weeks of focused work. This is a natural follow-on
task after the two-tier vision lands.

---

## 4. MCP surface — current and proposed

**Current (5 tools):**

| Tool | Tier | Purpose |
|---|---|---|
| `am_wiki_search` | read | BM25 search |
| `am_wiki_add` | write-local | Add a page or entry |
| `am_wiki_synthesize` | write-local | Generate context block |
| `am_wiki_briefing` | read | Agent briefing (always-inject analog) |
| `am_wiki_harvest` | write-local | Ingest a session |

**Proposed additions (4 tools):**

| Tool | Tier | Purpose |
|---|---|---|
| `am_wiki_get_page` | read | Retrieve by slug (needed; currently search-only) |
| `am_wiki_related` | read | Graph neighbours of a slug (Smart-Connections analog) |
| `am_wiki_publish` | write-local | Promote project-local entry to global |
| `am_wiki_sync` | write-local | Trigger the bidirectional sync |

Rename consideration: scoping arguments. Every read/write tool today
implicitly uses the wiki directory resolved from cwd. With the two-tier
design explicit we should add `scope: "project" | "global" | "both"` to
every tool, defaulting to `"both"` (search) or `"project"` (writes).
Backwards-compat via omitted-arg defaulting to today's behaviour.

---

## 5. Build phases

### Phase A — ships in 1-2 weeks (high-confidence, low-risk)

1. **Rename and re-home:** introduce `.am-wiki/` as the canonical project
   mirror path, with `.agent-manager/wiki/` as a deprecated alias that
   emits a warning. (`resolveWikiDir` already centralises this.)
2. **Replace symlink with copy** in `am wiki init`. Keep symlink support
   in `resolveWikiDir` for back-compat, but new inits use directories.
3. **Write `.am-wiki/AGENTS.md`** on init — the schema doc. Pointer
   injection into existing `AGENTS.md`/`CLAUDE.md`/`.cursor/rules/` via
   idempotent append.
4. **Frontmatter fields:** add `visibility: "project" | "global" | "both"`
   and `promote: bool` to `WikiPage` in `src/wiki/types.ts`. Storage
   handles round-trip.
5. **Bidirectional sync:** extend `src/wiki/sync.ts` to detect project
   context and run the push/pull/promotion logic. Reuse M5.3 conflict
   resolve for overlap.
6. **Two new MCP tools:** `am_wiki_get_page`, `am_wiki_publish`.
7. **Docs:** two-tier model in `README.md` + `AGENTS.md` pillar 5 section.

**Test strategy:** contract tests for sync push/pull/promotion, property
test for conflict sidecar shape, cross-platform file ops test
(Linux/macOS/Windows CI already exists).

### Phase B — quarter-long bet (high-value, non-trivial)

1. **Fill the SessionReader gap for 6 adapters** (Cursor, Cline, Roo,
   Continue, Windsurf, Kilo). Each is independent; can be parallelised
   across contributors.
2. **`am_wiki_related`** (graph neighbours, using `src/wiki/graph.ts`).
3. **Dedup decision tree** in `harvester.ts` — `skip | update | add`
   instead of unconditional create (the mem0 borrow).
4. **Age-envelope integration** for wiki content flagged as sensitive,
   via ADR-0042's backend (opt-in `sensitive: true` frontmatter flag
   → encrypts body at rest; shown plaintext only after decrypt).
5. **TUI affordances:** `am tui wiki` browse, `am wiki related` view.

### Phase C — not on the roadmap (parked)

1. Wiki marketplace / hub (`am wiki subscribe`) — wait until catalog
   marketplace is battle-tested first.
2. Embedding-based retrieval on top of BM25 — only if users hit
   recall limits; MiniSearch with good titles and tags is sufficient
   for personal scale.
3. Workspace-level tier (see Open Decision 8).
4. Real-time session tailing.

---

## 6. Open decisions (numbered, for maintainer)

1. **Rename `.agent-manager/wiki/` → `.am-wiki/`?** Doc assumes yes.
   Alternative: keep `.agent-manager/wiki/` for consistency with
   `.agent-manager.toml`. Cost of rename: deprecation period, docs
   churn, one extra code path in `resolveWikiDir` during transition.
2. **Copy or symlink for new `am wiki init`?** Doc argues copy. If
   maintainer wants to keep symlink for non-Windows users, we could
   gate behind `settings.wiki.mirror_strategy = "copy" | "symlink"`
   with copy as default.
3. **Bidirectional sync or push-only?** Doc assumes bidirectional.
   Push-only (project → global, no materialisation down) is simpler
   and ships faster; costs: no visibility for users who clone on a
   new machine and want the project wiki populated.
4. **Default `.gitignore` posture.** Doc assumes gitignored-by-default.
   Alternative: committed-by-default (more visible, more shared, more
   risk of secrets leaking until ADR-0042 lands).
5. **Promotion gesture — frontmatter flag or explicit command?** Doc
   assumes both (`promote: true` and `am wiki publish <slug>`).
   Could force explicit command only (less magic, more keystrokes).
6. **Schema doc (`AGENTS.md` inside `.am-wiki/`) — maintain as hardcoded
   template or allow per-project customisation?** Doc assumes hardcoded
   template with version pin in frontmatter. Customisation is an easy
   future extension.
7. **Close the SessionReader gap before or alongside two-tier?** Doc
   argues alongside (parallel). Alternative: block two-tier on at least
   4/13 adapters first so the tier split has content to separate.
8. **Two-tier vs N-tier (monorepo / workspace layer)?** Doc defers.
   A monorepo today just maps to one project for `am` purposes. If
   users demand per-package wikis inside a monorepo, we add a third
   `workspace` tier later. Storage layout above does not preclude it
   (`wiki/workspaces/<name>/` alongside `wiki/projects/<name>/`).

---

## 7. Cross-reference to prior art

The prior-art survey (`docs/research/2026-05-05-llm-wiki-prior-art.md`)
shows that every production system ships at least two tiers. Cursor
committed-project-rules + non-committed-user-rules is the nearest
analog; Codex `AGENTS.md` + `~/.codex/memories/` validates the split
(and Codex's missing per-project memory, per openai/codex#3043, is
exactly what our project-local tier delivers). The Karpathy schema
doc is the load-bearing convention that makes the wiki legible to
agents that don't know `am`. mem0 gives us the dedup decision tree
for Phase B.

What the two-tier design uniquely contributes, vs. every prior-art
system: **cross-tool session harvest as the input**, and **git-backed
sync as the transport**. Neither is present in mem0, Letta, Cursor,
Continue, Codex, or Obsidian+Smart-Connections. Both are already
implemented in `am` (partially — 2/13 adapters) and uniquely fit the
existing architecture (ADR-0002 git-backed everything, ADR-0001
adapter pattern). The two-tier wiki is the feature that makes these
two invisible-but-present building blocks *visible* to users.

---

## 8. References

- ADR-0016 — `ADRs/0016-session-harvest.md`
- ADR-0020 — `ADRs/0020-session-knowledge-synthesis.md`
- ADR-0022 — `ADRs/0022-wiki-location-strategy.md` (partly superseded)
- ADR-0031 — `ADRs/0031-product-scope-and-pillars.md` (pillar 5)
- `docs/research/2026-05-05-llm-wiki-prior-art.md`
- `docs/plans/wiki-sync-m5.md` (M5.1/M5.2 shipped; M5.3 partial)
- Karpathy llm-wiki — https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f
- Codex per-project memory request — https://github.com/openai/codex/issues/3043
- Cursor rules — https://cursor.com/docs/rules
