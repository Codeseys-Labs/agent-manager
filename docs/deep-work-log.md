# Deep Work Log

## Run 2026-05-01 — started at 8a4d5f0

**Scope:** Drive the Phase-1 research backlog to zero. Items identified by four parallel research agents (ADR drift, test gaps, TODO/issue sweep, pillar alignment).

**Budget:** 3 execution waves + architect/research phases + final verification.

**Baseline hash:** `8a4d5f09dcdb91ed94e8295eb0fd50e6170b8a17`

**Pre-existing in-flight items (from issue #2):**
- npm publish not configured (needs NPM_TOKEN secret — **blocked on user**)
- Release marked isPrerelease:false (workflow fix)
- Windows CI re-baseline (test run + continue-on-error removal)
- End-to-end install-path test (needs a published release — **blocked on prior items**)
- NODE_OPTIONS forwarding docs
- arg-named promptTemplate decision (implement or remove)
- Tier-2 shim E2E tests (**blocked on CI runner images**)
- Phase E community shim configs
- Phase F release verification job
- Phase G Windows portability pass

**New items from Phase 1 research:**
- MCP security hardening cluster (5 sub-items — path traversal tests, progress redaction tests, env-sandbox integration test, bridge permissionPolicy test, ADR-0021 reconciliation)
- `am_agent_detect` wire-up (Wave C deferred TODO in src/mcp/server.ts:2207)
- `am wiki sync` correctness gaps (M5 — commits, per-project remotes, conflict handling)
- ADR-0027 / ADR-0028 status contradiction (README vs frontmatter)
- ADR-0026 Wave C attribution mismatch (file location)
- Phase E openclaw scope fence (ADR amendment before borrowing)
- `synthesizeContext` untested I/O path
- Full skill/agent drift detection across all 13 adapters (ROADMAP)
- LLM-powered NER extraction (ROADMAP Phase 2)
- Shell completion meta-tooling note (ADR-0031 non-goals)
- `acp-shell-cli.ts` CLAUDE.md directory-map entry
- Wiki browser design doc status unclear

