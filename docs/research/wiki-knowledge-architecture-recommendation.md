# Wiki / Knowledge Layer — Architecture Recommendation

**Author:** Lead architect synthesis
**Date:** 2026-06-01
**Status:** Decision input (recommends a new ADR — see §6)
**Grounded in:**
- `docs/research/wiki-context-hub-research.md` (Andrew Ng Context Hub investigation)
- `docs/research/wiki-current-architecture-audit.md` (Pillar-5 LLM-wiki audit)
- Direct code verification (this report; line refs below were re-checked against `main`)

---

## 1. Bottom-line verdict

The wiki is a **competent intra-project store with a half-wired write path and an effectively
absent inter-project layer.** The storage foundation (single-file markdown + frontmatter,
MiniSearch BM25, JSON graph, orphan detection, dual global/project tiers, git-backed, zero
runtime deps) is the *right* foundation and is consistent with ADR-0010/0002/0020/0044. But three
structural facts keep it from being a first-class peer of config/tools/skills:

1. **The graph and auto-linking are not on the write path**, so the most valuable derived
   artifacts (backlinks, wikilink edges, orphans) go stale between manual rebuilds. Verified:
   `writePage` (`src/wiki/storage.ts:585-612`) writes only the markdown file; it never calls
   `addPageToGraph` or `generateWikilinks`. The search index is refreshed, but only via the
   legacy `addEntry`/`updateEntry` CRUD wrappers (`storage.ts:904,928`), not from `writePage`
   itself — and the harvester/synthesizer call `writePage` directly.

2. **Inter-project navigation does not exist.** Every retrieval primitive resolves exactly one
   `wikiDir` (`resolveWikiDir`, `storage.ts:74-98` returns project XOR global, never a union).
   There is no `searchAll`, no iteration over `wiki/projects/*`, no global meta-index. Verified:
   only `searchPages` / `queryEntries` / `searchEntries` exist, all single-dir. `ROADMAP`'s
   "cross-project knowledge linking" item is unchecked with zero scaffolding.

3. **The Karpathy "LLM-wiki" core the ADR is named after is unbuilt.** The harvester is
   regex/pattern-only (`harvester.ts` — "pattern matching", `extractEntities`), so the wiki is a
   *pattern-extracted* knowledge store, not an *LLM-synthesized* one. Combined with the
   2/13-adapter SessionReader coverage, the shelf is mostly empty regardless of how good the
   navigation gets.

On the Andrew Ng question: **Context Hub is real, MIT-licensed, but solves a different problem and
fails our single-binary constraint. Adopt one technique, optionally integrate as an external MCP
content source, do not vendor.**

The north star (git-versioned superset of config + tools + skills + knowledge) is **coherent**,
but **knowledge is currently a second-class silo**, not a peer. The fixes below are what promote it
to first-class, and that promotion is significant enough to warrant a new ADR.

---

## 2. Context Hub decision (license + fit gate is explicit)

**Decision: `adopt-techniques`** (with one optional, low-cost MCP-gateway integration).

### Gate 1 — Does it exist? PASS.
`github.com/andrewyng/context-hub`, npm `@aisuite/chub` v0.1.4, by Andrew Ng + DeepLearning.AI.
~13.5K stars, very active, 100% JavaScript. Confirmed real per the research report's raw-URL
checks (repo, LICENSE, `cli/package.json`).

### Gate 2 — License? PASS (clean).
**MIT**, "Copyright (c) 2026 Context Hub Contributors" (confirmed from raw LICENSE). Vendoring,
forking, or clean-room are all legally permissible; no clean-room is *required*. One caveat noted
in research: the README does not disambiguate whether the curated *doc corpus* in `content/` is
MIT or under a separate CLA — moot unless we ever mirror their content, which we will not.

### Gate 3 — Architectural fit vs ADR-0010/0031? FAIL for whole-adoption.
This is the decisive gate. `@aisuite/chub` is `type:module`, `node>=18`, with **7 runtime
deps** (`@modelcontextprotocol/sdk`, `chalk`, `commander`, `posthog-node`, `tar`, `yaml`, `zod`).
It is a standalone end-user CLI (`bin/chub` + `bin/chub-mcp`) that duplicates infrastructure we
already own:
- its own command framework (`commander`) vs our `citty`;
- its own MCP server vs our `am mcp-serve`;
- its own PostHog telemetry (a non-starter for a local-first tool);
- its own `~/.chub` state vs our git-backed config dir.

Bundling it violates **ADR-0010** (zero-runtime-deps single binary). Shelling out to a global npm
install violates "works on machines without node." So whole-adoption is rejected on fit, not on
license.

### Gate 4 — Problem overlap? NO — it is adjacent, not overlapping.
Context Hub is **"Stack Overflow / npm for AI-agent API docs"**: a curated, versioned,
LLM-optimized registry of *global* third-party API/SDK reference docs whose job is to stop agents
hallucinating stale API signatures. Our Pillar-5 wiki is *your project's* session-harvested,
synthesized knowledge. Context Hub is closer to **Context7 / our MCP Registry (ADR-0024)** than to
our wiki. Our differentiator — per-project session-harvested knowledge — is untouched by it.

### What we adopt (techniques, not code)
1. **The annotation → persistence → re-injection loop with "treat prior agent notes as UNTRUSTED
   input" framing.** This directly sharpens our session-harvest → wiki pipeline (ADR-0016/0020).
   Borrow the `{id, note, updatedAt}` shape and the path-traversal validation on `id`. This is the
   single highest-value idea and the trigger for the proposed ADR (§6).
2. **Versioned + language-faceted entries** — minor; relevant if we ever store per-version notes.
3. **Pre-built JSON BM25 index artifact** — validates our existing MiniSearch choice; no change.
4. **Multi-source registry with trust-order collision resolution** — we already do this
   (ADR-0024/0032/0039); confirms our approach.

### Optional integration (defer, low cost)
Let an agent routed through `am mcp-serve` optionally call an external `chub-mcp` for third-party
API docs — as an *external content source the user runs alongside us*, never embedded. This keeps
our wiki focused on project knowledge and our binary dep-free. Gate this behind explicit config;
do not make it a default dependency. Re-evaluate when Context Hub ships a real library export
surface (it is 0.x; formats may shift).

**Net:** MIT means both the technique and the optional integration are legally clean. We take the
annotation loop, we do not vendor the CLI/server/telemetry/corpus.

---

## 3. North-star coherence — where does "knowledge" sit?

**North star:** a git-versioned backend consolidating a *superset* of config + tools + skills +
**knowledge**, available local + remote, generating native configs and routing agents.

**Coherent? Yes.** Knowledge is named explicitly as Pillar 5 (ADR-0031) and the LLM-wiki rides the
same git repo as config (ADR-0002/0022/0044). Nothing about the wiki contradicts the six pillars;
it is a legitimate sixth-of-six concern feeding the same git-backed core and the same three UIs
(Pillar 6).

**Is it a first-class peer today? No — it is a second-class silo.** Concrete evidence:

- **No shared schema/index/graph with the catalog.** Servers/skills/agents/instructions live in
  the Zod-validated core schema; the wiki has its own `WikiPage`/`KnowledgeGraph` types
  (`src/wiki/types.ts`) with no cross-reference to the catalog. The clearest tell: NER's
  `KNOWN_TOOLS` is a **hardcoded literal array** (`ner.ts:14-44`: "Claude Code", "Cursor", "Bun",
  "Zod"…) instead of being derived from the resolved catalog of servers/agents/tools. The wiki
  literally cannot see the thing it is supposed to be knowledge *about*.

- **The git superset is only partly served for knowledge.** The global tier rides the AM git repo
  well, but `am wiki sync` is hardcoded to global-only (`src/commands/wiki.ts:1082` —
  `resolveWikiDir({ global: true })`). Per-project `.am-wiki/` is gitignored by default (ADR-0044)
  and has no first-class transport, so project knowledge is frequently transported by *neither*
  repo. Config does not have this gap.

- **Promotion to "applies everywhere" is broken.** `am wiki publish` → `pushToGlobal` targets
  `getProjectWikiDir(projectName)` — the per-project *mirror* under `wiki/projects/<name>/`
  (`storage.ts:388-390`) — **not** `wiki/global/`. So the cross-project promotion the north star
  implies never reaches the cross-project tier. Knowledge cannot be promoted the way a config
  entry can be globalized.

- **Apply-time injection is narrow and untargeted.** `generateWikiContext`
  (`core/instructions.ts:145`) fires for only 4/13 adapters, single-tier, with a fixed query
  ("project knowledge") rather than the agent's actual task. Config/skills/instructions reach all
  adapters; knowledge does not.

**Verdict on §3:** the north star is coherent and worth keeping verbatim, but the wiki must be
*promoted* from silo to peer. "Peer" concretely means: (a) the wiki derives entities from the
catalog instead of a hardcoded list; (b) project knowledge has a real git transport; (c)
promotion genuinely crosses projects; (d) injection reaches every adapter and is task-aware. Items
(a)–(d) are exactly the roadmap below.

---

## 4. Wiki improvement roadmap

Ranked by value/effort. All items respect ADR-0010 (zero runtime deps), ADR-0002 (git-diffable
markdown + JSON artifacts), and ADR-0020 (markdown-first). No daemon, no vector/graph DB, no
required native addon.

### Intra-project (correctness first)

**R1 — Wire the write path: graph + wikilinks + index in `writePage`. (S, do first)**
Make `writePage` (`storage.ts:585`) call `generateWikilinks` (`ner.ts:245`) on the body before
serialization, then `addPageToGraph` and `updateSearchIndex` after the atomic rename. This fixes
the single biggest correctness bug: backlinks, wikilink edges, and orphan detection
(`graph.ts:153`) currently operate on a stale graph because they are batch-only. Low-risk,
zero-dep. Guard against write amplification by keeping the index/graph updates incremental (the
`index.add(page)` path at `storage.ts:806` already supports this).

**R2 — Make the harvester emit wikilinks, not a bullet list. (S)**
Today the harvester appends a plain "## Extracted Entities" bullet list (`harvester.ts:101-110`),
so the `[[wikilink]]` edges that feed the graph rarely fire. Have it route extracted entities
through `generateWikilinks` so harvested pages participate in the graph from creation.

**R3 — Derive NER entities from the catalog. (M)**
Replace the hardcoded `KNOWN_TOOLS` (`ner.ts:14-44`) with a list derived from the resolved config
(server names, agent names, skill names, instruction targets). This is the key consolidation seam
that makes knowledge a peer of config — the wiki starts auto-linking the actual catalog entities.
Keep a small static fallback for generic tech terms.

**R4 — Honest contradiction handling. (M)**
Add ADR-0020's spec'd frontmatter fields to `WikiPage` (`types.ts:11`): `supersedes` /
`superseded_by` / `coverage` / `entities`, and change `confidence` from `number` to the spec enum.
This makes "invalidate, don't delete" implementable (currently unbuilt). Required before R5's
cross-tier merge can resolve conflicts honestly.

### Inter-project (the unchecked ROADMAP item)

**R5 — Global meta-index over `wiki/projects/*` + `wiki/global/`. (L)**
Build a committed `wiki/meta-index.json` keyed by entity/tag/slug → `{project, slug, confidence}[]`,
plus a cross-tier graph. Expose via `am wiki search --all-projects`. This is the unchecked
ROADMAP "cross-project knowledge linking" item. It is git-diffable JSON (consistent with the
web-UI-browsed `index.json`/`graph.json` contract at `web/worker.ts`), so it stays within ADR-0002.
Rebuild on `am wiki sync` and on demand; do not put it on every page write (too expensive across
projects).

**R6 — Fix `pushToGlobal` to actually reach `wiki/global/`. (M)**
Gate on a real `promote: true` frontmatter field (added in R4) and target `wiki/global/` instead of
the per-project mirror (`storage.ts:388-390`). Promotion becomes genuinely cross-project. Pair with
a conflict UI on `materialiseProject` (`storage.ts:263`) which today silently clobbers local edits
("global wins", line 250) — a data-loss footgun.

**R7 — Task-aware, multi-tier, all-adapter apply-time injection. (M)**
Extend `generateWikiContext` (`instructions.ts:145`) to all 13 adapters, query both project and
global tiers (and the R5 meta-index), and use the agent's task/profile as the query instead of the
fixed "project knowledge" string.

### Prerequisite (or the shelf stays empty)

**R8 — Close the SessionReader gap and add LLM extraction. (L–XL)**
Two compounding emptiness problems: (a) harvest is wired for only 2/13 adapters, so 85% of sessions
never feed the wiki — close the top-6 adapters; (b) the harvester is regex-only, so even harvested
sessions yield shallow pattern extraction, not the LLM synthesis the Karpathy pattern (and ADR-0020
§228-330) specifies. Add an *optional* LLM extraction stage at the write path only — gated, never a
required dependency, output serialized back to the same markdown+JSON artifacts (ADR-0020's own
embedding-rerank seam, §605-622, confirms this is the sanctioned extension point).

### Sequencing
R1 → R2 → R3 (intra correctness + consolidation) ship first and are mostly S/M. R4 unblocks R5/R6.
R8 runs in parallel as the content-supply track — without it, R5–R7 navigate an empty shelf.

---

## 5. External-library boundary (for any of R4–R8)

A knowledge/context library may plug at the **retrieval/ranking** layer (optional embedding rerank
over the same markdown — `synthesizer.ts`/`searchPages`), the **graph** layer (semantic "related"
edges, meta-index), the **LLM extraction** stage (R8, write-path only), and **viz export**
(`exportGraphForViz`, `graph.ts:163` → Obsidian/HTML). It is **forbidden by ADR-0010/0002** at the
**storage / transport / sync** layer: `storage.ts`, `sync.ts`, and isomorphic-git must stay native
and dependency-free. No daemon, no vector/graph DB server, no required native addon. Any enrichment
must serialize back to the committed, git-diffable markdown + `index.json` + `graph.json` artifacts
that the web UI already reads.

---

## 6. Does this warrant a new ADR? Yes — sketch below.

Two decisions here are durable and cross-cutting enough to record. Recommend **one ADR** covering
both (they share the "knowledge as first-class peer" thesis).

### Proposed ADR-0052 — "Knowledge as a First-Class Peer: Live Write-Path, Cross-Project Index, and the Context-Hub Boundary"

**Context.** Pillar 5's wiki is a second-class silo: derived artifacts go stale (graph/wikilinks
not on the write path), there is no inter-project navigation, knowledge is not derived from the
catalog, and promotion does not cross projects. Separately, Andrew Ng's MIT-licensed Context Hub
raises the recurring "should we integrate it?" question.

**Decision.**
1. **Move graph + wikilink + index maintenance onto the `writePage` write path** (R1/R2), and
   **derive NER entities from the resolved catalog** (R3) — making knowledge a structural peer of
   config/tools/skills.
2. **Introduce a committed cross-project meta-index** (`wiki/meta-index.json`) and
   `--all-projects` retrieval (R5); **fix promotion to target `wiki/global/`** gated on
   `promote: true` (R6).
3. **Adopt Context Hub's annotation loop** (`{id, note, updatedAt}` + untrusted-input/path-traversal
   framing) as a wiki synthesizer refinement; **reject whole-adoption** of `@aisuite/chub` on
   ADR-0010 grounds (7 runtime deps, duplicate CLI/MCP/telemetry); allow an **optional external
   `chub-mcp` content source via `am mcp-serve`**, never embedded.
4. **Reaffirm the ADR-0010/0002 boundary:** all enrichment serializes back to git-diffable
   markdown + JSON; no daemon/DB/native-addon at the storage/sync layer.

**Considered options (≥2, per adr-methodology):**
- **(A) Status quo + batch rebuilds** — rejected: stale graph is a correctness bug, not a perf knob.
- **(B) Vendor/fork Context Hub for the knowledge layer** — rejected: wrong problem shape (global
  API docs, not project knowledge) and violates ADR-0010 (deps, duplicate infra, telemetry).
- **(C) This decision** — write-path liveness + cross-project index + catalog-derived NER +
  technique-only Context Hub borrow — chosen.

**Consequences.** Write amplification on `writePage` (mitigated by incremental index/graph
updates); a new committed JSON artifact to keep diff-clean; `WikiPage` schema change (R4) requires a
one-time migration of existing frontmatter. Supersedes nothing; amends the *implementation* posture
of ADR-0020/0022/0044 without changing their decisions.

This ADR should be authored via the `adr-methodology` skill (MADR 3.0, ≥2 options, linked into the
ADR index in CLAUDE.md).

---

## 7. Citations
- Context Hub existence/license/deps/techniques: `docs/research/wiki-context-hub-research.md`
  (findings a–f; raw LICENSE = MIT; `cli/package.json` = 7 deps, node>=18).
- Wiki audit (storage, write-path, inter-project, schema gaps, library seams):
  `docs/research/wiki-current-architecture-audit.md`.
- Code re-verification (this report): `src/wiki/storage.ts:74-98,388-390,585-612,732,797-806,904,928`;
  `src/wiki/types.ts:11-26`; `src/wiki/harvester.ts:90-110`; `src/wiki/ner.ts:14-44,245`;
  `src/core/instructions.ts:145`; `src/commands/wiki.ts:1082`.
- Constraints: ADR-0010 (single binary, zero runtime deps), ADR-0002 (git-backed/diffable),
  ADR-0020 (markdown-first LLM-wiki), ADR-0022/0044 (dual-tier wiki), ADR-0031 (six pillars).
