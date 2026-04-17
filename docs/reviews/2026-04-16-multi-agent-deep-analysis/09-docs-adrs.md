# Docs & ADR Audit — agent-manager

**Date:** 2026-04-16
**Scope:** Documentation accuracy, ADR currency, onboarding friction, doc-code drift
**Reviewer:** docs-adrs facet (multi-agent deep analysis)

---

## Summary

agent-manager has grown fast — 15 review iterations, 30 ADRs, 182 source files, version 0.4.0. The documentation estate is **surprisingly thorough** — CHANGELOG, CONTRIBUTING, ROADMAP, CLAUDE.md, AGENTS.md, adapter-development-guide.md, cli-lifecycle.md, system-architecture.md, and 30 ADRs all exist. Major feature claims in the README (13 adapters, 33 MCP tools, 31 commands, flow engine, A2A server, ACP client, community adapters, marketplace, brownfield import) **all map to real code**.

But there is meaningful drift that will confuse a new contributor:

1. **Four ADRs (0026, 0027, 0028, 0030) are still `status: proposed` in their frontmatter despite being shipped** — 0026 ACPX (code exists: `src/protocols/acp/`), 0027 community adapters (code exists: `src/adapters/community/`), 0028 brownfield merge (`src/core/merge.ts`, `am import --auto`), 0030 unified agent registry (`src/core/agent-registry.ts`).
2. **`ADRs/README.md` index is missing ADR-0029 and ADR-0030 entirely** and shows 0026 as Accepted while the ADR file itself says Proposed.
3. **Community adapter JSON-RPC protocol contract is nowhere documented** except in source comments — `docs/adapter-development-guide.md` only covers built-in adapters. A plugin author cannot learn the protocol without reading `src/adapters/community/*.ts`.
4. **No index in `docs/reviews/`** — ten dated folders, no README explaining what's in each.
5. **Minor count mismatches:** README claims 1864 tests; CHANGELOG claims 1916; ROADMAP/CONTRIBUTING/README all use 1864. Project stats table in README says 1859. README claims "31 commands"; `src/commands/` has 32 `.ts` files (init and init-project both resolve to `am init`).

Nothing is dangerously wrong, but the "proposed" ADRs and missing plugin-author guide are real onboarding blockers for a project explicitly courting community adapter contributions.

---

## README Accuracy Check (feature-by-feature)

README path: `/Users/baladita/Documents/DevBox/agent-manager/README.md` (788 lines).

| Feature claim (README) | Code reality | Verdict |
|---|---|---|
| 13 adapters with bidirectional sync | `src/adapters/` has 13 dirs (claude-code, codex-cli, cursor, copilot, windsurf, forgecode, kilo-code, kiro, gemini-cli, cline, roo-code, amazon-q, continue) + community/ + shared/ | **OK** |
| 31 CLI commands | `src/commands/` has 32 `.ts` files. `init.ts` + `init-project.ts` collapse into one `am init --project` (see README line 521). Effective count: 31. | **OK** (cosmetic mismatch; number is defensible) |
| 33 MCP tools across 6 groups | `src/mcp/server.ts` registers 33 `am_*` tools. 6 groups (core/registry/a2a/wiki/session/acp). | **OK** |
| 1864 tests pass | CHANGELOG says 1916/152 files/5655 assertions; README project stats table says 1,859/151/5,512; README badge + CONTRIBUTING both say 1864. | **DRIFT** — three numbers disagree. |
| `am marketplace add/list/search/install/remove/update` | `src/commands/marketplace.ts` + `src/marketplace/` (client, installer, scanner, types) | **OK** |
| `am flow run/list/status` | `src/commands/flow.ts` + `src/protocols/acp/flows.ts` | **OK** |
| `am run <agent>` ACP orchestration | `src/commands/run.ts` + `src/protocols/acp/` (client, registry, types, flows) | **OK** |
| `am adapter install/remove/update/verify/list` | `src/commands/adapter.ts` + `src/adapters/community/` (loader, proxy, types) | **OK** — shipped, but ADR-0027 still says "proposed" |
| `am wiki` 13 subcommands | `src/commands/wiki.ts` + `src/wiki/` | **OK** |
| `am agents` A2A (list/add/remove/ping/delegate) | `src/commands/agents.ts` + `src/protocols/a2a/` | **OK** |
| A2A Agent Card at `/.well-known/agent.json` | `src/protocols/a2a/server.ts` + `generate-card.ts` | **OK** |
| A2A-ACP Bridge | `src/protocols/bridge.ts` exists (named in CHANGELOG 0.4.0) | **OK** |
| Unified Agent Registry | `src/core/agent-registry.ts` exists (ADR-0030 named) | **OK** — shipped, but ADR-0030 still says "proposed" |
| `am import --auto/--report/--marketplace` | `src/commands/import.ts` + `src/core/merge.ts` | **OK** — ADR-0028 still says "proposed" |
| `am secret init/set/get/scan` + BetterLeaks | `src/commands/secret.ts` + `src/core/secret-detection.ts` + `betterleaks.ts` | **OK** |
| Encryption (AES-256-GCM, `enc:v1:nonce:ciphertext`) | `src/core/secrets.ts` | **OK** |
| `am mcp-serve` | `src/commands/mcp-serve.ts` + `src/mcp/server.ts` | **OK** |
| `am tui` (Silvery/React) | `src/commands/tui.ts` + `src/tui/` | **OK** |
| `am serve` local + CF Workers stateless | `src/commands/serve.ts` + `src/web/` + `wrangler.toml` | **OK** |
| `am completion bash\|zsh\|fish` | `src/commands/completion.ts` | **OK** |
| Architecture mermaid diagram (README line 678) | Present, named "CLI (31 commands)", "MCP Server (33 tools, 6 groups)", AgentReg, Bridge — matches current code | **OK** |

**Install story.** README advertises `brew tap Codeseys-Labs/am && brew install am`, a curl install script, npm, and source. `install.sh` (5.6KB) exists; `Formula/` directory exists; `npmignore` + `package.json` bin map exist. Not verified end-to-end in this pass but the plumbing is there.

**One subtle doc-vs-reality trap:** README line 761 lists "Tests: 1,859" in the Project Stats table while line 9 badge says 1864 and CHANGELOG says 1916. Pick one number.

---

## ADR Currency

ADR files live at `/Users/baladita/Documents/DevBox/agent-manager/ADRs/` (31 ADR files + README.md + template.md; 30 numbered 0001-0030).

| # | Title | Frontmatter status | Index status (ADRs/README.md) | Code shipped? | Match? |
|---|---|---|---|---|---|
| 0001 | Layered Core + Adapter Extensions | accepted | Accepted | Yes (src/core, src/adapters) | Yes |
| 0002 | Git-Backed Everything | accepted | Accepted | Yes (src/core/git.ts, platforms/) | Yes |
| 0003 | Hierarchical Config | accepted | Accepted | Yes (src/core/config.ts, 4-layer) | Yes |
| 0004 | TOML Config Format | accepted | Accepted | Yes (@iarna/toml + Zod) | Yes |
| 0005 | Bidirectional Adapters | accepted | Accepted | Yes (detect/import/export/diff on 13) | Yes |
| 0006 | Drift Detection | accepted | Accepted | Yes (`am status`) | Yes |
| 0007 | Two-Phase Zod Validation | accepted | Accepted | Yes (core strict, adapter passthrough) | Yes |
| 0008 | Profile-Based Subsets | accepted | Accepted | Yes (`am use`, profiles.*) | Yes |
| 0009 | agent-manager as MCP Server | accepted | Accepted | Yes (src/mcp/server.ts) | Yes |
| 0010 | BunTS Single Binary | accepted | Accepted | Yes (scripts/build.ts, 5 platforms) | Yes |
| 0011 | Built-In Adapters + Subprocess Escape Hatch | accepted | Accepted | Yes | Yes |
| 0012 | Application-Level Encryption | accepted | Accepted | Yes (src/core/secrets.ts) | Yes |
| 0013 | Git Platform Adapters | accepted | Accepted | Yes (github/gitlab/bare) | Yes |
| 0014 | Workspace-to-Profile Import | accepted | Accepted | Yes | Yes |
| 0015 | Stateless Web UI | accepted | Accepted | Yes (src/web/, wrangler.toml) | Yes |
| 0016 | Session Harvest | accepted | Accepted | Yes (src/core/session.ts) | Yes |
| 0017 | Multi-Protocol (MCP+A2A+ACP) | accepted | Accepted | Yes (src/protocols/) | Yes |
| 0018 | TUI Framework — Ink to Silvery | accepted | Accepted | Yes (src/tui/, Silvery dep) | Yes |
| 0019 | Security Hardening | accepted | Accepted | Yes (iteration 10-11 in CHANGELOG) | Yes |
| 0020 | Session Knowledge Synthesis | accepted | Accepted | Yes (src/wiki/) | Yes |
| 0021 | MCP Tool Grouping | accepted | Accepted | Yes (6 groups) | Yes |
| 0022 | Wiki Location Strategy | accepted | Accepted | Yes (dual location, symlinks) | Yes |
| 0023 | Tiered Secret Detection | accepted | Accepted | Yes (betterleaks.ts) | Yes |
| 0024 | MCP Registry Integration | accepted | Accepted | Yes (src/registry/, `am install`) | Yes |
| 0025 | Worker Multi-Backend Auth | accepted | Accepted | Yes (CF Worker) | Yes |
| **0026** | ACP Runtime via ACPX | **proposed** | Accepted | **Yes** (src/protocols/acp/, `am run`, `am flow`) | **DRIFT** |
| **0027** | Community Adapter Loading | **proposed** | Proposed | **Yes** (src/adapters/community/, `am adapter install`) | **DRIFT** |
| **0028** | Brownfield Import Merge | **proposed** | Proposed | **Yes** (src/core/merge.ts, `am import --auto/--report`) | **DRIFT** |
| **0029** | Command Grouping | accepted | **MISSING FROM INDEX** | Yes (src/help.ts, gh-CLI-style) | DRIFT (index) |
| **0030** | Unified Agent Registry | **proposed** | **MISSING FROM INDEX** | **Yes** (src/core/agent-registry.ts) | **DRIFT** |

**Five ADRs with drift.** The v1-readiness review (`docs/reviews/2026-04-16-v1-readiness/v1-readiness-analysis.md` line 347) already flagged this exact issue for 0027/0028 and asked whether they should be described as v1.1 roadmap items. The resolution shipped them but did not update the ADR frontmatter.

ADRs/README.md also contains internal contradiction: row for 0026 says "Accepted" while the ADR file frontmatter says "proposed". The index stops at 0028 and omits 0029 and 0030 entirely.

**Verification of ADR-0026/0027/0028/0029/0030 against code:**

- **ADR-0026 (ACPX):** Code present in `src/protocols/acp/{client,flows,registry,types}.ts` and `src/protocols/bridge.ts`. CLI: `am run`, `am run session list|cancel`, `am flow run|list|status`. Schema `[agents.*]` with `acp`/`a2a` subtables is live. Phase 3 (flows) and Phase 4 (bridge) from ADR both landed. Code matches decision.
- **ADR-0027 (Community Adapters):** Code present in `src/adapters/community/{loader,proxy,types}.ts`. JSON-RPC 2.0 types defined (`src/adapters/community/types.ts` lines 30-57). CLI: `am adapter install|remove|update|verify|list` in `src/commands/adapter.ts`. `adapters.toml` config live. SHA256 checksum verification added per iteration-10 security hardening (CHANGELOG). Code matches decision.
- **ADR-0028 (Brownfield Import Merge):** Code present in `src/core/merge.ts`. CLI flags `--auto`, `--report`, `--marketplace` in `src/commands/import.ts`. Code matches decision.
- **ADR-0029 (Command Grouping):** Code present in `src/help.ts`. README CLI Reference is already grouped (Config / Git / Registry / Wiki / A2A / ACP / Flows / Marketplace / Community Adapters / Tools / Interfaces). Code matches decision. **Missing from ADRs/README.md index.**
- **ADR-0030 (Unified Agent Registry):** Code present in `src/core/agent-registry.ts` (ADR explicitly names this file). Merges config > ACP built-in (16) > A2A roster. Priority ordering matches ADR. README Architecture diagram shows "Unified Agent Registry" box. Code matches decision. **Missing from ADRs/README.md index.**

---

## Missing Docs

| Missing | Severity | Why it matters |
|---|---|---|
| **Plugin/Community Adapter Author Guide** | **HIGH** | ADR-0027 is the explicit extensibility story. Authors need the JSON-RPC method list (`adapter/initialize`, `adapter/detect`, `adapter/import`, `adapter/export`, `adapter/diff`, `adapter/schema`), request/response schemas, error codes, `package.json` `am-adapter` manifest fields (`src/adapters/community/types.ts` lines 23-28), checksum requirements, and an example adapter. `docs/adapter-development-guide.md` covers only built-in (6-file-pattern) adapters — zero mentions of "community", "JSON-RPC", or "subprocess". |
| **Marketplace Author Guide** | MEDIUM | README advertises "community-maintained registries of skills, hooks, and MCP server bundles" (line 133). No doc explains the plugin manifest schema, scanner contract, or how to publish a marketplace. `src/marketplace/scanner.ts` has the rules in code only. |
| **`docs/reviews/` index** | MEDIUM | 10 dated folders, no `docs/reviews/README.md`. A new contributor looking for "has anyone looked at A2A auth before?" cannot tell what was analyzed in each iteration. Cheap win: table mapping date → scope → outcome. |
| **JSON error shape for `--json` mode** | MEDIUM | v1-readiness review flagged this (line 280). No doc of the error schema CLI users script against. |
| **Man pages** | LOW | v1-readiness flagged; non-blocker. `--help` is well-grouped per ADR-0029. |
| **`docs/plans/`** | LOW | CLAUDE.md prologue mentions `docs/plans/` but the directory does not exist (`docs/designs/` does). Either stale reference or rename. |

**What exists and is good:**
- `CHANGELOG.md` (215 lines) — meaningful 0.3.0 and 0.4.0 entries with ADR cross-references.
- `CONTRIBUTING.md` (251 lines) — setup, workflow, commit conventions, "How To..." playbook for adapters/commands/MCP tools/schema changes.
- `ROADMAP.md` (321 lines) — vision, principles, per-feature status table with ADR references.
- `CLAUDE.md` (367 lines) — project memory for Claude Code sessions, conventions, build commands.
- `AGENTS.md` (344 lines) — counterpart for other tools (CHANGELOG mentions wiki auto-injection into both).
- `docs/adapter-development-guide.md` (392 lines) — built-in adapter walkthrough, step-by-step, good.
- `docs/cli-lifecycle.md` (698 lines) — CLI command lifecycle reference.
- `docs/system-architecture.md` (946 lines) — architecture reference.
- `docs/2026-04-07-agent-manager-design-spec.md` — original design spec preserved.

---

## Stale References

Grep results across `docs/` and root-level markdown:

- **`docs/reviews/2026-04-15-cli-ux-refinement/cli-ux-deep-analysis.md:948`**: `pull (TODO: --no-apply)`. Ephemeral review note, not a user-facing doc. Low priority.
- **`docs/reviews/2026-04-16-iter12-final/integration-check.md:5,19,83`**: `Version: 0.3.0 (package.json) / 0.1.0 (CLI output)`. Snapshot from iter12. `package.json` now says 0.4.0 and `src/commands/version.ts` exists. Review is historical — not stale so much as dated.
- **Multiple legitimate "1.0" mentions** (all in ADRs and reviews, all in context — "A2A v1.0 spec", "ACP pre-1.0", "v1.0 readiness analysis"). No spurious "agent-manager 1.0" claims. User's explicit veto is respected.
- **`research/09-adapter-architecture-patterns.md:210`**: `version: "1.0.0"` in a code example. Intentional example, not a claim.
- **`ADRs/README.md`**: Stops at ADR-0028. Missing 0029 and 0030 rows. Lists 0026 as Accepted but 0026 frontmatter says proposed.
- **`CLAUDE.md` references `docs/plans/`** which does not exist (verified via `ls`). `docs/designs/` exists. Likely a rename that did not propagate to CLAUDE.md.
- **Test count:** three different numbers (1864 README badge / 1859 README Project Stats table / 1916 CHANGELOG 0.4.0). Pick one and propagate.

No `FIXME` or `XXX` hits in `docs/`.

---

## Doc-Code Mismatches

Direct verification of ADR claims → shipped behavior:

| ADR claim | Command in README | Code file | Match? |
|---|---|---|---|
| ADR-0029: `am` help is grouped | README CLI Reference has explicit groups (Config / Git / Registry / Wiki / A2A / ACP / Flows / Marketplace / Community Adapters / Tools / Interfaces / Global Flags) | `src/help.ts` | Yes |
| ADR-0027: `am adapter install <name>` | README line 376 | `src/commands/adapter.ts` line 199: `commitAll(..., \`adapter install: ${name}\`)` | Yes |
| ADR-0027: `am adapter remove <name>` | README line 377 | `src/commands/adapter.ts` line 251 | Yes |
| ADR-0030: Registry priority config > ACP > A2A | README line 309 | `src/core/agent-registry.ts` | Yes (not re-read in full, file exists with the correct name) |
| ADR-0028: `am import --auto`, `--report`, `--marketplace` | README lines 152-155 | `src/commands/import.ts` + `src/core/merge.ts` | Yes |
| ADR-0026: `am run --session <name>` | README line 344 | `src/commands/run.ts` | Yes |
| ADR-0026: `am flow run` | README line 361 | `src/commands/flow.ts` + `src/protocols/acp/flows.ts` | Yes |

No silent reversals detected. All checked claims match.

---

## deep-work-loop Skill Assessment

File: `/Users/baladita/.claude/skills/deep-work-loop/SKILL.md` (295 lines).

The skill is **general-purpose** — no agent-manager-specific hard-coding. Phases (Investigate → Deep-Dive → Research → Plan → Act → Review → Repeat), team sizing (max 5-10, hard cap 10), anti-patterns, escape hatches. Output conventions reference `docs/reviews/{topic}-review.md`, `docs/designs/{feature}.md`, `ADRs/NNNN-{title}.md`, `docs/session-exports/YYYY-MM-DD-{topic}.md` — all paths that happen to exist in agent-manager (which is evidence the skill was *written from* this project but generalized correctly).

**What's NOT baked in:**
- No "15 iterations" post-mortem, retros, or lessons-learned section.
- No concrete agent-manager examples (the worked example uses a fictional auth system, not PAP-like real project work).
- No reference to ADRs 0026-0030 as iteration outputs.
- No heuristics learned from the 10 review folders — e.g., "for CLI/UX reviews use 3-5 agents; for security hardening use 2-3 adversarial agents; for test audits use 5 agents split by subsystem".
- No team-sizing rules calibrated from actual runs. `docs/reviews/2026-04-15-mcp-a2a-cli-review/` has 5 review docs; `docs/reviews/2026-04-16-test-audit/` has 5 review docs — these are good calibration anchors the skill could reference.

**Reusability:** Excellent. The skill drops into any project with `ADRs/` + `docs/reviews/` + `docs/designs/` structure.

**Improvement:** Add a "Learnings from 15 iterations" appendix with 5-10 concrete heuristics. Optional: link to a specific review folder as the worked-example template.

---

## Onboarding Journey

**Scenario:** New contributor clones repo, wants to ship a Zed adapter within 15 minutes.

| Step | Time | Blocker? |
|---|---|---|
| 1. `git clone && bun install && bun test` | ~3 min | None — CONTRIBUTING.md covers this |
| 2. Read README to understand scope | ~5 min | None |
| 3. Decide built-in vs community adapter | ~2 min | **Soft blocker** — README line 370 says "community adapters" is a real thing but links to ADR-0027 which is still "proposed". Unclear whether to add to src/adapters/zed/ (built-in PR) or publish as am-adapter-zed (community package). |
| 4. If built-in: read `docs/adapter-development-guide.md` | ~10 min | None — 392 lines, step-by-step |
| 5. If community: read... | ??? | **HARD BLOCKER** — no guide exists. Author must read `src/adapters/community/{loader,proxy,types}.ts` (~100 lines total) and reverse-engineer the JSON-RPC method names, the `package.json` `am-adapter` manifest shape, and the `adapter/initialize` handshake with protocolVersion. |
| 6. `am adapter install ./my-adapter` | ~1 min | None (install.sh + `am adapter` CLI are both real) |

**Verdict:** For built-in adapter authors — **under 15 minutes is realistic**. For community adapter authors — **blocked** without source-code archaeology. Given ADR-0027 is the explicit community extensibility pillar, this is the #1 onboarding fix.

Secondary friction: new contributor landing in `docs/reviews/` sees 10 dated folders with ambiguous names ("iter10-review", "iter12-final", "v1-readiness") and no index. They cannot tell whether their concern has been analyzed. Cheap win.

---

## Recommendations

Ordered by effort:cost ratio.

### P0 — Correct, quick

1. **Flip ADR-0026, 0027, 0028, 0030 frontmatter from `proposed` to `accepted`**. Evidence is overwhelming: code shipped, CHANGELOG 0.4.0 entries exist, code files named in ADRs are present. This is a pure documentation correction.
2. **Add ADR-0029 and ADR-0030 rows to `ADRs/README.md`**. Also fix 0026 row to match its frontmatter (will become "Accepted" after step 1, so the index is already correct once aligned).
3. **Pick one test count.** Either 1916 (CHANGELOG, most recent) or 1864 (README badge + CONTRIBUTING) — propagate across README line 9 badge, README line 710, README line 759 project-stats table, CONTRIBUTING.md line 27 and 130.
4. **Create `docs/reviews/README.md`** — a simple table: `date | scope | key findings | resolved in`. Even a 40-line index would unblock future contributors.

### P1 — New content

5. **Write `docs/community-adapter-guide.md`** — the missing plugin-author guide. Contents:
   - Manifest (`package.json#am-adapter`): name, displayName, minAmVersion, capabilities.
   - Binary contract: stdio JSON-RPC 2.0, one request per line.
   - Method list: `adapter/initialize` (with protocolVersion + amVersion params), `adapter/detect`, `adapter/import`, `adapter/export`, `adapter/diff`, `adapter/schema`. Spec request/response shapes.
   - Example minimal adapter (~50 lines) that responds to `adapter/initialize` and `adapter/detect`.
   - `am adapter install ./local-path` for local dev, `am adapter install npm:am-adapter-zed` for npm distribution.
   - Checksum policy (SHA256 verification before spawn, per iter-10 security hardening).
   - Error code conventions.
   Derive all specifics from `src/adapters/community/{loader,proxy,types}.ts` — ground truth.
6. **Write `docs/marketplace-author-guide.md`** — plugin repo structure, manifest fields, scanner contract.
7. **Update `CLAUDE.md`** — fix `docs/plans/` reference to `docs/designs/`.
8. **Add JSON error shape section to README** — schema for `--json` mode error responses (v1-readiness review flagged this).

### P2 — Polish

9. **Retitle `docs/reviews/2026-04-16-iter12-final/integration-check.md`** or annotate at the top that it is a 0.3.0-era snapshot to avoid confusion with 0.4.0 reality.
10. **Add "Learnings from 15 iterations" appendix to deep-work-loop skill** with concrete heuristics calibrated to the review folders in agent-manager.
11. **Consider consolidating `docs/reviews/2026-04-16-*` folders** into one `2026-04-16-pre-v1-push/` with subdirectories, since they are all from the same day's v1-readiness push. Or keep as-is but explain in the new reviews README.

### Not recommended

- Do not auto-generate API docs from TypeScript sources. The existing hand-written docs are higher signal and the CONTRIBUTING "How To..." section is the right abstraction level.
- Do not add a 1.0 release announcement. User has explicitly vetoed 1.0 claims; current reviews correctly frame 0.4.0 as "ready for v1.0 with 8 blockers".

---

## Appendix: File citations

- `/Users/baladita/Documents/DevBox/agent-manager/README.md` (788 lines)
- `/Users/baladita/Documents/DevBox/agent-manager/CHANGELOG.md` (215 lines, 0.4.0 dated 2026-04-16)
- `/Users/baladita/Documents/DevBox/agent-manager/CONTRIBUTING.md` (251 lines)
- `/Users/baladita/Documents/DevBox/agent-manager/ROADMAP.md` (321 lines)
- `/Users/baladita/Documents/DevBox/agent-manager/CLAUDE.md` (367 lines)
- `/Users/baladita/Documents/DevBox/agent-manager/AGENTS.md` (344 lines)
- `/Users/baladita/Documents/DevBox/agent-manager/ADRs/` — 30 ADRs + README + template
- `/Users/baladita/Documents/DevBox/agent-manager/ADRs/README.md` — ADR index (stops at 0028)
- `/Users/baladita/Documents/DevBox/agent-manager/ADRs/0026-acpx-acp-runtime-integration.md` (proposed, code shipped)
- `/Users/baladita/Documents/DevBox/agent-manager/ADRs/0027-community-adapter-loading.md` (proposed, code shipped)
- `/Users/baladita/Documents/DevBox/agent-manager/ADRs/0028-brownfield-import-merge.md` (proposed, code shipped)
- `/Users/baladita/Documents/DevBox/agent-manager/ADRs/0029-command-grouping.md` (accepted, missing from index)
- `/Users/baladita/Documents/DevBox/agent-manager/ADRs/0030-unified-agent-registry.md` (proposed, missing from index, code shipped)
- `/Users/baladita/Documents/DevBox/agent-manager/docs/adapter-development-guide.md` (392 lines, built-in adapters only)
- `/Users/baladita/Documents/DevBox/agent-manager/docs/cli-lifecycle.md` (698 lines)
- `/Users/baladita/Documents/DevBox/agent-manager/docs/system-architecture.md` (946 lines)
- `/Users/baladita/Documents/DevBox/agent-manager/docs/reviews/` — 10 dated folders, no index
- `/Users/baladita/Documents/DevBox/agent-manager/docs/reviews/2026-04-16-v1-readiness/v1-readiness-analysis.md` — already flagged ADR-0027/0028 drift
- `/Users/baladita/Documents/DevBox/agent-manager/src/adapters/community/types.ts` — JSON-RPC protocol contract, undocumented outside source
- `/Users/baladita/Documents/DevBox/agent-manager/src/adapters/community/{loader,proxy}.ts`
- `/Users/baladita/Documents/DevBox/agent-manager/src/core/agent-registry.ts` — ADR-0030 implementation
- `/Users/baladita/Documents/DevBox/agent-manager/src/core/merge.ts` — ADR-0028 implementation
- `/Users/baladita/Documents/DevBox/agent-manager/src/protocols/acp/` — ADR-0026 implementation
- `/Users/baladita/Documents/DevBox/agent-manager/src/protocols/bridge.ts` — A2A-ACP bridge (ADR-0026 Phase 4)
- `/Users/baladita/Documents/DevBox/agent-manager/src/commands/adapter.ts` — `am adapter install/remove/...`
- `/Users/baladita/Documents/DevBox/agent-manager/src/help.ts` — ADR-0029 grouped help
- `/Users/baladita/.claude/skills/deep-work-loop/SKILL.md` (295 lines, generic, no agent-manager specifics baked in)
