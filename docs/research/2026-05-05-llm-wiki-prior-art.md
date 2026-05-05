# LLM-Wiki Prior Art Survey

**Date:** 2026-05-05 · **Scope:** how existing tools represent persistent,
cross-session knowledge for LLM agents, and what patterns are borrowable for
`agent-manager`'s two-tier wiki (see companion `docs/design/2026-05-05-llm-wiki-vision.md`).
No recommendations here — recommendations live in the vision doc.

---

## 1. Karpathy's LLM Wiki (the seed idea)

Andrej Karpathy published the pattern as a gist, `llm-wiki.md`, in April 2026
and discussed it on Twitter / X. The core claim: at personal-knowledge scale,
you do not need a vector DB or RAG pipeline. You need **a folder of markdown
files that an LLM incrementally compiles and maintains**. Raw sources are the
"source code"; the wiki is the "binary" the agent re-reads.

Four invariants of the Karpathy pattern:

1. **Plain markdown on disk**, human-readable and git-diffable. No embeddings
   required (you can add them later as a cache, but they are not the store).
2. **A schema document** — `CLAUDE.md` for Claude Code, `AGENTS.md` for Codex
   — that tells the agent *how* the wiki is laid out, what the conventions
   are, and which workflows (ingest, answer, maintain) it runs.
3. **The LLM is the compiler**, not the database. Every new source is not just
   indexed; it is merged into existing pages, new pages are created, stale
   contradictions are reconciled.
4. **Coverage as a first-class signal** — each claim has provenance; multiple
   sources corroborating a claim is visible in the page itself.

ADR-0020 in this repo already names this as the direct inspiration
(`src/wiki/types.ts` carries the `// Wiki Page (Karpathy llm-wiki pattern)`
comment). The design question for `am` is not *whether* to use the pattern
but *where the files live* and *who maintains them across tool boundaries*.

Sources:
- Karpathy, *llm-wiki.md* (gist): https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f
- DAIR.AI explainer: https://academy.dair.ai/blog/llm-knowledge-bases-karpathy
- MindStudio walkthrough: https://www.mindstudio.ai/blog/andrej-karpathy-llm-wiki-knowledge-base-claude-code/

---

## 2. Comparison matrix

| System | Persistence model | Scope tiers | Storage | Open/closed | Key mechanism |
|---|---|---|---|---|---|
| Karpathy llm-wiki | Compiled markdown wiki | Single vault (per-user) | Plain `.md` files in a folder | Open pattern | LLM compiles sources → wiki; schema in `CLAUDE.md`/`AGENTS.md` |
| mem0 | Structured memory facts, LLM-curated | Conversation / Session / User / Org | Vector DB + metadata store (hosted or self-hosted) | OSS core + hosted | Add-on-turn extraction, dedup via similarity, scoped namespace |
| Letta / MemGPT | "Memory blocks" in context + archival vector DB | Core (in-context) + Archival (on-demand) per agent | Postgres + vector index | OSS | Agent self-edits core blocks via tools; archival via `archival_memory_insert`/`_search` |
| Cursor | Static markdown rules + "Memories" | User rules (global) + Project rules (`.cursor/rules/*.mdc`) + Memories (auto-learned, per-workspace) | Files on disk; memories in Cursor's local DB | Closed (files are open) | Rules inject at context start; Memories learned from chat feedback |
| Continue.dev | Rule files + context providers | Global (`~/.continue/`) + Workspace (`.continue/rules/`) + Hub (remote) | YAML + markdown files | OSS | Rules activate by glob/description; `@providers` pull live context at turn time |
| Codex CLI | `AGENTS.md` (static) + Memories (dynamic) | Global `~/.codex/memories/` + per-project `AGENTS.md` | Markdown + JSON under `~/.codex/` | Closed (files are open) | Agent writes to `~/.codex/memories/` between turns; redaction at write-time |
| Claude Code | Session JSONL (raw) + `CLAUDE.md` (static) | Global `~/.claude.json` + project `CLAUDE.md` + session log per project dir | JSONL per session + markdown | Closed (files are open) | Sessions persist verbatim under `~/.claude/projects/<encoded-path>/*.jsonl`; no extraction |
| Obsidian + Smart Connections | Notes vault + embedding cache | Single vault (user chooses scope) | Markdown + `.smart-env/` embeddings | OSS (plugin), vault is user's | Embeddings over vault, "connections" view, local-first LLM chat over selection |

---

## 3. Per-system notes + borrowable insight

**mem0.** Documented tier model: *Conversation* (single turn), *Session*
(minutes–hours), *User* (weeks–forever), *Org* (shared). New turns are run
through an extractor that decides `skip | update | add` against existing
facts by semantic similarity. **Borrowable:** the on-ingest dedup decision
tree — `am wiki harvest` today creates pages unconditionally.
https://docs.mem0.ai/core-concepts/memory-types

**Letta / MemGPT.** Formalises a core-vs-archival split: small editable
memory blocks always in context; a vector store queried on demand via
`archival_memory_insert` / `_search`. **Borrowable:** name the "always-in-
context" vs "queried-on-demand" distinction explicitly. For `am`,
`am_wiki_briefing` is the core-memory analog; `am_wiki_search` is the
archival analog.
https://www.letta.com/blog/memory-blocks

**Cursor.** Three surfaces: **User Rules** (global, personal, never
committed), **Project Rules** (`.cursor/rules/*.mdc` with frontmatter
`description | globs | alwaysApply`, committed), **Memories** (auto-learned
per workspace, opt-in). The `.mdc` frontmatter is a model-readable
activation spec. **Borrowable:** glob-scoped activation for injected wiki
pages (precedent: instructions' activation scope in `src/core/schema.ts`);
committed-project vs not-committed-user is exactly the two-tier sync
boundary.
https://cursor.com/docs/rules

**Continue.dev.** Rules in `.continue/rules/` (workspace) or `~/.continue/`
(global) or on a remote Hub. Context providers (`@File`, `@Code`, `@Issue`,
…) are pluggable at-turn retrievers. **Borrowable:** context providers as a
pluggable interface (our MCP `am_wiki_*` tools already gesture at this);
the Hub maps cleanly to pillar 4 marketplace, suggesting future `am wiki
subscribe <catalog>`.
https://docs.continue.dev/customize/rules

**Codex CLI memories.** Two surfaces: `AGENTS.md` (static, per-project,
committed) and `~/.codex/memories/` (dynamic, global-user, auto-written
between turns). Codex redacts secrets at write-time. Active community
demand for per-project memories (openai/codex#3043, discussion #12567) —
not shipped. **Borrowable:** redact-on-write (ties to ADR-0042); the fact
that a major product has the exact two-tier split we want and users are
begging for the missing half validates the vision.
https://developers.openai.com/codex/memories

**Claude Code.** Raw, total session persistence: every turn a line in
`~/.claude/projects/<encoded-path>/*.jsonl`. No extraction — `CLAUDE.md` is
hand-maintained. This is the gap ADR-0016/0020 fill. **Borrowable:** the
path-encoded project scoping convention — round-trips cleanly between
filesystem and URL-safe ids.

**Obsidian + Smart Connections.** Local-first. Markdown vault + embedding
index (`.smart-env/`) + "connections" sidebar. **Borrowable:** BM25/
embeddings as a *cache next to* the files, not as the files themselves —
validates our MiniSearch-over-markdown choice in `src/wiki/storage.ts`.
The "related to open note" affordance is an obvious TUI command (`am wiki
related <slug>`).
https://smartconnections.app/

---

## 4. Synthesis — what the prior art tells us about tier boundaries

Every production system above ships **at least two tiers** of persistent
knowledge. The tier names differ, but the concept cleaves the same way:

| Tier | Cursor | Continue | Codex | mem0 | Letta |
|---|---|---|---|---|---|
| "Always here, project-scoped" | Project Rules | Workspace rules | `AGENTS.md` | Session | Core memory |
| "Always here, user-scoped" | User Rules | Global rules | `~/.codex/memories/` | User | (n/a) |
| "On demand, searchable" | — | Context providers | — | Long-term store | Archival memory |
| "Shared/remote catalog" | — | Hub | — | Org | — |

Three takeaways for `am`:

1. **Two tiers is the industry floor.** Every shipping product differentiates
   project-scoped from user-scoped knowledge. Codex being missing a
   per-project half and users demanding it (issue #3043) is a direct data
   point that the two-tier design is table stakes, not novel.
2. **The "on-demand searchable" tier is distinct from the always-injected
   tier.** This is Letta's core-vs-archival, Continue's rules-vs-@providers.
   `am` already has it accidentally: `am_wiki_briefing` (MCP) is the
   always-injected analog, `am_wiki_search` is the on-demand analog. We
   should name this split explicitly in docs.
3. **The shared/remote tier is a real future direction, not a bolt-on.**
   Continue Hub and mem0 Org both exist. `am`'s marketplace (pillar 4)
   is the natural host. Deferring it is safe, but the storage layout should
   not preclude it.

What *none* of the prior art solves well is **cross-tool session harvest** —
every system assumes its own tool is the only producer of knowledge. `am`'s
differentiator (ADR-0016) is that 13 IDEs write sessions somewhere, and
`am` is the only unified reader. Today only 2/13 adapters implement
`SessionReader`; closing that gap is the single most leveraged investment
for pillar 5.

---

## 5. References

- Karpathy, *llm-wiki.md* gist — https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f
- DAIR.AI — https://academy.dair.ai/blog/llm-knowledge-bases-karpathy
- mem0 memory types — https://docs.mem0.ai/core-concepts/memory-types
- mem0 AI-memory-layer guide — https://mem0.ai/blog/ai-memory-layer-guide
- Letta memory blocks — https://www.letta.com/blog/memory-blocks
- Letta archival memory — https://docs.letta.com/guides/core-concepts/memory/archival-memory/
- Cursor Rules docs — https://cursor.com/docs/rules
- Continue Rules — https://docs.continue.dev/customize/rules
- Continue context providers — https://docs.continue.dev/customize/custom-providers
- Codex Memories — https://developers.openai.com/codex/memories
- Codex per-project memory request — https://github.com/openai/codex/issues/3043, https://github.com/openai/codex/discussions/12567
- Smart Connections (Obsidian) — https://smartconnections.app/, https://github.com/brianpetro/obsidian-smart-connections
- ADR-0016 (session harvest) — `ADRs/0016-session-harvest.md`
- ADR-0020 (session knowledge synthesis) — `ADRs/0020-session-knowledge-synthesis.md`
- ADR-0022 (wiki location strategy) — `ADRs/0022-wiki-location-strategy.md`
