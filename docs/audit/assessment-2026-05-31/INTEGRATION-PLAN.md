# Parallel Execution & Rebase/Integration Plan

How the backlog waves run in parallel (branches/worktrees) without colliding, and
the deterministic rule for who rebases on what.

## Branch model

- `main` — protected trunk. Only fast-forward / squash-merge from `wave/*` via PR.
- `wave/N-<slug>` — one branch per wave, based on `main` at the time it starts.
- Stacked PRs: each wave PR targets `main` (not the previous wave) **when file-sets
  are disjoint** (the common case here). Only stack (base = previous wave) when a
  wave genuinely depends on another wave's new code.

## Conflict-avoidance by file ownership (the real mechanism)

Branches are made conflict-free *by construction* — each wave owns a disjoint set
of files. Conflicts only arise on shared "hub" files, which are serialized.

| Wave | Owns (exclusive write-set) | Touches hub files? |
|------|---------------------------|--------------------|
| **0 docs-honesty** | `README.md`, `ROADMAP.md`, `CHANGELOG.md`, `scripts/stats.ts`, `.coderabbit.yaml` | README/ROADMAP = OWNED here |
| **1 dx-core** | `src/lib/errors.ts`, `src/core/config.ts` (ZodError), `src/help.ts`, `src/mcp/server.ts` (alias target), `docs/adapter-development-guide.md`, `ADRs/004*.md` (re-status), `test/...` | `src/cli.ts` (P1-G adds nothing new), `src/help.ts` OWNED |
| **2 safety** | `src/core/secrets*.ts`, `src/commands/secrets*.ts`, `src/commands/pair*.ts`, `src/core/betterleaks.ts`, `ADRs/0042/0047/0050/0051` status | none |
| **3 wizard+apply** | NEW `src/commands/setup.ts`, `src/commands/apply.ts`, `src/core/controller.ts` (per-target), `test/commands/setup.test.ts` | `src/cli.ts` (register `setup`) |
| **4 dist-ci** | `install.sh`, `.github/workflows/*`, `Formula/am.rb`, `package.json`/`.npmignore`, `bin/*` | none |
| **5 refactor** | `src/core/resolved.ts` (new), `src/adapters/**` (shared utils), `src/core/instructions.ts` | none |

### Hub-file rule (who rebases on what)

`src/cli.ts` is the only file >1 wave edits (Wave 3 registers `setup`; Wave 1's
P1-G touches help.ts not cli.ts). Resolution order, lowest-numbered wave merges first:

1. **Merge order = wave order.** Wave 0 → 1 → 2 → 3 → 4 → 5. Lower wave merges to
   `main` first.
2. **After each merge to `main`, every still-open wave branch rebases onto `main`.**
   Because write-sets are disjoint, these rebases are almost always clean
   (no textual overlap). The rebase is a *sync*, not a conflict resolution.
3. **`src/cli.ts` exception:** only Wave 3 adds a subcommand line. No other wave
   edits cli.ts, so there is no cli.ts conflict. If a future wave must edit cli.ts,
   it rebases AFTER Wave 3 merges and appends its line.
4. **README/ROADMAP exception:** owned entirely by Wave 0. Later waves that need a
   README change (e.g. Wave 4 dist docs) do it as a *follow-up commit on main after
   Wave 0 merges*, never in parallel. Avoids the multi-writer drift the audit flagged.

## Execution rule for parallel agents

- Each execution agent runs in an **isolated git worktree** (`isolation: "worktree"`)
  so parallel file writes never touch a shared working tree.
- An agent may ONLY write files in its wave's owned set (above). If it discovers it
  needs a hub file, it stops and reports — the orchestrator sequences that edit.
- Each agent must leave its worktree green: `bun test <relevant>`, `bun run lint`,
  `bun x tsc --noEmit` (first-party clean).

## Review team (concurrent)

A separate review workflow runs in parallel with execution, reviewing each wave's
diff adversarially (not trusting the executor's reasoning) and filing findings back
into Seeds as new issues. Reconcile after each wave; re-prioritize; launch next wave.

## Dependency notes

- Wave 3 (wizard) consumes Wave 1 (ZodError UX, so the wizard never shows a raw
  Zod dump) and Wave 2 (must default to AES, never offer age) — so Wave 3 starts
  after 1+2 land, or rebases on them. Waves 0/1/2/4/5 are mutually independent.
- Wave 5 (refactor) is last because it moves types broadly; running it early would
  force every other wave to rebase across a large move.
