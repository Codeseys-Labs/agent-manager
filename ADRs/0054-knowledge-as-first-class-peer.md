---
status: proposed
date: 2026-06-01
amends: ADR-0020, ADR-0022, ADR-0044
---

# ADR-0054: Knowledge as a First-Class Peer — Live Write-Path, Cross-Project Index, and the Context-Hub Boundary

## Context

agent-manager's north star is a **git-versioned backend consolidating a superset of
agent configuration + tools + skills + knowledge, local AND remote** (see
[ADR-0031](0031-product-scope-and-pillars.md); the six pillars are the axes of that
superset). Pillar 5 (the LLM-wiki) is the **knowledge** axis. A 2026-06-01
architecture assessment (`docs/research/wiki-knowledge-architecture-recommendation.md`,
`wiki-current-architecture-audit.md`) found that knowledge is currently a
**second-class silo** rather than a peer of config/tools/skills:

1. **Derived artifacts go stale.** `writePage` (`src/wiki/storage.ts:585-612`) writes
   only the markdown file — it never updates the knowledge graph
   (`addPageToGraph`) or the wikilink edges (`generateWikilinks`). Backlinks and
   orphan detection (`graph.ts:153`) operate on a batch-rebuilt, stale graph.
2. **Inter-project navigation does not exist.** Every retrieval primitive resolves
   exactly one `wikiDir` (`resolveWikiDir`, `storage.ts:74-98` — project XOR global,
   never a union). There is no global meta-index and no `--all-projects` search.
   The ROADMAP "cross-project knowledge linking" item is unchecked with no scaffolding.
3. **Knowledge is not derived from the catalog.** NER uses a hardcoded `KNOWN_TOOLS`
   list (`ner.ts:14-44`) instead of the resolved config's server/agent/skill names —
   the wiki does not auto-link the actual catalog entities.
4. **Promotion does not cross projects.** `pushToGlobal` (`storage.ts:388-390`) lands
   in the per-project mirror, not `wiki/global/`.

Separately, **Andrew Ng's Context Hub** (`github.com/andrewyng/context-hub`,
npm `@aisuite/chub`, MIT, ~13.5K★, 100% JS) raised the recurring "should we integrate
it?" question. Research (`docs/research/wiki-context-hub-research.md`) confirmed it is
real and MIT-licensed, but it solves a **different problem** — a curated, versioned
registry of LLM-optimized **API documentation** (anti-hallucination), closer to
Context7 / the MCP Registry than to our session-harvested per-project knowledge — and
it ships 7 runtime deps + its own CLI/MCP-server/telemetry, violating the
single-binary, zero-runtime-dep tenet ([ADR-0010](0010-bunts-single-binary.md)).

## Decision

1. **Move graph + wikilink + search-index maintenance onto the `writePage` write
   path** (incrementally, to bound write amplification), and **derive NER entities
   from the resolved catalog** (server/agent/skill/instruction names) with a small
   static fallback. This makes knowledge a structural peer of config/tools/skills.
2. **Introduce a committed cross-project meta-index** (`wiki/meta-index.json`, keyed by
   entity/tag/slug → `{project, slug, confidence}[]`) plus `am wiki search --all-projects`,
   rebuilt on `am wiki sync` and on demand (never on every page write). **Fix promotion
   to target `wiki/global/`** behind an explicit promotion gate. As built
   (`am wiki publish`, `storage.pushToGlobal`), the gate is two-pronged:
   - the **`--promote` flag is the explicit per-invocation gate** — without it both
     `<slug>` and `--auto` keep the ADR-0044 per-project-mirror target, so no entry
     reaches `wiki/global/` by accident;
   - the **`promote: true` frontmatter field is the *discovery* gate for the batch
     `--auto` path** — `am wiki publish --auto --promote` scans `.am-wiki/` and only
     promotes entries that opt in via that field.
   A named-slug promotion (`am wiki publish <slug> --promote`) does **not** require the
   frontmatter field: passing `--promote` for one explicitly-named entry *is* the opt-in.
   Adding a frontmatter check to the named-slug path is deferred backlog
   (WIKI-supersede-consumer-adjacent), not a correctness gap.
3. **Adopt Context Hub's annotation loop** as a synthesizer refinement — the
   `{id, note, updatedAt}` shape with prior agent notes treated as **untrusted input**
   (path-traversal validation on id). **Reject whole-adoption** of `@aisuite/chub`;
   allow an **optional external `chub-mcp` content source via `am mcp-serve`** (never
   embedded) for users who want curated API docs alongside their project knowledge.
4. **Reaffirm the ADR-0010/0002 boundary:** all knowledge enrichment (optional
   embedding rerank, semantic graph edges, optional LLM extraction at the write path,
   viz export) must serialize back to git-diffable markdown + `index.json` + `graph.json`.
   No daemon, no vector/graph DB server, no required native addon at the storage/sync
   layer (`storage.ts`, `sync.ts`, isomorphic-git stay native + dep-free).

Implementation is sequenced as R1→R8 in
`docs/research/wiki-knowledge-architecture-recommendation.md` §4.

## Consequences

### Positive
- Knowledge becomes a first-class peer of config/tools/skills (the north star).
- Graph/backlinks/orphans are always current (correctness fix, not a perf knob).
- Genuine cross-project knowledge navigation (the unchecked ROADMAP item).
- The wiki auto-links real catalog entities, tightening the superset's internal links.
- A legally-clean, dependency-free borrow from Context Hub without bloat.

### Negative
- Write amplification on `writePage` (mitigated: incremental index/graph updates).
- A new committed JSON artifact (`wiki/meta-index.json`) to keep diff-clean.
- A `WikiPage` frontmatter schema change (add `supersedes`/`superseded_by`/`coverage`/
  `entities`, change `confidence` to the ADR-0020 enum) requires a one-time migration.

### Neutral
- Amends the *implementation posture* of ADR-0020/0022/0044 without changing their
  decisions; supersedes nothing.
- The LLM-extraction stage (R8) is optional and gated — the local-first/zero-dep
  default is unchanged.

## Alternatives Considered

1. **Status quo + batch rebuilds.** Rejected: a stale graph is a correctness bug
   (backlinks/orphans lie between rebuilds), not a tunable performance trade-off.
2. **Vendor or fork Context Hub for the knowledge layer.** Rejected: wrong problem
   shape (global curated API docs, not per-project session knowledge), and it violates
   ADR-0010 — 7 runtime deps, a duplicate CLI (commander vs our citty), its own MCP
   server, and PostHog telemetry. Embedding it would bloat the single binary and
   couple us to a 0.x external corpus.
3. **This decision** — write-path liveness + cross-project meta-index + catalog-derived
   NER + technique-only Context Hub borrow + optional MCP content source — chosen: it
   promotes knowledge to a peer while honoring every existing tenet.

## References

- `docs/research/wiki-knowledge-architecture-recommendation.md` — the consolidated recommendation (R1–R8 roadmap)
- `docs/research/wiki-current-architecture-audit.md` — the pillar-5 audit (file:line evidence)
- `docs/research/wiki-context-hub-research.md` — Context Hub investigation (existence, MIT license, deps, techniques)
- ADR-0010 (single binary / zero runtime deps), ADR-0002 (git-backed/diffable), ADR-0020 (LLM-wiki),
  ADR-0022 / ADR-0044 (dual-tier wiki), ADR-0031 (six pillars / superset north star), ADR-0016 (session harvest)
- `[[project-north-star-superset]]` (recorded project goal)
