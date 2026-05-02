# Pillar 5 review — LLM-wiki

## 1. Good today
- Strong north star: local-first, git-backed markdown, Karpathy “compiler not DB” pattern (ADRs/0020-session-knowledge-synthesis.md:57-70,74-78).
- Right extensibility seam: optional `SessionReader` plus unified `Session`/`Message`/filter/format model (src/core/session.ts:25-56,73-179; src/adapters/types.ts:209-217).
- Boring/good storage: markdown frontmatter, atomic writes, MiniSearch BM25, project/global symlink resolution (src/wiki/storage.ts:47-65,318-345,465-493; ADRs/0022-wiki-location-strategy.md:77-112).
- Agents have a route in: MCP wiki tools and apply-time context injection exist (src/mcp/server.ts:1817-2020; src/core/instructions.ts:145-171). Recent review also validated the `synthesizeContext` fix (docs/reviews/2026-05-02-adversarial-critique/synthesis.md:65-68).

## 2. Rough for a new user
1. Empty-state is thin: `list` says “Try ingest or add,” not “run init, inspect sessions, ingest last 5, then search” (src/commands/wiki.ts:966-968).
2. Vocabulary is split: ADR promises `extract/compile/query`; CLI ships `ingest/harvest/synthesize` (ADRs/0020-session-knowledge-synthesis.md:359-371; src/commands/wiki.ts:343-590).
3. Harvest is regex/pattern extraction, not LLM compile, so decision/rationale/open-question quality is below the ADR bar (src/wiki/harvester.ts:128-305; ADRs/0020-session-knowledge-synthesis.md:253-289).
4. Privacy posture is not visible at write time: sessions may contain secrets, while secret-scanned auto-commit is still M5 plan (ADRs/0016-session-harvest.md:121-124; docs/plans/wiki-sync-m5.md:21-24).
5. Several commands declare `--global` but ignore it (`ingest`, `harvest`, `synthesize`, `briefing`, `export`; e.g. src/commands/wiki.ts:343-382,563-606).
6. Graph/lint can feel broken: CLI loads graph, but ordinary page writes do not update it (src/commands/wiki.ts:758-766,865-873; src/wiki/graph.ts:50-126).

## 3. Rough for a power user
1. Sync is still a thin global push/pull wrapper with dirty-tree warnings; correctness UX is only planned (src/commands/wiki.ts:1009-1103; docs/plans/wiki-sync-m5.md:11-42).
2. No team subset/sharing model beyond global vs project; subtree export is a stretch follow-up (docs/plans/wiki-sync-m5.md:39-40,109-112).
3. No private/shared/page-scope concept in `WikiPage`; only tags/sources/backlinks/confidence/agent_id exist (src/wiki/types.ts:10-26).
4. Project name collisions are acknowledged but code uses remote basename or directory basename only (ADRs/0022-wiki-location-strategy.md:207-210; src/wiki/storage.ts:72-90).
5. Cross-project search is missing: `resolveWikiDir` chooses current project or global, not all projects (src/wiki/storage.ts:47-65).
6. Multi-machine conflict/relink/doctor flows are planned, not shipped (docs/plans/wiki-sync-m5.md:25-38,97-114).

## 4. Does the smarter-over-time loop close?
Partially. The loop is session logs → harvest entries → BM25/synthesize → optional instruction/MCP context (src/commands/wiki.ts:382-437; src/wiki/synthesizer.ts:18-121; src/core/instructions.ts:145-171). It does not yet compile durable topic/decision pages, track contradictions/coverage as ADR-0020 specifies (ADRs/0020-session-knowledge-synthesis.md:295-332), or record feedback: `am_wiki_add/harvest` return ids/counts and `am_wiki_synthesize` returns context, but no included-slug usage event, “was this helpful?”, or agent-visible “your note was reused” (src/mcp/server.ts:1873-1940,1994-2020).

## 5. Multi-provider / multi-agent
The adapter seam exists, but only Claude Code and Codex register readers today (src/adapters/claude-code/index.ts:58; src/adapters/codex-cli/index.ts:46). Cursor/Windsurf/aider/Kilo/Roo need concrete readers or a declared “session unreadable” contract, fixtures, and detection docs; ADR-0016 anticipated that variability (ADRs/0016-session-harvest.md:10-17,121-130).

## 6. Top 3 actionable improvements
1. **Onboard.** Problem: users hit an empty wiki. Fix: `am wiki status/onboard` runs init, lists supported readers, previews recent sessions, suggests ingest. Acceptance: clean project gets path, reader count, page count, next command.
2. **Usage feedback.** Problem: agents cannot tell if memory mattered. Fix: return included slugs/scores from synthesize; append `used_by_session`, `last_used_at`, `query` metadata. Acceptance: MCP synthesize updates a usage log and `am wiki show` displays use history.
3. **Ship M5 sync+privacy.** Problem: power users cannot trust multi-machine wiki writes. Fix: implement auto-commit, secret scan, fast-forward pull, resolve/relink. Acceptance: plan criteria pass (docs/plans/wiki-sync-m5.md:19-42).

## References
ADRs/0016-session-harvest.md; ADRs/0020-session-knowledge-synthesis.md; ADRs/0022-wiki-location-strategy.md; docs/plans/wiki-sync-m5.md; docs/reviews/2026-05-02-adversarial-critique/synthesis.md.
