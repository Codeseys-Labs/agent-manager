# ADR-0044 Wiki Two-Tier Implementation Plan

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task. Each task gets a fresh subagent with this plan slice + ADR-0044 reference + test-driven-development discipline.

**Goal:** Implement ADR-0044 (Wiki two-tier copy materialisation, amends ADR-0022). Add 4 new commands (`migrate`, `publish`, `pull` and refactored `init`), 2 storage-layer functions (`materialiseProject`, `pushToGlobal`), an `AGENTS.md` template, and a default `.gitignore` pattern. All schema-additive. No breaking changes to existing wiki commands.

**Architecture:**
- Storage layer (`src/wiki/storage.ts`) gains `materialiseProject()` and `pushToGlobal()`. Existing symlink helpers stay for backward compatibility.
- Commands (`src/commands/wiki.ts`) gain `migrateSubcommand`, `publishSubcommand`, `pullSubcommand`. Existing `init` is modified to write `.am-wiki/` instead of `.agent-manager/wiki/`.
- A new `src/wiki/agents-md-template.ts` exports a hardcoded version-pinned template.
- TDD throughout: failing test first, minimal impl, run, commit.

**Tech stack:** TypeScript, Bun, citty (commands), Zod (schema), `@iarna/toml` (parsing), `node:fs/promises`. Test runner: `bun:test`.

**Existing landscape (read before starting):**
- `src/wiki/storage.ts` — 780 lines. Wiki entry CRUD, frontmatter parsing, search index. Look for symlink-related code.
- `src/wiki/sync.ts` — 364 lines. Existing sync mechanics. May or may not need changes per task 6.
- `src/commands/wiki.ts` — 1361 lines. All wiki subcommands in one file. New subcommands go here.
- `ADRs/0022-wiki-location-strategy.md` — the symlink design being amended (status: superseded-in-part-by-ADR-0044).
- `ADRs/0044-wiki-two-tier-copy-materialisation.md` — the target design.

**Open implementation decisions** (resolve in tasks, not in advance):
- New paths: `.agent-manager/wiki/` → `.am-wiki/`. Define a `WIKI_PROJECT_DIRNAME = ".am-wiki"` constant in `src/wiki/storage.ts` (or wherever the existing project-dir constant lives).
- `mirror_strategy` settings field: per ADR-0044 §2 maintainer left this as "MAY add for compat hatch" — DO NOT add unless task 7 review surfaces a real need.

---

## Task 1: Add WIKI_PROJECT_DIRNAME constant + migrate detection helper

**Objective:** Establish the new directory name as a single source of truth and add a helper that identifies whether a project is on the legacy `.agent-manager/wiki/` layout.

**Files:**
- Modify: `src/wiki/storage.ts` — export `WIKI_PROJECT_DIRNAME = ".am-wiki"` and `LEGACY_WIKI_PROJECT_DIRNAME = ".agent-manager/wiki"`. Add `detectLegacyWikiLayout(projectDir: string): { hasLegacy: boolean; hasNew: boolean; legacyPath: string; newPath: string }`.
- Test: `test/wiki/storage-layout-detection.test.ts`

**Step 1: failing test**

```typescript
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { detectLegacyWikiLayout, WIKI_PROJECT_DIRNAME, LEGACY_WIKI_PROJECT_DIRNAME } from "../../src/wiki/storage";

describe("detectLegacyWikiLayout", () => {
  test("clean project: neither layout present", () => {
    const dir = mkdtempSync(join(tmpdir(), "wiki-layout-"));
    try {
      const r = detectLegacyWikiLayout(dir);
      expect(r.hasLegacy).toBe(false);
      expect(r.hasNew).toBe(false);
      expect(r.legacyPath).toBe(join(dir, LEGACY_WIKI_PROJECT_DIRNAME));
      expect(r.newPath).toBe(join(dir, WIKI_PROJECT_DIRNAME));
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test("only legacy present", () => {
    const dir = mkdtempSync(join(tmpdir(), "wiki-layout-"));
    try {
      fs.mkdirSync(join(dir, ".agent-manager", "wiki"), { recursive: true });
      const r = detectLegacyWikiLayout(dir);
      expect(r.hasLegacy).toBe(true);
      expect(r.hasNew).toBe(false);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test("only new present", () => {
    const dir = mkdtempSync(join(tmpdir(), "wiki-layout-"));
    try {
      fs.mkdirSync(join(dir, ".am-wiki"));
      const r = detectLegacyWikiLayout(dir);
      expect(r.hasLegacy).toBe(false);
      expect(r.hasNew).toBe(true);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test("both present (mid-migration)", () => {
    const dir = mkdtempSync(join(tmpdir(), "wiki-layout-"));
    try {
      fs.mkdirSync(join(dir, ".agent-manager", "wiki"), { recursive: true });
      fs.mkdirSync(join(dir, ".am-wiki"));
      const r = detectLegacyWikiLayout(dir);
      expect(r.hasLegacy).toBe(true);
      expect(r.hasNew).toBe(true);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
```

**Step 2: run test → expect FAIL** (export does not exist).

```bash
bun test test/wiki/storage-layout-detection.test.ts
```

**Step 3: minimal impl in `src/wiki/storage.ts`**

```typescript
export const WIKI_PROJECT_DIRNAME = ".am-wiki";
export const LEGACY_WIKI_PROJECT_DIRNAME = ".agent-manager/wiki";

export function detectLegacyWikiLayout(projectDir: string) {
  const legacyPath = path.join(projectDir, LEGACY_WIKI_PROJECT_DIRNAME);
  const newPath = path.join(projectDir, WIKI_PROJECT_DIRNAME);
  return {
    hasLegacy: fs.existsSync(legacyPath),
    hasNew: fs.existsSync(newPath),
    legacyPath,
    newPath,
  };
}
```

**Step 4: run test → expect PASS.**

**Step 5: commit**

```bash
git add src/wiki/storage.ts test/wiki/storage-layout-detection.test.ts
git commit -m "feat(wiki): add layout detection helper for ADR-0044 migration"
```

---

## Task 2: Add `materialiseProject()` to storage layer

**Objective:** Storage-layer function that copies entries from the global wiki store down to a project's `.am-wiki/`. Pure function over filesystem; idempotent (re-running with the same args produces the same result).

**Files:**
- Modify: `src/wiki/storage.ts` — add `materialiseProject(projectDir: string, slugs: string[] | "all"): Promise<{ copied: string[]; skipped: string[] }>`.
- Test: `test/wiki/storage-materialise.test.ts`

**Step 1: failing test** — set up a fixture global store with 3 entries, materialise to a fresh project, assert 3 files exist with matching content. Then re-materialise with `"all"` and confirm idempotence (no errors, same result).

**Step 2: run → FAIL.**

**Step 3: implementation:**
- Resolve global store path via existing `resolveGlobalWikiDir()` (find it in `storage.ts`).
- Read all `.md` files (or filter by slug list).
- For each, copy to `path.join(projectDir, WIKI_PROJECT_DIRNAME, slug + ".md")`.
- Use `fs.promises.copyFile` (atomic on POSIX, generally fine on Windows).
- If destination dir doesn't exist, `mkdir({ recursive: true })`.
- Return `{ copied, skipped }` where skipped covers entries that already exist with identical content (compare via hash or mtime).

**Step 4: run → PASS.**

**Step 5: commit.**

---

## Task 3: Add `pushToGlobal()` to storage layer

**Objective:** Inverse of `materialiseProject`. Copies one entry from `.am-wiki/<slug>.md` up to the global store. Used by `am wiki publish`.

**Files:**
- Modify: `src/wiki/storage.ts` — add `pushToGlobal(projectDir: string, slug: string): Promise<{ pushed: string; conflict: boolean }>`.
- Test: `test/wiki/storage-push-to-global.test.ts`

**Step 1: failing test** covering: clean push (global slot empty), push-when-already-exists (`conflict: true` returned, no overwrite by default), force overwrite via 2nd arg.

**Step 2-5:** Standard TDD cycle.

---

## Task 4: AGENTS.md template module

**Objective:** Hardcoded template at `src/wiki/agents-md-template.ts` with `schema_version: 1.0` pin.

**Files:**
- Create: `src/wiki/agents-md-template.ts` — exports `WIKI_AGENTS_MD_TEMPLATE: string` and `WIKI_AGENTS_MD_SCHEMA_VERSION: "1.0"`.
- Test: `test/wiki/agents-md-template.test.ts`

**Step 1: failing test** — assert template starts with `---\nschema_version: 1.0\n---\n`, contains a section "What is this directory?", contains a section "How to read entries", and is < 5KB.

**Step 2-5:** Write the template (~50 lines of guidance for AI agents reading the wiki — pull substance from `docs/design/2026-05-05-llm-wiki-vision.md` §2.4 if present, otherwise compose). Tests pass. Commit.

---

## Task 5: Refactor `am wiki init` to write `.am-wiki/`

**Objective:** The current `init` writes to `.agent-manager/wiki/` (per ADR-0022). After this task, it writes to `.am-wiki/`, creates the AGENTS.md from the template, and prints a deprecation warning if the legacy path also exists.

**Files:**
- Modify: `src/commands/wiki.ts` — find the init subcommand (search for `name: "init"`); update path resolution.
- Modify: `src/wiki/storage.ts` — if `resolveProjectWikiDir(projectDir)` is the function init uses, point it at `WIKI_PROJECT_DIRNAME`. Keep the legacy resolver under a different name (`resolveLegacyProjectWikiDir`) for migration use.
- Test: `test/commands/wiki-init.test.ts` (or extend the existing test).

**Step 1: failing test** covering: init in clean dir → `.am-wiki/AGENTS.md` exists with `schema_version: 1.0`. Init in dir with legacy `.agent-manager/wiki/` → both paths exist + warning printed (assert via captured stderr).

**Step 2-5:** TDD. Commit.

---

## Task 6: New `am wiki migrate` subcommand

**Objective:** Move existing `.agent-manager/wiki/` (symlink layout) to `.am-wiki/` (copy layout). Backs up to `.agent-manager/wiki.backup-YYYYMMDD/`. `--dry-run` shows planned changes.

**Files:**
- Create: `src/commands/wiki/migrate.ts` (or inline subcommand in `src/commands/wiki.ts` if that's the existing pattern).
- Test: `test/commands/wiki-migrate.test.ts`

**Step 1: failing test** covering:
- legacy + content present → migrated to `.am-wiki/`, legacy renamed to `.agent-manager/wiki.backup-YYYYMMDD/`
- already migrated (only `.am-wiki/` present) → no-op, prints "already migrated"
- both present (partial migration interrupted) → conservative: errors out asking user to resolve manually
- `--dry-run` → no filesystem changes, prints planned mv

**Step 2-5:** TDD cycle. Commit.

---

## Task 7: New `am wiki publish <slug>` subcommand

**Objective:** Promotes a project-local entry to the global store. Both `frontmatter promote: true` AND this command can trigger; the command is the actual mover, the flag is a declared-intent marker.

**Files:**
- Create: `src/commands/wiki/publish.ts` (or inline).
- Test: `test/commands/wiki-publish.test.ts`

Covers: clean publish, conflict-when-already-exists (asks user via prompt or `--force` flag), publish-by-frontmatter-flag (`am wiki publish --auto` scans for `promote: true` entries and publishes all).

---

## Task 8: New `am wiki pull` subcommand

**Objective:** Explicit, opt-in: materialise new entries from the global store down to the current project's `.am-wiki/`. Accepts `--all` or `<slug>`. NOT invoked by default.

**Files:**
- Create: `src/commands/wiki/pull.ts` (or inline).
- Test: `test/commands/wiki-pull.test.ts`

Covers: pull with no global content (no-op + helpful message), pull `--all` (materialises every global entry not already local), pull `<slug>` (just that one), conflict (local has same slug with different content; default refuses, `--force` overwrites).

---

## Task 9: Update default `.gitignore` template

**Objective:** Add `.am-wiki/` to whatever default `.gitignore` `am init` writes for new project configs. Per ADR-0044 §4: gitignored-by-default until ADR-0042 is fully integrated.

**Files:**
- Locate: search the codebase for where `.gitignore` content is written (likely `src/commands/init.ts` or a `templates/` dir). Add `.am-wiki/` to the default template.
- Test: `test/commands/init-gitignore.test.ts` (or extend existing).

**Step 1: failing test** — fresh `am init` in a clean dir → `.gitignore` contains `.am-wiki/`.

---

## Task 10: Wire all four subcommands into the wiki command group

**Objective:** Whatever the existing pattern is (single-file or subcommand-per-file), make sure `am wiki migrate`, `am wiki publish`, `am wiki pull` are reachable from the CLI. Update help text.

**Files:**
- Modify: `src/commands/wiki.ts` — register the new subcommands.
- Modify: `src/cli.ts` — only if needed; existing pattern likely already routes `wiki` to `wiki.ts`.
- Test: `test/commands/wiki-help.test.ts` — assert the help output mentions all 4 new commands.

---

## Task 11: ADR-0044 status update + documentation

**Objective:** When tasks 1-10 are done, flip ADR-0044 from `proposed` to `accepted` and update verification gate statuses.

**Files:**
- Modify: `ADRs/0044-wiki-two-tier-copy-materialisation.md` — frontmatter + verification gates.
- Modify: existing wiki docs (`docs/wiki.md` if it exists, otherwise create a section in README) — note the new commands.
- Test: none (documentation only).

Commit with `docs(adr): promote ADR-0044 to accepted; gates closed`.

---

## Task 12: ADR-0022 final cross-reference cleanup

**Objective:** ADR-0022 is `superseded-in-part-by-ADR-0044`. Add a short header note at the top of ADR-0022's body pointing readers at ADR-0044 for the materialisation strategy. Verify §3-4 (the part being amended) link out clearly.

**Files:**
- Modify: `ADRs/0022-wiki-location-strategy.md`

Commit.

---

## Verification (run after task 12)

```bash
cd /mnt/e/CS/github/agent-manager
bun test test/wiki/ test/commands/wiki-*.test.ts 2>&1 | tail -10
# Expected: all pass; ≥30 new tests across the new files.

bun run typecheck 2>&1 | grep "src/wiki\|src/commands/wiki" | grep -v "node_modules" | head -5
# Expected: no NEW errors (pre-existing TS5097 import-extension errors are codebase-wide and not introduced by this work).

# End-to-end smoke test:
TMPDIR=$(mktemp -d)
cd $TMPDIR && am init && am wiki init
test -d .am-wiki && echo "✓ .am-wiki exists"
test -f .am-wiki/AGENTS.md && echo "✓ AGENTS.md exists"
grep -q "schema_version: 1.0" .am-wiki/AGENTS.md && echo "✓ schema pin"
grep -q ".am-wiki" .gitignore && echo "✓ gitignored"
```

---

## Risk areas + parallelisation notes

- **Tasks 1, 2, 3, 4** are fully independent of each other and of Task 5+. They can run as a parallel wave (4 subagents, file-disjoint).
- **Tasks 5, 6, 7, 8** depend on Tasks 1-4 being merged. They must be sequential or carefully file-disjoint within `wiki.ts` (citty subcommands).
- **Tasks 9, 10, 11, 12** are post-implementation hygiene; serial.
- **Risk: Windows path semantics.** Tests at task 6 (migrate) MUST cover Windows backslash paths; CI matrix should include Windows.
- **Risk: existing wiki users with content in `.agent-manager/wiki/`.** The migrate command handles this, but task 6 needs explicit acceptance test for backup recovery (rename failure → restore).
- **Risk: harvester writes during migration.** If a session is being harvested mid-migration, content could land in either layout. Document: "run migrate when no other am process is touching the wiki." Add an mtime-based detection if it surfaces in review.

## Estimated total time

~12 tasks × 15-20 min/task = 3-4 hours of implementation if subagent-driven; longer in solo. The TDD discipline should catch most issues without rework.

---

## Follow-up backlog (deferred)

From parallel-critique on the doctor-scan implementation
(`docs/reviews/2026-05-05-doctor-scan/` — 3 reviewers, all CONFIRMED no blockers):

- **doctor regex extension** (LOW): scan misses quoted/dotted/inline-table TOML
  forms of `team_passphrase`. Belt-and-suspenders only; gates 1+2 schema reject
  catches them on load. Consider extending regex set OR using a TOML-parse-then-
  walk approach if gates 1+2 ever weaken.
- **doctor integration test** (LOW): existing tests cover the regex/env substrate;
  no end-to-end test invokes `doctorCommand.run()` with a fixture config and
  asserts the rendered status table. Add when a doctor-output regression risk
  surfaces.
- **legacy env var constants** (LOW): `AM_TEAM_PASSPHRASE`,
  `AGENT_MANAGER_TEAM_PASSPHRASE`, `AM_SHARED_PASSPHRASE` are inline literals;
  extract to a `LEGACY_TEAM_PASSPHRASE_ENV_VARS` constant if reused elsewhere.
