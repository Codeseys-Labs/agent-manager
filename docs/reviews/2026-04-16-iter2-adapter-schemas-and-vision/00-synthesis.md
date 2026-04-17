# Iter2 Multi-Facet Audit — Synthesis

**Date:** 2026-04-16 (evening session)
**Baseline:** agent-manager post-hardening (commit 0fdbcf3). 2202 tests, 0 fail.
**Method:** 7 parallel specialist agents across facets the iter1 audit did NOT cover — adapter storage correctness, vision coherence, post-hardening regression, user journeys, protocol spec conformance, cross-cutting UX, and quality of the new tests themselves.
**Per-facet reports:** `01-adapter-schemas.md` … `07-new-test-quality.md`

The iter1 audit + hardening wave left a visibly safer surface but accumulated second-order risk. This audit's explicit purpose: confirm the vision is intact, catch what the hardening itself broke, and verify adapter storage paths match real-world IDE conventions (the user's specific call-out).

## Scorecard

| # | Facet | Score | Critical | High | Headline |
|---|-------|------:|---------:|-----:|----------|
| 01 | Adapter schemas/storage | 6/10 | **3** | 4+ | continue uses deprecated config; kilo-code misses VS Code extension entirely; copilot macOS-only. |
| 02 | Vision coherence | 6.5/10 | 0 | 3 | Core (TOML→configs→git) still a 9/10. Surface is 5/10 — ACP runtime, Flows, Marketplace, Worker, Wiki, TUI share one binary with no scope gate. |
| 03 | Post-hardening regression | — | 0 | 3+ | ~25 second-order risks introduced. Riskiest: `c58c2bf` (MCP) — `allowUnsafeLocal: true` default, redactor gaps, bearer timing oracle. Atomic writes break symlinked configs. |
| 04 | User journeys | — | — | — | 23 silent-failure points. Worst: diff/undo — no top-level `am diff`; undo reverts catalog but not IDE configs → drift. |
| 05 | Protocol conformance | MCP 70% / ACP 85% / A2A 55% | 1 | 6+ | A2A missing `tasks/list` (MUST), wrong Agent Card URL, MCP accepts any `jsonrpc`, no initialize-first enforcement. |
| 06 | Cross-cutting UX | 5/10 | 0 | 2+ | Zero spinners, inconsistent JSON envelope, only 0/1 exit codes, silent partial `apply` failures. |
| 07 | New test quality | — | — | — | 14 anti-patterns: atomic-write crash never tested; SSE heartbeat asserts constant equals itself; no timing-safe check on auth. |

## Cross-Cutting Themes

### Theme G — "The hardening hardened the facade, not the foundation"

Multiple reports independently found the same pattern: the new code *refers to* the protection mechanism but doesn't exercise it.

- Atomic-write tests never test the crash-mid-write scenario (07).
- SSE heartbeat test asserts the interval constant equals 30000 (07).
- Bearer auth test never verifies `constantTimeEq` is actually called (07).
- `McpServer` constructor defaults to `allowUnsafeLocal: true` for "backwards compat" — only the CLI path is strict (03).
- Atomic write's `renameSync` silently replaces symlinks — breaks dotfile users (03).
- `constantTimeEq` short-circuits on length mismatch → timing oracle leaks token length (03).

**Implication:** our `bun test` green is optimistic. The hardening tests mostly prove code exists, not that it protects.

### Theme H — "Surface sprawl dilutes the core"

Vision report (02) + UX polish (06) + architecture report from iter1 all converge: too many surfaces share one binary. The user's "chezmoi for AI agent configs" mental model cannot hold when the binary also runs a flows engine, a Cloudflare Worker, a TUI, a web wiki, an A2A server, and an ACP runtime.

This is an *architectural* theme, not a code-quality one. The fix is scope-cutting, not refactoring.

### Theme I — "Adapter storage doesn't match the real world" (CRITICAL)

The user's call-out validated. Three CRITICAL adapter mismatches, plus a systemic Linux/Windows/Insiders/VSCodium gap across all VS Code extension adapters.

**Per adapter:**
- **continue** — still reads `~/.continue/config.json`. Modern Continue uses `config.yaml` + `.continue/mcpServers/*.yaml`. Our import sees zero servers on current installs.
- **kilo-code** — covers only CLI (`~/.config/kilo/kilo.jsonc`), ignores the VS Code extension (`kilocode.Kilo-Code`) where most users actually live.
- **copilot** — `detect.ts:23` hardcodes macOS path for user-scope `mcp.json`. Linux + Windows users silently get nothing.
- **All VS Code ext adapters (cline/roo-code/kilo-code/copilot)** — hardcode `"Code"` dir name. Users on VS Code Insiders (`"Code - Insiders"`), VSCodium (`"VSCodium"`), Cursor (`"Cursor"`), Windsurf (`"Windsurf"`), or per-profile storage silently get nothing.
- **Roo Code / Kilo Code** — lowercased extension ID lookups may fail on case-sensitive Linux filesystems.
- **Windsurf** — detects a global rules file it never reads.

If the tool promises "generate native configs for every tool" but then silently reads from dead paths, the core promise is broken. This is higher priority than any CVE.

### Theme J — "Protocol wire compatibility is not yet there"

A2A server: 55% spec-conformant. MCP server: 70%. ACP client: 85%.

- A2A: missing `tasks/list` entirely (spec MUST, returns -32601). Wrong Agent Card URL (`/.well-known/agent.json` vs v0.3's `/.well-known/agent-card.json`). No `A2A-Version` header. AgentCard missing `protocolVersion`, `securitySchemes`, `preferredTransport`. Accepts client-provided `taskId` which v0.3 forbids. `tasks/cancel` non-idempotent.
- MCP: accepts any `jsonrpc` value (no "2.0" validation). Accepts requests with missing/null id. Hardcodes protocolVersion "2024-11-05" without negotiation. Dispatches tools/list before initialize. No duplicate-id check in batch.
- ACP: mostly conformant; gaps are ambiguities, not violations.

Independent implementations will not interop reliably until at least the MUSTs close.

### Theme K — "Silent failures and exit code 0 lies"

Journeys (04) + UX (06) + post-hardening (03) all independently found: `am apply` returns exit 0 even when adapters fail. Five `catch {}` blocks around `commitAll` swallow git errors. `am undo` says "run am apply to regenerate" and leaves IDE/catalog drift if the user doesn't.

For a tool whose primary product is safety-of-write, silent-0 is the worst possible default.

## Severity-Aggregated Top 12

Ranked by impact × likelihood × distance-from-core-vision:

1. **continue adapter reads deprecated path** — import returns zero servers on modern installs. Core promise broken. (01 CRITICAL)
2. **kilo-code adapter ignores VS Code extension storage** — most users invisible. (01 CRITICAL)
3. **copilot adapter macOS-hardcoded** — silent no-op on Linux/Windows. (01 CRITICAL)
4. **All VS Code ext adapters miss Insiders/VSCodium/profile variants** — Cursor/Windsurf dir-name drift. (01 HIGH, systemic)
5. **`McpServer` default `allowUnsafeLocal: true`** — every non-CLI instantiation opens write-tier unauthed. (03 HIGH)
6. **`constantTimeEq` length short-circuit** — timing oracle leaks token length. (03 HIGH)
7. **`am apply` exits 0 on per-adapter failure** — tests pass, shell scripts don't notice. (04 + 06 HIGH)
8. **A2A spec non-conformance** — missing tasks/list, wrong Agent Card URL, accepts forbidden client-provided taskId. (05 HIGH)
9. **MCP initialize-first not enforced, `jsonrpc` not validated, protocolVersion not negotiated.** (05 HIGH)
10. **Atomic-write `renameSync` replaces symlinks silently** — breaks users with dotfile-linked configs. (03 HIGH)
11. **Hardening tests don't test the hardening** — atomic-write crash path untested; heartbeat asserts constant; auth asserts value eq not timing-safe. (07 HIGH)
12. **Vision surface sprawl** — Worker, Flows, Marketplace, Wiki, TUI in one binary hurts the "chezmoi for configs" pitch. (02 HIGH, architectural)

## Fix Wave Plan

Organized by workstream with file-conflict analysis. 5 parallel waves safely.

### Wave A — Adapter correctness (USER'S EXPLICIT CALL-OUT — ships first)
Scope: rewrite storage paths + schema for 3 critical + Insiders/VSCodium fallbacks for all VS Code extension adapters.
Files: `src/adapters/continue/`, `src/adapters/kilo-code/`, `src/adapters/copilot/`, `src/adapters/cline/`, `src/adapters/roo-code/`, plus shared `src/adapters/vscode/` helper (new) + tests + adapter e2e fixtures.
Risk: HIGH impact (core promise), low file overlap.

### Wave B — Hardening's own gaps
Scope: McpServer strict-default, timing-safe fix (`constantTimeEq`), atomic-write lstat-before-rename, redactor pattern expansion.
Files: `src/mcp/server.ts`, `src/core/atomic-write.ts`, `src/lib/redact.ts`, tests.
Risk: medium (touches the surface 33 tools depend on; need thorough tests).

### Wave C — Protocol conformance
Scope: MCP initialize-first + jsonrpc validation + protocolVersion error + batch id dedupe; A2A tasks/list + Agent Card URL + header + card fields + reject client taskId + idempotent cancel.
Files: `src/mcp/server.ts`, `src/protocols/a2a/server.ts`, `src/protocols/a2a/generate-card.ts`, `src/protocols/a2a/types.ts`.
Risk: medium. Wave B also touches mcp/server.ts — C must run after B or merge sections.

### Wave D — Silent failures + UX
Scope: `am apply` summary + exit code on partial failure; `warn()` helper + migrate `info("warning:...")` call sites; distinguish "nothing to commit" from commit errors in the 5 catch blocks; `am undo` post-step reminder or auto-apply.
Files: `src/commands/apply.ts`, `src/commands/undo.ts`, `src/lib/output.ts`, `src/commands/add.ts`, `src/commands/import.ts`, `src/commands/secret.ts`.
Risk: low overlap with other waves.

### Wave E — Test-quality fixes
Scope: crash-mid-atomic-write test; SSE heartbeat real test; bearer timing-safe spy test; TOFU interactive prompt branch.
Files: `test/core/atomic-write.test.ts`, `test/protocols/hardening-wave-1b.test.ts`, `test/mcp/auth-gate.test.ts`, `test/marketplace/tofu.test.ts`.
Risk: zero src overlap; can run last.

### Deferred (requires user alignment before touching)
- **Vision scope cut** (Theme H): Cloudflare Worker, Flows engine, Marketplace scope-down. Architectural decision, not a fix.
- **Cross-cutting UX larger work** (06): unified JSON envelope, streaming JSONL, error-class taxonomy with documented exit codes, `--retry`/`--resume`.

## Recommendation

Land Waves A + B + C + D + E in one pass (5 parallel fix agents, as before). Then surface the Vision scope-cut discussion to the user before v0.5.0 tag. The 0.5.0 line is tenable after Waves A–E; 1.0 still requires the scope-cut decision.

All 7 reports cite file:line. Phase 3 dispatch ready.
