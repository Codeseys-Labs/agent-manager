# Design: Core/Adapter refactor (P2-A/B/C/D) — the final wave

The last execution wave. Broad-touch, so it runs AFTER all other waves merge
(per INTEGRATION-PLAN.md: a large type/util move would force every open branch
to rebase). Depends on the security wave (`wave/5-security`) landing first
because both touch `src/adapters/*/export.ts`.

## P2-A — break the core↔adapters type cycle

**Problem (verified):** `src/core/config.ts:12` imports `ResolvedConfig` /
`Resolved{Server,Instruction,Skill,Agent}` from `../adapters/types`, but those
types are *produced* by core (`buildResolvedConfig` is the only producer) and
merely *consumed* by adapters. `src/adapters/types.ts:1` also imports
`SessionReader` from `../core/session`. → a `type`-only `core ↔ adapters` cycle.

**Fix:** create `src/core/resolved.ts` holding `ResolvedConfig` + the `Resolved*`
family. Have `src/adapters/types.ts` import them FROM `../core/resolved`. Net
dependency becomes strictly `adapters → core`. Mechanical: ~6 import-path edits
across core (config, controller, instructions, merge, agent-detection) + the
adapters barrel. No behavior change; existing tests must stay green.

## P2-B — wire or delete the dead shared instruction generators

**Problem (verified):** `src/core/instructions.ts` exports `generateCursorMdc`
(:213), `generateWindsurfRule` (:258), `generateCopilotInstruction` (:276),
`generateKiroSteering` (:307) — called by NOTHING in `src/` (only tests). Each
adapter reimplements the same logic inline in its `export.ts`.

**Fix (prefer wire-up):** point cursor/windsurf/copilot/kiro `export.ts` at the
shared generators; delete the inline duplicates. If a generator's output differs
subtly from an adapter's current output, make the shared one a superset and
snapshot-test the result so the adapter's emitted files are byte-identical
pre/post. If wiring proves risky for v1, the fallback is to DELETE the dead
exports + their tests (don't ship tested-but-unreachable code).

## P2-C — shared export utilities

**Problem (verified):** all 13 adapters carry their own `generateMcp{Json,Config,
Settings}` and the identical `if (!dryRun) { for (file) { mkdirSync;
atomicWriteFileSync; written=true } catch { warnings.push } }` loop.

**Fix:** add `src/adapters/shared/export-utils.ts` with:
- `buildMcpServersJson(servers, existingPath, opts)` — read-merge-partition
  (stdio vs url), preserving adapter-specific extras.
- `writeExportFiles(files, { dryRun })` — the shared write loop with the
  warning-on-failure semantics.
Migrate adapters one at a time, keeping each adapter's roundtrip test green.
Removes ~30–50 duplicated lines per adapter; makes adapter #14 a half-page.

## P2-D — finish (or scope down) instruction-drift diff

**Problem (verified):** `compareInstructions` (shared/diff-utils.ts) is imported
by only 3 of 13 adapters; the other 10 only diff servers, so `am apply --diff`
falsely reports "in-sync" after a hand-edited CLAUDE.md/GEMINI.md, undermining
the drift gate (controller.ts:277-308).

**Fix (pick one, document it):**
- (a) Implement instruction drift for the adapters that export instructions
  (all 13 do), reusing `compareInstructions`; OR
- (b) For v1, downgrade the drift-gate promise in docs + surface a clear
  "instruction drift not detected for <tool>" note, and track full coverage as
  v1.x. Also resolve the related discovery finding: the `DiffChange` union
  advertises `skill`/`agent` entities NO adapter emits — narrow the union or
  implement them.

## Sequencing & ownership

- Run as `wave/6-refactor` AFTER `wave/5-security` merges (shared export.ts).
- Owned: `src/core/resolved.ts` (new), `src/core/{config,controller,instructions,
  merge,agent-detection}.ts` (import paths), `src/adapters/**` (export dedup +
  shared utils), `src/adapters/shared/export-utils.ts` (new), tests.
- Acceptance: full suite green; every adapter roundtrip test byte-identical;
  `tsc` first-party clean; the `core ↔ adapters` type cycle is gone
  (`grep "adapters/types" src/core` returns only behavioral imports, no `Resolved*`).
