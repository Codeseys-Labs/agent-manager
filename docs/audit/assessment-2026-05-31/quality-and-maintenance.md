# Quality & Maintenance Audit — agent-manager (`am`)

**Date:** 2026-05-31
**Dimension:** quality-and-maintenance
**Auditor bar:** Is this project architected/maintained well enough to become a
production-ready, downloadable CLI with a first-run setup wizard that a stranger
can install, run, and get value from without reading the source?

---

## TL;DR

The *engineering substance* is genuinely strong: **3064 tests pass, 0 fail**
(verified by running `bun test`), lint is clean (453 files, Biome), `src/` is
typecheck-clean, there is essentially **zero TODO/FIXME debt** in source (1
match, and it's a regex constant), and `as any` / `err: any` are at 0. This is
a disciplined codebase by raw-quality metrics.

The *maintenance hygiene around the code* is where it falls down, and the
failures are exactly the kind that embarrass a project in front of a first
contributor or user:

1. **Every count in every doc is wrong, and they all disagree with each
   other.** README says 2906 tests, ROADMAP says 1916, AGENTS.md says 1772,
   CLAUDE.md says 2906 — the truth is **3064**. Source-file and command counts
   are similarly divergent across all four docs.
2. **Meta-tooling is committed to the repo, violating the user's standing
   rule.** `.seeds/`, `.mulch/`, `.canopy/`, `.overstory/` — 39 tracked files
   of external agent-orchestration scaffolding — are checked in. The user's
   own MEMORY explicitly states "never commit ruflo artifacts"; the same
   principle applies here and is being broken.
3. **55 ADRs for one pre-1.0 CLI, with "implementation-plan" ADRs marked
   `accepted` before the code exists.** ADR-0049 (CM6 editor) is `accepted`
   but there is zero CodeMirror code in the tree, and the deep-work-log lists
   that wave as "plan ready / pending". The ADR process has tipped from signal
   into ceremony.
4. **Deprecation removal targets are already in the past.** Five MCP tool
   aliases are scheduled for removal "v0.4"; the package is at `0.5.0-rc6`.

None of these are deep architectural rot — they are all **fixable in a focused
day of work** — but until they are fixed, the project's own documentation
actively misleads a newcomer, and that directly undermines the "stranger can
get value without reading the source" bar.

---

## 1. Test count / coverage: claimed vs. truth

I ran the full suite to ground-truth this.

```
Ran 3064 tests across 232 files. [469.19s]
 3064 pass
 0 fail
 9672 expect() calls
```
(`bun test`, executed 2026-05-31)

### The four conflicting claims

| Doc | Tests | Files | Assertions | Evidence |
|-----|-------|-------|-----------|----------|
| **Truth (`bun test`)** | **3064** | **232** | **9672** | run output above |
| README.md | 2906 | — | — | `README.md:10` (badge), `README.md:935-936` (182 src / 151 test) |
| CLAUDE.md | 2906 | 222 | 9122 | `CLAUDE.md:60`, `CLAUDE.md:168`, `CLAUDE.md:340` |
| ROADMAP.md | 1,916 | 152 | 5,655 | `ROADMAP.md:319-320`, `ROADMAP.md:317-318` (176 src / 152 test) |
| AGENTS.md | 1772 | 146 | 5336 | `AGENTS.md:160`, `AGENTS.md:346` |
| CHANGELOG.md | 1,916 | 152 | 5,655 | `CHANGELOG.md:206` (frozen at 0.4.0, acceptable for a changelog) |

Actual source files: **215** `.ts/.tsx` under `src/` (vs CLAUDE.md's "199",
ROADMAP's "176", README's "182"). Actual test files: **232** `.test.ts`.

This is not a single stale number; it is **four independently-maintained,
mutually-contradictory stat tables**, none correct. The README ships a *test
badge* (`tests-2906%20pass`) that is wrong, which is the single most
visible-to-a-stranger artifact in the repo.

### Coverage

`package.json:test:coverage` wires `bun test --coverage`, and a `coverage/`
directory exists locally (gitignored — correct). But ROADMAP lists "Test
coverage metrics (bun --coverage in CI, badge in README)" as an **unchecked**
item (`ROADMAP.md:234`). So there is **no published coverage number** and no
coverage gate in CI. The 9672 assertions across 3064 tests is a strong proxy,
but "coverage" as a claim is unsubstantiated.

**Recommendation:** Delete three of the four stat tables. Keep one (ROADMAP or
README) and generate it from a script in CI so it cannot drift. Remove the
hard-coded test-count badge or wire it to a CI-generated shields endpoint.

---

## 2. Meta-tooling sprawl — committed agent artifacts (standing-rule violation)

The repo root carries six external-tooling directories. I checked each against
git tracking:

```
.seeds:          5 tracked files
.mulch:         16 tracked files
.canopy:         4 tracked files
.overstory:     14 tracked files
.playwright-mcp: 0 tracked files   (gitignored ✓)
.codex:          0 tracked files   (gitignored ✓)
.claude:         0 tracked files   (untracked ✓)
```
(`git ls-files` per directory)

**`.seeds/` (seeds issue tracker), `.mulch/` (expertise records), `.canopy/`
(prompt management), and `.overstory/` (multi-agent orchestration) are all
committed** — 39 files total — in a single deliberate commit:

```
0f72fb1 chore: initialize overstory and ecosystem tools
```
(`git log --diff-filter=A` for each dir)

`.overstory/README.md:3` self-describes as *"managed by overstory — a
multi-agent orchestration system for Claude Code"*, i.e. it is **developer
accelerator scaffolding, not a product feature**. The user's persisted memory
states the standing rule directly: *"Ruflo is meta-tooling, not an
agent-manager feature… never commit ruflo artifacts to the repo."* The same
rule plainly extends to overstory/seeds/mulch/canopy.

`.codex` and `.playwright-mcp/` *were* correctly added to `.gitignore`
(`.gitignore` last two lines) — which proves the maintainer knows the pattern
and applies it selectively. The four ecosystem dirs slipped through.

### Why this matters for the "downloadable CLI" bar

- **`.npmignore` does not exclude them.** `.npmignore` lists
  `test/ docs/ research/ ADRs/ dist/ scripts/ .github/ .claude/ ...` — but
  *not* `.seeds .mulch .canopy .overstory`. However `package.json:files` uses
  an allowlist (`src/ bin/ dist/ LICENSE README.md`), so they won't ship to
  npm. **They will ship in the GitHub tarball / git clone**, which is what a
  contributor sees first.
- A stranger cloning the repo sees four mysterious dotfolders of JSONL issue
  logs, expertise records ("mulch expertise records" per the latest commit
  `1c70fa2`), and tmux-orchestration agent definitions. It reads as a working
  scratchpad, not a shippable product.

**Recommendation:** `git rm -r --cached .seeds .mulch .canopy .overstory`, add
all four to `.gitignore`, and add them to `.npmignore` for defense-in-depth.
This is a 5-minute fix and is the single most direct violation of an explicit
user rule found in this dimension.

---

## 3. Doc drift beyond counts

The four "front-door" docs (README, CLAUDE.md, ROADMAP, AGENTS.md) have
diverged on substance, not just numbers:

| Topic | README | CLAUDE.md | AGENTS.md | ROADMAP | Truth |
|-------|--------|-----------|-----------|---------|-------|
| CLI commands | "31" (`README.md:854`) | "31 lazy subcommands" (`CLAUDE.md:68`) | "30 subcommands" (`AGENTS.md:94`) | "31" (`ROADMAP.md:75`) | **36** registered in `src/cli.ts` |
| MCP tools | "38 (33 active + 5 aliases)" (`README.md:43,541`) | "38 tools" (`CLAUDE.md:16`) | "33+ tools" (`AGENTS.md:20`) | "33" (`ROADMAP.md:88,324`) | 33 active + 5 deprecated aliases |
| Marketplace (pillar 4) | **retired** per ADR-0039 (`README.md:49-52`) | **live pillar 4**, no deprecation note (`CLAUDE.md:21-24`) | retired per ADR-0039 (`AGENTS.md:24-28`) | "Complete" (`ROADMAP.md:216`) | deprecated, code still present |

The marketplace contradiction is the worst: **CLAUDE.md still presents
Marketplace as a live core pillar** ("4. Marketplace — git-backed catalogs,
supply-chain hardened") while README and AGENTS.md correctly mark it retired
per ADR-0039/0052. The agent reading CLAUDE.md at session start (as the project
instructs) is told to keep building a feature that two other docs say is dead.

The actual registered command list (`src/cli.ts`):
```
init add list use apply status config profile doctor import push pull undo log
secret secrets version adapter mcp-serve mcp-superset serve tui session search
install uninstall update wiki agent agents run acp flow completion marketplace pair
```
36 commands — including `pair`, `secrets`, `secrets-*`, `mcp-superset`, `agent`
(singular, distinct from `agents`) — none of which appear in any doc's command
inventory.

**Stale code comment:** `src/core/secrets-backend.ts:15-19` says *"This module
is scaffolding only — it is not yet wired into apply paths. Callers continue to
use the module-level functions in `./secrets.ts`."* This is false: `secrets.ts:6-7`
imports `getBackend`/`registerBackend` from it, and `secrets-age.ts:41` calls
`registerBackend`. The comment is doc drift inside the code.

---

## 4. ADR process: 55 records — signal or ceremony?

**Count:** 55 ADRs (`ls ADRs/*.md`, excluding README/template). 44 carry a
`status:` field; the template (`ADRs/template.md`) is solid (MADR-style,
amends/supersedes fields, ≥2 options enforced by the adr-methodology skill).
16 ADRs amend or supersede another ADR.

The *foundational* ADRs (0001–0030) are genuinely high-signal: one decision per
real architectural fork (TOML, git-backed, two-phase Zod, single binary,
adapters). For those, 30 ADRs over a complex multi-adapter CLI is reasonable.

**Where it becomes ceremony — the 0043–0051 hosted-UI cluster:**

- ADR-0045 "Hosted UI Editor — CodeMirror 6" — `status: proposed`
- ADR-0048 "Hosted UI Auth Implementation Plan" — `status: accepted`
- ADR-0049 "Hosted UI Editor CM6 **Implementation Plan**" — `status: accepted`
- ADR-0050 "Browser Secret Decryption Bundle" — `status: accepted`

These are **implementation-plan ADRs marked `accepted`** — but the
implementation does not exist. Searching the entire tree:
```
grep -rln "codemirror\|CodeMirror\|monaco\|EditorView" src/ web/   →  (no matches)
```
And the deep-work-log confirms it (`docs/deep-work-log.md`, "Remaining work"):
```
- Wave R (ADR-0049 CM6 editor) — plan ready, blocks on Q.
- Wave S (ADR-0050 browser decrypt) — plan ready, blocks on Q+R.
```

So an ADR titled "Implementation Plan", carrying `status: accepted`, describes
a feature that is *"plan ready / pending"* and has **zero lines of code**.
"Accepted" in MADR means *the decision is in force* — conflating it with "we
intend to do this" inflates the record count and makes the ADR index a poor map
of what's actually built. A reader can no longer trust `status: accepted` to
mean "shipped/decided".

**Symptom of over-process:** there are also six ADRs (0042, 0046, 0047, 0050,
0051, plus 0048/0049) devoted entirely to a *secrets-rewrap / age-envelope /
cross-device-pairing* subsystem (`am pair`, `am secrets-rotate/rewrap/revoke/
migrate`) on a pre-1.0 tool that has not shipped to npm. That is a lot of
formal decision ceremony for a feature set whose user base is currently zero
(ADR-0052 itself notes "The product has not shipped to npm so this population
is small in practice").

**Verdict on the ADR process:** keep the methodology (the template and
discipline are good), but (a) implementation-plan ADRs should be
`status: proposed` until the code lands, and (b) the index in CLAUDE.md/ROADMAP
should distinguish "decision ADRs" from "plan ADRs". The process is generating
*some* ceremony, but it is recoverable, not pathological.

---

## 5. Deprecated MCP tool aliases — removal target in the past

`src/mcp/server.ts:118-125` defines five deprecated aliases:

```ts
export const DEPRECATED_ALIASES = {
  am_agent_delegate:      { replacement: "am_agent_invoke",        removal_version: "v0.4" },
  am_run_agent:           { replacement: "am_agent_invoke",        removal_version: "v0.4" },
  am_acp_list_agents:     { replacement: "am_agent_list",          removal_version: "v0.4" },
  am_acp_session_list:    { replacement: "am_agent_session_list",  removal_version: "v0.4" },
  am_acp_session_cancel:  { replacement: "am_agent_session_cancel",removal_version: "v0.4" },
};
```

The package is at **`0.5.0-rc6`** (`package.json:version`). The removal target
`v0.4` is **already shipped and past** (CHANGELOG has `0.4.0 — 2026-04-16`).
The runtime even nags about it on every test run:
```
[am-mcp] DEPRECATED: tool "am_acp_list_agents" is an alias. Use "am_agent_list" instead (removal targeted for v0.4).
```
(captured in the `bun test` output)

So the deprecation machinery works (it warns once per process, surfaces
`x-am.deprecated` in `tools/list`), but the **target version has lapsed**.
Either bump the target to a real upcoming version (e.g. v0.6/v1.0) or actually
delete the aliases. Right now the tool tells every connected agent "this goes
away in v0.4" while running v0.5.

---

## 6. Dead code & half-built features

**Genuinely low debt in `src/`:**
- TODO/FIXME/HACK/XXX: **1 match**, and it is a regex constant
  (`src/wiki/sync.ts:68` `PLACEHOLDER_HINTS`), not a real TODO.
- `as any` / `err: any`: 0 (per ROADMAP claim, consistent with clean lint).

**Documented half-built / stubbed surfaces (honestly flagged in-code):**
- `am add` git+ skill sources: `src/commands/add.ts:325,343` — *"git+ sources
  are not yet supported (stubbed)"*. Returns a clean error, not a crash. OK.
- `src/marketplace/*` (7 files, ~62 KB) + `am marketplace` command — **all
  marked `@deprecated`** per ADR-0039 (`src/marketplace/client.ts:4` etc.,
  `src/commands/marketplace.ts:2`). This is *intentional* dead-code-on-death-row:
  ADR-0052 (`status: accepted`) sets the removal at v1.0 and confirms
  "`src/marketplace/*` has no production importers outside the deprecated
  `src/commands/marketplace.ts`". So it is not *accidental* dead code, but it is
  ~62 KB of frozen code shipping in the binary today and still registered in
  `src/cli.ts:59`. README (`README.md:766-769`) and AGENTS.md correctly note
  the deprecation; CLAUDE.md does not (§3).
- Other `@deprecated` annotations (11 total): `BUILT_IN_ACP_AGENTS` kept for
  source compat (`agent-registry.ts:188`), a wiki symlink helper superseded by
  ADR-0044 (`wiki/storage.ts:159`), and an `am secrets-age` convenience method.
  All are deliberate, annotated, with replacements named. Healthy deprecation
  hygiene.

No orphaned/unreferenced modules of concern were found in `src/`.

---

## 7. Engineering-health checks (run live)

| Check | Result | Note |
|-------|--------|------|
| `bun test` | **3064 pass / 0 fail** | 469 s wall-clock — slow but green |
| `bun run lint` (Biome) | **clean**, 453 files | exit 0 |
| `bun run typecheck` (`tsc --noEmit`) | **63 errors** | see breakdown below |

**Typecheck breakdown (the 63 errors):**
```
29  VENDOR  node_modules/@silvery/ag-react
20  VENDOR  node_modules/@silvery/ag-term
 2  VENDOR  node_modules/@silvery/ink
 1  VENDOR  silvery/src
 9  FIRST-PARTY  test/   (cursor/windsurf session SQLQueryBindings type mismatches)
 2  FIRST-PARTY  scripts/build.ts  (top-level await needs `export {}`)
 0  FIRST-PARTY  src/    ← src is clean
```

`src/` is **typecheck-clean** — excellent. But:
- **52 of 63 errors are from the `@silvery` TUI dependency** leaking its own
  `.ts` source into the compile (the deep-work-log calls this "vendor typecheck
  noise (52 errors)" and explicitly punts it). `skipLibCheck: true` doesn't
  help because these are `.ts` files, not `.d.ts`. The net effect: **a
  contributor who runs the documented `bun run typecheck` sees 63 red errors
  and cannot tell that the project's own code is clean.** That is a real
  onboarding/maintenance hazard.
- 11 first-party errors in `test/` and `scripts/build.ts` are real and should
  be fixed (the cursor/windsurf SQL bind-param typing, and the build script's
  missing module marker).

**Recommendation:** add a `typecheck` tsconfig that excludes `node_modules`
sources from the program (or shim the `@silvery` types), so
`bun run typecheck` reflects first-party health. Fix the 11 first-party errors.
CI currently passes (per ROADMAP "CI: test, lint, typecheck, build — Done"),
which means either CI tolerates these or runs a narrower typecheck — worth
verifying CI isn't green-on-broken.

---

## 8. Repo cleanliness for a downloadable product

- **`docs/` is heavy with process artifacts:** `docs/reviews/` (62 files),
  `docs/research/` (31), `docs/plans/` (11), `docs/deliberations/` (8),
  `docs/deep-work-log.md` (2231 lines / 107 KB). Plus a top-level `research/`
  (20 files) and `TMP-PROMPT.md` at the root. These are excluded from npm via
  `.npmignore` (`docs/ research/` listed) — good — but they dominate the
  GitHub-visible tree. `TMP-PROMPT.md` (a raw brainstorm transcript) at repo
  root is the kind of file that should not be in a 1.0 product repo.
- **Two near-duplicate agent-instruction files:** `CLAUDE.md` (33 KB) and
  `AGENTS.md` (21 KB) cover overlapping ground and have **drifted from each
  other** (different pillar-4 status, different counts — §3). Maintaining two
  is double the drift surface. Consider making one canonical and having the
  other `@import` or point to it.

---

## 9. Maintainable by a small team?

**Yes, structurally** — the code is the easy part to maintain: one-file-per-
command, one-dir-per-adapter, a clean `Adapter`/`GitPlatformAdapter` interface,
lazy factory registration, 3064 green tests, clean lint, zero `any`. A new
maintainer could add an adapter or command by pattern-matching in an afternoon.

**The maintenance *tax* is the surrounding paperwork:** 55 ADRs (with
plan-ADRs masquerading as decisions), 4 drifting front-door docs, a 107 KB
deep-work-log, and committed multi-agent meta-tooling that any new human
contributor would find baffling. The ratio of *process artifacts to shipped
features* is high for a one-or-two-person pre-1.0 project. The risk is not that
the code rots — it's that the **documentation actively misinforms** (wrong
counts, contradictory marketplace status, "accepted" ADRs for unbuilt
features), so a small team will waste cycles reconciling docs and a stranger
will distrust the project.

---

## 10. Bottom line vs. the first-run-wizard bar

A first-run setup wizard's job is to let a stranger get value fast. This
dimension's findings *upstream* of the wizard:

- The **stat badges and pillar descriptions a newcomer reads first are wrong**
  (test badge, marketplace status). Fix before any 1.0 / npm publish.
- The **committed meta-tooling** makes the repo look like a personal
  scratchpad, not a shippable tool — remove it.
- The **ADR index can't be trusted** as a "what's built" map because
  implementation-plan ADRs are `accepted` while unbuilt — so the wizard cannot
  enumerate capabilities from the ADR set; it must be driven from
  `src/cli.ts` + adapter registry (the actual sources of truth, which *are*
  clean).
- The wizard itself has a partial foundation: `am init` already does
  interactive remote setup and a "novice first-run recovery" path
  (`src/commands/init.ts:114-159`), but there is **no advertised
  `am setup`/wizard** and README's "Quick Start" (`README.md:125`) is a command
  list, not a guided flow.

The engineering is production-grade; the **bookkeeping around it is not**, and
the bookkeeping is precisely what a first-time user/contributor reads first.

---

## Prioritized remediation (this dimension)

| Pri | Action | Effort | Evidence |
|-----|--------|--------|----------|
| **P0** | `git rm -r --cached .seeds .mulch .canopy .overstory`; add to `.gitignore` + `.npmignore` | 5 min | §2 |
| **P0** | Fix the README test badge + reconcile to ONE generated stat table; delete the other three | 30 min | §1, §3 |
| **P0** | CLAUDE.md: mark Marketplace retired (align with README/AGENTS/ADR-0039) | 10 min | §3 |
| **P1** | Bump or retire the `v0.4` MCP-alias removal target (already past) | 15 min | §5 |
| **P1** | Fix 11 first-party typecheck errors; exclude `@silvery` vendor `.ts` from `bun run typecheck` | 1–2 h | §7 |
| **P1** | Remove `TMP-PROMPT.md` from repo root; relocate process docs out of the product tree | 20 min | §8 |
| **P2** | Re-status implementation-plan ADRs (0045/0048/0049/0050) to `proposed` until code lands; split "decision" vs "plan" in the ADR index | 30 min | §4 |
| **P2** | Fix stale "scaffolding only" comment in `secrets-backend.ts:15` | 5 min | §3 |
| **P2** | Reconcile CLAUDE.md/AGENTS.md command & file counts; consider single canonical agent doc | 1 h | §3, §8 |
| **P3** | Wire `bun test --coverage` into CI and publish a real coverage number | 1–2 h | §1 |
