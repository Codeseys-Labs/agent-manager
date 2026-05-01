---
status: draft
date: 2026-05-01
relates-to: ADR-0005, ADR-0006, ADR-0031, ROADMAP.md:225
research: docs/research/2026-05-01-drift-detection-patterns.md
new-adr-required: ADR-0036 (Drift Detection Architecture)
---

# Full Drift Detection — Skills, Agents, Instructions Across All 13 Adapters

## Goal

Extend `am status` drift detection from servers-only to servers + instructions
+ skills + agents across all 13 IDE adapters, using a shared `DiffStrategy`
infrastructure that eliminates per-adapter bespoke comparison logic and adds
a three-way last-apply snapshot to distinguish "user edited config.toml"
from "user edited the IDE."

## Acceptance Criteria

- `am status` reports instruction drift for all 13 adapters that declare the
  `"instructions"` capability.
- `am status` reports skill drift for all adapters that declare `"skills"`
  (claude-code, kiro, windsurf, forgecode, kilo-code).
- `am status` reports agent drift for all adapters that declare `"agents"`
  (claude-code, codex-cli, cursor, kiro, forgecode, kilo-code).
- `am status --json` output uses stable, namespaced `DiffChange.details`
  field names (e.g., `server.command`, `instruction.content`, `skill.hash`,
  `agent.prompt`).
- **Apply-then-status is clean.** For every adapter, `am apply` followed
  immediately by `am status` reports `status: "in-sync"` with zero changes,
  enforced by a hermetic integration test.
- No false positives from IDE JSON reformatting — semantic normalization
  (sort keys, empty-array/empty-map equivalence) across all JSON-backed
  adapters.
- Three-way classification (`config-ahead`, `ide-ahead`, `conflict`, `in-sync`)
  with a suggested remediation line.
- Capability-contract test in `test/adapters/contract.test.ts` instantiates
  every adapter against an all-entities fixture; each declared capability must
  produce at least one `DiffChange` when reality diverges.

## Phased Rollout

### Phase 1 — Infrastructure (shared strategies + last-apply snapshot)

Purely additive; no behaviour change until Phase 2 binds adapters.

- **1.1** `DiffStrategy<Entity, Native>` interface in
  `src/adapters/shared/diff-utils.ts`: `load`, `enumerate`, `compareOne`.
- **1.2** `Suppressor` type + `defaultSuppressors` (args empty-array, env
  empty-map, `${VAR}` interpolation) in `src/adapters/shared/utils.ts`.
- **1.3** `jsonMapStrategy` in `src/adapters/shared/strategies/json-map.ts`
  (wraps existing `readJsonFile` + `compareServerFields`).
- **1.4** `markerBlockStrategy` (wraps existing `compareInstructions`).
- **1.5** `perFileInstructionStrategy` — two-phase: YAML frontmatter semantic
  compare (`description`, `globs`, `alwaysApply`/`trigger`/`inclusion`) +
  body textual trim. Replaces fragile `nativeContent.includes(instr.content.trim())`
  checks currently in Cursor / Windsurf / Copilot / Kiro / Cline / Roo Code.
- **1.6** `skillDirStrategy` — directory of files, SHA-256 per file,
  compared against expected skill content from `ResolvedSkill`.
- **1.7** `agentFileStrategy` — per-agent markdown or JSON files, parses
  frontmatter or JSON fields, semantic-compares against `ResolvedAgent`.
- **1.8** `readYamlMap` helper for Continue's YAML-backed server list.
- **1.9** Document the `DiffChange.details` field namespacing convention
  (`server.*`, `instruction.*`, `skill.*`, `agent.*`). Runtime type unchanged
  (`{ field: string; ... }[]`) to avoid breaking consumers.
- **1.10** Last-apply snapshot write in `src/commands/apply.ts`: serialize
  each successful adapter's DiffResult to `.agent-manager/state/last-apply/<adapter>.json`
  (gitignored).
- **1.11** Extend `am status` (`src/commands/status.ts`) to read the snapshot
  and emit three-way classification + remediation.
- **1.12** Snapshot storage module `src/core/last-apply.ts`.
- **1.13** Unit tests for each strategy in `test/adapters/strategies/`.
- **1.14** Round-trip test for `last-apply.ts`.

### Phase 2 — Instruction Drift (all 13 adapters)

Replaces fragile substring checks with structured strategies:

- claude-code: migrate existing `compareInstructions` call to `markerBlockStrategy` binding.
- codex-cli / gemini-cli / forgecode / kilo-code: bind `markerBlockStrategy` to AGENTS.md / GEMINI.md.
- cursor: `perFileInstructionStrategy` against `.cursor/rules/*.mdc` with YAML frontmatter.
- windsurf: hybrid — `perFileInstructionStrategy` for `.windsurf/rules/*.md` + `markerBlockStrategy` for AGENTS.md.
- copilot: `markerBlockStrategy` for `.github/copilot-instructions.md` (always-scope) + `perFileInstructionStrategy` for `.github/instructions/*.instructions.md` (glob-scope).
- kiro: hybrid — frontmatter semantic + am-marker body per steering file.
- cline / roo-code / amazon-q / continue: `perFileInstructionStrategy` body-only mode.
- Capability-contract test + idempotency for all 13.

### Phase 3 — Skill Drift (5 capable adapters)

Skill-capable: claude-code, kiro, windsurf, forgecode, kilo-code. Bind
`skillDirStrategy` to each adapter's skill directory path (paths confirmed
in `export.ts` of each adapter). SHA-256 per file, cross-adapter skill scope
intentionally non-aggregated (each adapter's `diff()` is authoritative for
its own native storage).

### Phase 4 — Agent Drift (6 capable adapters)

Agent-capable: claude-code, codex-cli, cursor, kiro, forgecode, kilo-code.
Bind `agentFileStrategy` per adapter. Before binding for forgecode/kilo-code,
**verify the export path** in each `export.ts` — if agent export is
unimplemented, emit an `{ status: "unmanaged" }` stub and file a follow-up
issue rather than shipping a broken diff.

## Per-Adapter Audit Table

| Adapter | Capabilities | Instruction Storage | Strategy | Skill | Agent | Gaps |
|---|---|---|---|---|---|---|
| claude-code | mcp, instructions, skills, agents, hooks, … | CLAUDE.md (marker block) | markerBlock | `.claude/skills/<n>/` | `.claude/agents/<n>.md` | skill: missing; agent: missing |
| codex-cli | mcp, instructions, agents | AGENTS.md | markerBlock | — | verify export.ts | instruction: missing; agent: missing |
| cursor | mcp, instructions, agents, marketplace | `.cursor/rules/*.mdc` (YAML+body) | perFile | — | `.cursor/agents/*.md` | instruction: fragile; agent: missing |
| copilot | mcp, instructions, marketplace | `.github/copilot-instructions.md` + `.github/instructions/*.instructions.md` | markerBlock + perFile | — | — | instruction: missing |
| kiro | mcp, instructions, skills, agents, marketplace | `.kiro/steering/*.md` hybrid | perFile + markerBlock | `.kiro/skills/<n>/` | `.kiro/agents/*.json` | all three missing |
| windsurf | mcp, instructions, skills, marketplace | `.windsurf/rules/*.md` + AGENTS.md | perFile + markerBlock | `.windsurf/skills/<n>/SKILL.md` | — | instruction: missing; skill: missing |
| gemini-cli | mcp, instructions | GEMINI.md | markerBlock | — | — | instruction: missing |
| cline | mcp, instructions | `.clinerules/*.md` plain | perFile body-only | — | — | instruction: missing |
| roo-code | mcp, instructions, modes | `.roo/rules/*.md` plain | perFile body-only | — | — | instruction: missing |
| amazon-q | mcp, instructions | `.amazonq/rules/*.md` plain | perFile body-only | — | — | instruction: missing |
| continue | mcp, instructions | `.continue/rules/*.md` plain | perFile body-only | — | — | instruction: missing |
| forgecode | mcp, instructions, skills, agents, models | AGENTS.md | markerBlock | `.forge/skills/<n>/SKILL.md` | verify | instruction, skill, agent: missing |
| kilo-code | mcp, instructions, skills, agents, modes | AGENTS.md | markerBlock | verify | verify | skill, agent: missing |

## New ADR Required — ADR-0036: Drift Detection Architecture

Note: ADR-0034 (shim scope) and ADR-0035 (wiki sync correctness, from M5 plan)
are already allocated. This plan's ADR is **ADR-0036**.

ADR-0006 establishes the policy (detect drift, don't overwrite).
ADR-0036 establishes the architecture:
- `DiffStrategy` interface + 5 implementations
- Semantic-vs-textual decision rule
- Suppressor pattern (Terraform DiffSuppressFunc analogue)
- Last-apply snapshot model
- Three-way classification
- Idempotency oracle as first-class test contract
- Capability-contract test requirement

## Rollback Plan

All additive or in-place replacements within `diff.ts` files. No schema
changes, no `export.ts` changes, no git-backed storage changes. Revert
per-adapter `diff.ts` for any regression; the shared strategy files can
remain dead code until next attempt. Last-apply snapshots are gitignored
and failure-tolerant (write failures log as warnings, fall back to old
two-way diff).

## Known Risks

1. **Kiro hybrid frontmatter + am-marker body** — emit separate `DiffChange`
   entries for each concern.
2. **Windsurf dual instruction surfaces** — diff independently per surface,
   don't aggregate.
3. **Cline/Roo Code globalStorage-vs-project split** — instruction diff
   conditioned on `options.projectPath`.
4. **Continue YAML+JSON dual format** — idempotency test uses YAML-only
   fixture; document dual-format as known limitation in ADR-0036.
5. **ForgeCode/Kilo agent paths unconfirmed** — verify in export.ts before
   binding, or stub as `unmanaged`.
6. **Amazon Q instruction rules project-scoped** — drift only surfaced
   when run inside a project.
7. **Large skill directories (SHA-256 perf)** — limit to text globs
   (`*.md`, `*.txt`, `*.ts`, `*.py`, `*.sh`); add `--no-skills` flag.

## Files to Create

```
src/adapters/shared/strategies/
  json-map.ts, marker-block.ts, per-file-instruction.ts,
  skill-dir.ts, agent-file.ts
src/core/last-apply.ts
ADRs/0036-drift-detection-architecture.md
test/adapters/strategies/*.test.ts   (5 files)
test/adapters/contract.test.ts
test/integration/idempotency.test.ts
```

## Files to Modify

```
src/adapters/shared/diff-utils.ts   (add DiffStrategy + Suppressor)
src/adapters/shared/utils.ts        (add defaultSuppressors, readYamlMap)
src/commands/apply.ts               (write last-apply snapshot)
src/commands/status.ts              (three-way classification + remediation)

All 13 per-adapter diff.ts files (varying extent)
```

## Estimated Effort

~8 developer-days total:
- Phase 1: 2 days
- Phase 2: 3 days
- Phase 3: 1.5 days
- Phase 4: 1.5 days
- ADR-0036 written before Phase 1 ships.

Each phase independently releasable.
