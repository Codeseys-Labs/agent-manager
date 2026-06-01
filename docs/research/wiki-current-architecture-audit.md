# LLM-Wiki (Pillar 5) Architecture Audit — Intra- and Inter-Project Knowledge Navigation

**Date:** 2026-06-01
**Scope:** `src/wiki/*`, `src/commands/wiki.ts`, `src/core/instructions.ts`, ADR-0020/0022/0044, ROADMAP Phase-2 wiki items.
**North star:** a git-versioned backend consolidating a SUPERSET of agent config + tools + skills + KNOWLEDGE, local AND remote.

---

## TL;DR

The wiki is a competent, zero-dependency, git-backed, single-tier knowledge store with good *intra*-project plumbing (BM25 search, rule-based NER, a JSON knowledge graph, orphan detection) but essentially **no inter-project navigation**. There are two physical tiers on disk (`wiki/global/`, `wiki/projects/<name>/`, plus per-project `.am-wiki/` copies), but every retrieval primitive operates on **exactly one resolved `wikiDir` at a time** — `resolveWikiDir()` returns either the project wiki *or* the global wiki, never a union. There is no meta-index, no cross-tier graph edge, no cross-project search. The ROADMAP item "Cross-project knowledge linking (global wiki as a meta-index)" (`ROADMAP.md:198`) is unchecked and there is no scaffolding for it. The harvester is regex-only (ADR-0020 Phase 1) — the "LLM as compiler" core of the Karpathy pattern that the ADR is named after is not built. An external knowledge-context library would plug cleanly at the synthesizer/retrieval seam; it is forbidden by ADR-0010 at the storage/transport seam.

---

## (a) How knowledge is stored

**Format.** One markdown file per page with hand-rolled YAML frontmatter. `WikiPage` (`src/wiki/types.ts:11-26`): `slug, title, type, content, tags, sources, backlinks, created, updated, confidence?, agent_id?`. Page types map to subdirs via `PAGE_SUBDIRS` (`src/wiki/storage.ts:48-54`): `entity→entities`, `concept→concepts`, `summary→summaries`, `synthesis→synthesis`, `decision→decisions`. Frontmatter is parsed by a bespoke parser (`parseFrontmatter`, `src/wiki/storage.ts:441-534`) — handles key:value, inline `[a,b]`, and block `- item` arrays only. **No real YAML library** (nested maps, multiline scalars, anchors all unsupported). Writes are atomic via temp-file + `rename` (`writePage`, `src/wiki/storage.ts:585-612`).

**Frontmatter drift from the ADR.** ADR-0020 specifies a richer `WikiPageMeta` (`ADRs/0020-...:206-222`): `source_sessions`, `entities`, `supersedes`/`superseded_by`, `coverage`, `confidence: "high"|"medium"|"low"`. The shipped `WikiPage` has none of `supersedes`, `superseded_by`, `coverage`, or `entities`; `confidence` is a `number` not an enum. So **contradiction resolution ("invalidate, don't delete", ADR-0020:323-328) is unimplemented** — there is no field to record a supersession. The vision doc's proposed `visibility: "project"|"global"|"both"` and `promote: bool` fields (`docs/design/2026-05-05-llm-wiki-vision.md:287-289`, `ADR-0044:118-128`) are **also absent from `types.ts`** — `pushToGlobal` exists as a command but the declarative `promote: true` frontmatter flag it was meant to pair with has no schema field and is never read.

**Location (three physical slots, ADR-0022 + ADR-0044).**
- Global store: `~/.config/agent-manager/wiki/global/` — cross-project knowledge, inside the git-backed AM repo (`getProjectWikiDir`/`resolveWikiDir`, `src/wiki/storage.ts:74-98`).
- Per-project mirror in the AM repo: `~/.config/agent-manager/wiki/projects/<name>/` (`getProjectWikiDir`, `src/wiki/storage.ts:122-124`).
- Project-local copy: `<project>/.am-wiki/` (`WIKI_PROJECT_DIRNAME`, `src/wiki/storage.ts:195`), gitignored by default (`ADR-0044:104-114`).

**The `.am-wiki` two-tier copy model.** ADR-0044 replaced ADR-0022's symlink with **copy** semantics (Windows breakage, agent visibility, broken-symlink-on-clone, project-local edits — `ADR-0044:18-44`). `materialiseProject()` (`src/wiki/storage.ts:263-333`) copies from `wiki/projects/<name>/` down into `.am-wiki/`; **global wins on byte-difference, silently overwriting local edits** (`src/wiki/storage.ts:248-251, 312-317`) — the conflict UI is explicitly deferred (`src/wiki/storage.ts:252-253`). `pushToGlobal()` (`src/wiki/storage.ts:360-405`) promotes one entry up, refusing on byte-conflict unless `force` (`src/wiki/storage.ts:394-401`). The legacy symlink helpers are retained for back-compat (`createProjectWikiLink`, `ensureWikiGitignore` — `src/wiki/storage.ts:127-182`, the latter `@deprecated`).

---

## (b) INTRA-project navigation — is it good?

**Mostly yes, within one tier.**

**Search (MiniSearch/BM25).** `searchPages` (`src/wiki/storage.ts:732-752`) over fields `title, content, tags_joined` with `boost: {title:2, tags_joined:1.5}`, `fuzzy:0.2`, `prefix:true` (`src/wiki/storage.ts:714-725`). Index persisted to `index.json`, lazily rebuilt if missing/corrupt (`loadSearchIndex`, `src/wiki/storage.ts:763-781`). Incremental update via `discard`+`vacuum`+`add` (`updateSearchIndex`, `src/wiki/storage.ts:797-808`). This is solid for personal/team scale and matches ADR-0020's "no vector DB needed" stance (`ADR-0020:59, 537-539`).
  - *Gap:* the index is rebuilt from `listPages` which reads **every file every time** — `O(files)` disk reads per rebuild; fine at hundreds, a latency cliff at thousands (ADR-0020 itself flags index.json as the bottleneck at 1000+ pages, `ADR-0020:578-581`).
  - *Gap:* `queryEntries` structured filtering (`src/wiki/storage.ts:941-987`) re-reads and parses all pages on every call — no use of the index.

**Knowledge graph.** Stored as a JSON adjacency list at `<wikiDir>/graph.json` (`graphPath`, `src/wiki/graph.ts:18-20`). `addPageToGraph` (`src/wiki/graph.ts:51-126`) extracts `[[wikilinks]]` (weight 1.0), entity-mention edges (weight 0.5), and synthesises backlink edges (weight 0.3). `getRelatedPages` is 1-hop neighbors (`src/wiki/graph.ts:138-150`); `exportGraphForViz` emits `{nodes, edges}` (`src/wiki/graph.ts:163-180`).
  - *Critical gap — the graph is not maintained on the write path.* `writePage` (`src/wiki/storage.ts:585-612`) updates the **search index** but **never calls `addPageToGraph`**. Grepping shows `addPageToGraph` is not invoked from `storage.ts`, `harvester.ts`, or the `add`/`ingest`/`harvest` command paths. The graph is only as current as the last explicit `graph`/`lint` run that rebuilds it. So `am wiki graph` and orphan detection operate on a **potentially stale graph** unless a rebuild step ran. This is the single biggest intra-project correctness issue.

**NER auto-linking.** Rule-based, no ML (`src/wiki/ner.ts`). Patterns for URLs, file paths, `@scope/pkg`, TOML/dotted config keys, CLI commands, `camelCase()` functions, plus a 38-name `KNOWN_TOOLS` exact-match list (`src/wiki/ner.ts:14-44`). `generateWikilinks` links the first occurrence of each entity whose slug matches a known page (`src/wiki/ner.ts:245-274`).
  - *Gap:* `generateWikilinks` is **not called on the write path** either — the harvester appends an "Extracted Entities" bullet list to page bodies (`harvester.ts:101-110`) but does **not** wikilink them, so the auto-linking that would feed the graph's `[[wikilink]]` edges rarely fires. The NER list is static; new tools/libs require code edits.

**Orphan detection.** `findOrphans` = nodes with no inbound edges (`src/wiki/graph.ts:153-160`); surfaced by `am wiki lint`. Plus richer gap heuristics in `identifyGaps` (`src/wiki/synthesizer.ts:212-298`): missing entity-type coverage, low-confidence clusters, isolated (unreferenced) entries, staleness (>30d), sparse single-entry tags. Good descriptive health signals.
  - *Caveat:* orphan detection inherits the stale-graph problem above.

**Verdict (b):** Intra-project *primitives* are good; intra-project *wiring* is half-connected — search index is maintained live, but the graph and NER auto-linking are batch-only and not triggered by `writePage`, so the "knowledge graph" and "backlinks" are frequently behind reality.

---

## (c) INTER-project navigation — can knowledge flow ACROSS projects?

**No, beyond a single manual promotion gesture.**

- **Every retrieval primitive is single-`wikiDir`.** `searchPages`, `listPages`, `queryEntries`, `loadGraph`, `synthesizeContext`, `getAllEntries` all take one `wikiDir` (or default via `getWikiDir()`/`resolveWikiDir()`). `resolveWikiDir` (`src/wiki/storage.ts:74-98`) returns **either** the project `.am-wiki/`/legacy link **or** `wiki/global/` — never both. There is **no API that unions tiers** and **no API that iterates `wiki/projects/*`**. Confirmed: the only code that touches `wiki/projects` outside `getProjectWikiDir` is the web layer enumerating directories for browsing (`src/web/server.ts:719-723`, `src/web/worker.ts:535-582`) — read-only listing, not cross-project retrieval.

- **No global meta-index.** ADR-0022 §4 designates `wiki/global/` for cross-project knowledge (`ADRs/0022-...:127-131`), but nothing **builds** a meta-index of what exists across projects. The global wiki is just another flat page store; it has no "this concept appears in projects X, Y, Z" structure. The ROADMAP names the missing piece exactly: "Cross-project knowledge linking (global wiki as a meta-index)" — **unchecked** (`ROADMAP.md:198`).

- **The only cross-project flow is manual, one-entry promotion.** `am wiki publish <slug>` → `pushToGlobal` copies a `.am-wiki/` entry up to the per-project mirror (`src/commands/wiki.ts:1748`, `src/wiki/storage.ts:360-405`). Note this pushes to `wiki/projects/<name>/`, **not** `wiki/global/` — re-reading `pushToGlobal`, the destination is `getProjectWikiDir(projectName)` (`src/wiki/storage.ts:388-390`), i.e. the project mirror, **not** the cross-project global store. So even the "promote" gesture does not actually land knowledge in the cross-project tier; the vision's "I learned something here that applies everywhere" path (`docs/design/...vision.md:162-165`) is **not realised** — `publish` is project-local→project-mirror, full stop.

- **Cross-tool harvest is 85% empty.** The wiki's *input* is `SessionReader`, implemented for **2 of 13 adapters** (claude-code, codex-cli — `docs/design/...vision.md:52-54`). Inter-project knowledge can't accumulate if 11 tools never feed it. ADR-0044 §7 explicitly decoupled this as a parallel workstream (`ADR-0044:144-151`), so it remains open.

- **The graph cannot cross tiers by construction.** `graphPath` is `<wikiDir>/graph.json` (`src/wiki/graph.ts:18-20`) — one graph per tier. A wikilink in project A to a concept in project B has nowhere to resolve and no edge to live on.

**Verdict (c):** Inter-project navigation is effectively **non-existent**. There are sibling silos under one git repo, not a connected knowledge web. `publish` does not even reach the cross-project tier.

---

## (d) Does the git-versioned model serve "superset, local+remote"? Or is the wiki siloed?

**Partly serves it; partly siloed.**

**Serves it:**
- The global store + project mirrors live **inside the AM config git repo** (`ADRs/0022-...:96-101`), so `am wiki sync` (and `am push`) version and transport them remotely with the rest of the catalog. This is genuinely "git-versioned, local + remote" for the global/mirror tiers.
- Markdown + frontmatter is a clean, auditable, exportable superset member (ADR-0020 "human-readable, no vendor lock-in", `ADRs/0020-...:554-556`).

**Siloed / not-yet-superset:**
- **`am wiki sync` only syncs the global tier.** `syncSubcommand` hardcodes `resolveWikiDir({ global: true })` (`src/commands/wiki.ts:1082`). It does **not** sync `.am-wiki/` project copies (those ride the *project's own* repo if un-gitignored, or nothing) and there is no per-project-mirror push selection. So the "one git-versioned backend" story has two disconnected transports: the AM repo (global) and each project repo (`.am-wiki/`, gitignored by default → often transported by *neither*).
- **The wiki is a separate island from config/tools/skills.** The north star wants a *superset* — config + tools + skills + knowledge in one consolidated, navigable backend. Today the wiki shares the git repo with config but shares **no schema, no index, no graph, no cross-reference** with servers/skills/agents/profiles. An agent/skill defined in `config.toml` and a wiki page about it are not linked. The NER `KNOWN_TOOLS` list (`src/wiki/ner.ts:14-44`) is hardcoded rather than derived from the actual catalog — a missed, cheap consolidation seam.
- **Apply-time injection is shallow and global-blind.** `generateWikiContext` (`src/core/instructions.ts:145-176`) only fires when `settings.wiki.inject_on_apply` is set, calls `listPages()`/`synthesizeContext("project knowledge", {topK:5})` against the **default-resolved** single tier, and is wired into only **4 of 13 adapters** (claude-code, codex-cli, forgecode, kilo-code — confirmed via grep of `generateWikiContext` callers). The injected query is a fixed string `"project knowledge"`, not the agent's actual task — so relevance is weak.

**Verdict (d):** The global tier is well-served by git; the project tier and the cross-domain consolidation are siloed. It is "knowledge in the same repo as config," not yet "knowledge as a navigable peer of config/tools/skills."

---

## (e) Concrete architectural gaps + the 3-5 highest-value improvements

**Gap inventory (concrete, cited):**
1. Graph + NER auto-linking are **not on the write path** (`writePage` updates search but not graph; `harvester` doesn't wikilink) — `src/wiki/storage.ts:585-612`, `src/wiki/harvester.ts:101-110`. → stale graph, missing edges, false orphans.
2. **No cross-tier / cross-project read API** — every primitive is single-`wikiDir` (`src/wiki/storage.ts` throughout). No union search, no `wiki/projects/*` iteration, no meta-index (`ROADMAP.md:198`).
3. **`publish` lands in the project mirror, not the cross-project global** (`pushToGlobal` → `getProjectWikiDir`, `src/wiki/storage.ts:388-390`) — the "applies everywhere" promotion is a no-op for cross-project sharing.
4. **Contradiction model unimplemented** — no `supersedes`/`superseded_by`/`coverage` fields despite ADR-0020:323-328; `confidence` is a number not the spec's enum.
5. **LLM extraction unbuilt** — harvester is regex pattern-matching (`src/wiki/harvester.ts:126-306`); the Karpathy "LLM as compiler" stages `extract`/`compile`/`distill` (ADR-0020:228-330) don't exist. ROADMAP "LLM-powered extraction" unchecked (`ROADMAP.md:194`).
6. **`am wiki sync` is global-only** (`src/commands/wiki.ts:1082`); project `.am-wiki/` has no first-class sync transport.
7. **`materialiseProject` silently clobbers local edits** (global wins, `src/wiki/storage.ts:248-251`) — deferred conflict UI is a data-loss footgun.
8. **Apply-time injection** is fixed-query, 4/13 adapters, single-tier (`src/core/instructions.ts:145-176`).
9. **Harvest is 2/13 adapters** — the feed pipe is 85% empty (`docs/design/...vision.md:52-54`).

**Highest-value improvements (ranked):**

1. **Wire the graph and wikilinking into `writePage` (or a post-write hook).** Make `writePage` (or `addEntry`/`ingest`) run `generateWikilinks` then `addPageToGraph`+`saveGraph` so the graph and backlinks are always live. This fixes #1 and makes orphan detection, `getRelatedPages`, and any future graph viz trustworthy. Low risk, high payoff, zero new deps.

2. **Build a global meta-index for cross-project linking (the unchecked ROADMAP item).** Add an `aggregate`/`reindex --all` that iterates `wiki/projects/*` + `wiki/global/`, producing a global index keyed by entity/tag/slug → `{project, slug, confidence}[]`, and a cross-project graph whose nodes carry a `project` field. Expose `am wiki search --all-projects` and a meta-`getRelatedPages` that returns cross-tier neighbors. This is the core of the north-star "navigate across projects." Stays markdown+JSON, ADR-0010-compatible.

3. **Make promotion actually cross-project.** Fix `pushToGlobal` to optionally target `wiki/global/` (true cross-project tier) vs the project mirror, gated on the `promote: true` frontmatter flag (which must first be added to `WikiPage`/`types.ts`). Pair with the meta-index so promoted pages become globally discoverable.

4. **Task-aware, multi-tier apply-time injection across all adapters.** Replace the fixed `"project knowledge"` query with the active profile/agent context, union project+global tiers, and route through the shared instruction generator so all 13 adapters (not 4) get wiki context. Optionally inject by *reference* (a pointer to `.am-wiki/`) per the vision (`docs/design/...vision.md:194-198`) to avoid bloating CLAUDE.md.

5. **Implement the contradiction/supersession fields** (`supersedes`, `superseded_by`, `coverage`) so re-harvested knowledge invalidates rather than duplicates — the Graphiti insight ADR-0020 already committed to. Cheap schema add; unlocks honest confidence over time.

(Adjacent, lower-tier but high-leverage: close the SessionReader gap for the top-6 adapters per the vision's prioritisation — `docs/design/...vision.md:230-242` — since improvements 1-5 are wasted on an empty shelf.)

---

## (f) Where an external knowledge-context library plugs in cleanly vs where ADR-0010 forbids it

**Clean plug-in seams (additive, behind the existing single-`wikiDir` API):**

- **Retrieval / ranking layer (best seam).** `synthesizeContext` (`src/wiki/synthesizer.ts:18-122`) and `searchPages` (`src/wiki/storage.ts:732-752`) are the natural injection points. An external library could provide embedding-based reranking or hybrid BM25+semantic scoring **as an optional enhancer over the same markdown pages** — exactly the ADR-0020 stance: "vector search could be added as an optional Phase 5+ backend... markdown wiki remains source of truth" (`ADRs/0020-...:605-622`). Implement as a strategy that, if available, reranks `searchPages` results; otherwise fall back to BM25. ROADMAP "Embedding-based semantic search" (`ROADMAP.md:195`) lives here.
- **Graph layer / cross-project linking.** `src/wiki/graph.ts` is self-contained JSON I/O; an external graph/embedding library (e.g. for entity resolution or similarity edges) could enrich `addPageToGraph` to add `related` edges by semantic similarity, or power the meta-index. Keep the JSON adjacency list as the durable artifact; the library is a compute aid, not the store.
- **Extraction stage (the unbuilt LLM compiler).** ADR-0020's `extract`/`compile`/`distill` (`ADRs/0020-...:228-330`) is *designed* for a pluggable LLM. An external library/provider for the LLM extraction step slots in here naturally (it's already "LLM dependency for write path", `ADRs/0020-...:572-577`) — write-path only, never read-path.
- **Visualization export.** `exportGraphForViz` (`src/wiki/graph.ts:163-180`) already emits a `{nodes,edges}` shape ready for an external viz lib to render an HTML/Obsidian-style graph (ROADMAP item `ROADMAP.md:196`) — pure export target, no constraint conflict.

**Where ADR-0010 (BunTS single binary, zero runtime deps) forbids it:**

- **The storage / transport / sync layer must stay native.** `storage.ts` (markdown CRUD, frontmatter), `sync.ts`/`resolve.ts` (isomorphic-git FF-only pipeline, conflict sidecar), and the git transport are bound by ADR-0010's "zero runtime deps, single `bun build --compile` binary" and ADR-0002's git-backed-everything. A library introducing a daemon, a vector DB server (ChromaDB/Qdrant/pgvector), a graph DB (Neo4j/FalkorDB), or a native-addon dependency is **out** — explicitly rejected in ADR-0020 alternatives 1 & 2 (`ADRs/0020-...:605-639`). Any embedding model must be either a pure-JS/WASM in-process option or an *optional* network call, never a required infra dependency — mirroring how BetterLeaks is an optional shell-out, not a hard dep.
- **The wiki index format is a committed API.** `index.json`/`graph.json` are git-committed and browsed by the stateless CF Worker UI (`src/web/worker.ts:535-582`); swapping in a library's opaque binary index would break web browsing and git-diffability (ADR-0022 neutral note, `ADRs/0022-...:233-235`). External enrichment must serialize back to the markdown+JSON artifacts.

**Net:** plug enrichment in at the *retrieval/ranking/extraction/viz* seams as optional strategies that read and re-emit the existing markdown+JSON; keep the *store and transport* native and dependency-free per ADR-0010.

---

## Appendix — key file:line map

- `src/wiki/types.ts:11-26` — `WikiPage`; `:69-110` `KnowledgeEntry`/`Provenance`; `:127-134` `WikiIndex`.
- `src/wiki/storage.ts:74-98` `resolveWikiDir` (single-tier); `:122-124` `getProjectWikiDir`; `:263-333` `materialiseProject` (global-wins clobber); `:360-405` `pushToGlobal` (→ project mirror, not global); `:585-612` `writePage` (search-only, no graph); `:714-781` MiniSearch BM25.
- `src/wiki/harvester.ts:126-306` regex extractors; `:101-110` entity bullets (no wikilink); `:308-379` Jaccard dedup + harvest.
- `src/wiki/synthesizer.ts:18-122` `synthesizeContext`; `:212-298` `identifyGaps`.
- `src/wiki/ner.ts:14-44` static `KNOWN_TOOLS`; `:245-274` `generateWikilinks` (not on write path).
- `src/wiki/graph.ts:18-20` per-`wikiDir` graph; `:51-126` `addPageToGraph` (not called by `writePage`); `:153-160` `findOrphans`.
- `src/wiki/sync.ts:238-361` `syncWiki` FF-only pipeline; `src/wiki/resolve.ts` conflict resolver.
- `src/commands/wiki.ts:1082` `sync` = global-only; `:1748` `publish` → `pushToGlobal`; `:1486,1641` `materialiseProject`.
- `src/core/instructions.ts:145-176` `generateWikiContext` (fixed query, 4/13 adapters).
- `ADRs/0020-...:206-222` spec'd frontmatter (drifted); `:323-328` contradiction model (unimpl); `:605-639` rejected DB alternatives.
- `ADRs/0044-...:56-128` copy-over-symlink + two-tier; `ROADMAP.md:192-198` Phase-2 (cross-project linking unchecked).
- `docs/design/2026-05-05-llm-wiki-vision.md` — two-tier vision, open decisions, 2/13-adapter feed gap.
</content>
</invoke>
