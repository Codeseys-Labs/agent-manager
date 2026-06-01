# Stacked PR Workflows with `gh` + CodeRabbit AI Review

> Deep-research report for **agent-manager** (`am`). How to run a stack of
> dependent PRs with the GitHub CLI, how CodeRabbit reviews them, the
> `.coderabbit.yaml` knobs that matter, and a concrete branch/PR-stack
> convention for this repo's wave-based backlog.
>
> Date: 2026-05-31. Sources cited inline as `[n]`, listed at the bottom.

---

## TL;DR

1. **You don't need Graphite/spr/ghstack.** Plain `gh pr create --base <parent>`
   plus `git rebase --update-refs` (Git ≥ 2.38) gives you a complete stacked-PR
   workflow with zero extra tooling — and `git config branch.<name>.gh-merge-base`
   makes `gh` auto-target the parent so you never retype `--base` [1][3][8][9].
2. **CodeRabbit reviews a stacked PR as the diff against *its own base branch***,
   not against `main` — so each focused PR gets a focused review. The one trap:
   CodeRabbit only auto-reviews a PR if the PR's **target/base branch** matches
   `reviews.auto_review.base_branches` (default = default branch only), and it
   **reads `.coderabbit.yaml` from the PR's base branch** [6][7][12].
3. **This repo is already configured for it.** `.coderabbit.yaml` already sets
   `base_branches: [main, "wave/.*"]`. The convention below extends that to
   `wave-*` *stack* branches so intermediate PRs in a stack are auto-reviewed too.

---

## 1. Stacked PRs with plain `gh` (the recommended baseline)

### 1.1 Mental model

A "stack" is a chain of branches where each branch builds on the previous one,
and each PR's **base** (merge target) is the previous branch instead of `main`:

```
main
 └─ wave3/01-schema        →  PR #101  base: main
     └─ wave3/02-resolver  →  PR #102  base: wave3/01-schema
         └─ wave3/03-cli   →  PR #103  base: wave3/02-resolver
```

Because PR #102's base is `wave3/01-schema`, GitHub (and CodeRabbit) shows only
the *resolver* diff — not schema + resolver. That is the entire point: each PR is
an **independently-reviewable focused diff** [6][michaelagreiler].

### 1.2 Create the stack

`gh pr create --base` sets the merge target; `--head` defaults to the current
branch [3].

```bash
# bottom of the stack — targets main
git switch -c wave3/01-schema main
# ...edit src/core/schema.ts...
git commit -am "feat(schema): add ProfileVariant field"
git push -u origin wave3/01-schema
gh pr create --base main --fill --draft \
  --title "wave3: schema — ProfileVariant" \
  --body "Stack 1/3. Adds the ProfileVariant Zod field. Next: resolver."

# middle — targets the branch below it
git switch -c wave3/02-resolver         # branched off wave3/01-schema (current HEAD)
# ...edit src/core/resolver.ts...
git commit -am "feat(resolver): resolve ProfileVariant"
git push -u origin wave3/02-resolver
gh pr create --base wave3/01-schema --fill --draft \
  --title "wave3: resolver — ProfileVariant resolution" \
  --body "Stack 2/3. Depends on #101."

# top — targets the middle
git switch -c wave3/03-cli
# ...edit src/commands/profile.ts...
git commit -am "feat(profile): --variant flag"
git push -u origin wave3/03-cli
gh pr create --base wave3/02-resolver --fill --draft \
  --title "wave3: cli — am profile --variant" \
  --body "Stack 3/3. Depends on #102."
```

Notes:
- Use `--draft` while the stack is in flight; flip to ready with
  `gh pr ready <n>` when each link is solid. Draft + `drafts: false` (the repo
  default) means CodeRabbit holds review until you mark ready [4][michaelagreiler].
- `gh pr create` **errors if the branch already has an open PR** — to change an
  existing PR's base later, use `gh pr edit <n> --base <new-base>` [cli/cli#5792].

### 1.3 Stop retyping `--base`: `gh-merge-base` git config

`gh pr create`'s `--base` default chain is: `branch.<current>.gh-merge-base`
git config → repo default branch [3]. So record the parent once and `gh` targets
it automatically:

```bash
git config branch.wave3/02-resolver.gh-merge-base wave3/01-schema
git config branch.wave3/03-cli.gh-merge-base      wave3/02-resolver
# now this Just Works, no --base needed:
git switch wave3/03-cli && gh pr create --fill --draft
```

This is the single most useful native-`gh` ergonomics win for stacks.

### 1.4 Keep the stack rebased — `git rebase --update-refs`

The killer feature (Git ≥ 2.38). Check out the **top** of the stack, rebase onto
the new base **once**, and Git force-updates every intermediate branch ref in the
same operation [1][9][adamj].

```bash
git fetch origin
# enable once, globally — makes every rebase update stacked refs:
git config --global rebase.updateRefs true

# bottom branch got new commits (e.g. you addressed review on #101).
# rebase the whole stack from the top:
git switch wave3/03-cli
git rebase origin/wave3/01-schema --update-refs
#   Successfully rebased and updated refs/heads/wave3/03-cli.
#   Updated the following refs with --update-refs:
#     refs/heads/wave3/01-schema
#     refs/heads/wave3/02-resolver

# push all three; --force-with-lease is mandatory after a rebase:
git push --force-with-lease origin \
  wave3/01-schema wave3/02-resolver wave3/03-cli
```

Supporting native commands:
- **Single PR onto its updated base:** `gh pr update-branch <n> --rebase` [1].
- **Transplant after the parent merges into main** (`--onto`):
  `git rebase --onto main wave3/01-schema wave3/02-resolver` moves the
  resolver commits off the (now-merged) schema branch onto `main` [5][substack].
- **`git rerere`** records conflict resolutions so repeated rebases of the same
  stack don't re-ask: `git config --global rerere.enabled true` [nutrient].

> **Worktree caveat:** `--update-refs` will **not** update a branch that is
> checked out in another worktree. agent-manager devs use `git worktree` (the
> `superpowers:using-git-worktrees` skill / `EnterWorktree`) — rebase the stack
> from a worktree where none of the stacked branches are checked out elsewhere,
> or the intermediate refs silently won't move [1][9].

### 1.5 Merge the stack — bottom-up

Merge **from the bottom**. This minimizes conflicts and diff pollution, and
GitHub's **PR retargeting** does the cleanup for you [17][github-retarget-changelog].

```bash
# 1. mark ready + merge the bottom PR
gh pr ready 101
gh pr merge 101 --squash --delete-branch
```

When `wave3/01-schema` is merged and deleted, **GitHub automatically retargets
PR #102's base from `wave3/01-schema` to `main`** (its merged parent's base) —
PRs are *retargeted*, not closed, since the 2020 change [github-retarget-changelog][so-74024491].

```bash
# 2. #102 is now base=main; if it needs a clean rebase first:
gh pr update-branch 102 --rebase     # or: git switch wave3/02-resolver && git rebase origin/main && git push --force-with-lease
gh pr ready 102 && gh pr merge 102 --squash --delete-branch
# 3. #103 auto-retargets to main; repeat
gh pr ready 103 && gh pr merge 103 --squash --delete-branch
```

`gh pr merge` flags: `--merge | --squash | --rebase`, `--delete-branch`,
`--auto` (merge when checks pass), `--admin` (bypass protections) [2].

> **Squash vs rebase for stacks:** `--squash` is cleanest for a wave (one tidy
> commit per PR on `main`) but it rewrites the parent's SHAs, so after each
> bottom merge you should rebase the next branch onto `main` (step 2 above)
> rather than `--update-refs`. `--rebase`-merge preserves the stack's commits and
> lets the remaining branches fast-forward, but pollutes `main` history. Pick one
> per wave and stay consistent — this repo's commit style (`feat:`/`fix:` prefix,
> no co-author lines) pairs naturally with **squash**.

---

## 2. Tooling: Graphite (`gt`) vs `spr` vs `ghstack` vs plain `gh`

| | **plain `gh` + git** | **Graphite `gt`** | **`spr` (ejoffe / spacedentist)** | **`ghstack`** |
|---|---|---|---|---|
| Unit of review | 1 branch = 1 PR | 1 branch = 1 PR | **1 commit = 1 PR** | **1 commit = 1 PR** |
| Install | none (already have `gh`) | `brew install withgraphite/tap/graphite` + `gt init` + auth | `go`/`cargo` install | `pip install ghstack` |
| Create stack | `gh pr create --base <parent>` per PR [3] | `gt create -am`, `gt submit --stack` [10] | `spr diff` (maps commits→PRs) [12] | `ghstack` (commits→PRs+branches) [13] |
| Restack on change | `git rebase --update-refs` + force-push [9] | `gt sync` / `gt restack` — **auto cascades** [10][graphite-restack] | `spr diff --all` re-pushes [12] | re-run `ghstack` |
| How PR base is set | explicit `--base` / `gh-merge-base` [3] | tool-managed metadata per branch [10] | **synthetic base branch** = diff(main, parent-commit) so each PR shows only its own change [12] | per-commit synthetic branches [13] |
| Auto-retarget on merge | GitHub native retarget [github-retarget-changelog] | `gt` handles + UI "Merge N" [18] | `spr land --count N` | `ghstack land <url>` |
| Web UI / viz | GitHub only | rich web app, stack graph [10] | none | none |
| Lock-in | none | medium (metadata, web app) | low (commit-msg trailer) | low |

**Recommendation for agent-manager: stay on plain `gh` + `--update-refs`.**
Rationale:
- The repo already commits to **zero runtime deps / single binary** (ADR-0010)
  and a no-system-`git` ethos (isomorphic-git). Adding a `gt`/`spr` install to the
  contributor flow cuts against that minimalism.
- Waves here are **small (2–4 PRs)** — exactly the size where `gt`/`spr` overhead
  isn't worth it; the codetinkerer rule of thumb is "stacks beyond ~3–4 want a
  tool" [codetinkerer].
- `spr`/`ghstack`'s **1-commit-1-PR** model fights the repo's TDD habit of
  multiple commits per logical change (failing test → impl → refactor).
- Graphite is the right escalation *if* a wave ever balloons to 6+ interdependent
  PRs with heavy churn — `gt sync` auto-cascading rebases is genuinely better
  there [10][18]. Treat it as an optional power-user tool, not the house standard.

A lightweight middle ground that needs **no install**: a repo script wrapping the
section-1.4 commands (see §5.3).

---

## 3. How CodeRabbit reviews stacked / base-branch PRs

### 3.1 The diff it reviews = PR base..PR head

CodeRabbit reviews the GitHub PR's diff, which is computed against the **PR's base
branch**. For a stacked PR whose base is `wave3/01-schema`, CodeRabbit reviews
only the resolver changes — *not* schema + resolver. This is precisely why
stacking yields tight, on-topic reviews [michaelagreiler][6]. Incremental reviews
on later pushes focus on "the commits added since the last review" [7].

### 3.2 The trap: `auto_review.base_branches` must match the *base* branch

CodeRabbit only auto-reviews a PR if the PR's **target/base branch** is either the
repo default branch (always included) **or** matches a regex in
`reviews.auto_review.base_branches` [6][7][12].

- Default `base_branches: []` ⇒ **only PRs targeting `main` are reviewed**. An
  intermediate stacked PR (base = `wave3/01-schema`) would be **silently skipped**.
- Fix: add a regex that matches your stack branch names. The repo already does the
  right thing for wave roots:

```yaml
# .coderabbit.yaml (existing)
reviews:
  auto_review:
    base_branches:
      - main
      - "wave/.*"   # ← regex, NOT glob; matches branches that are themselves bases
```

> **Regex, not glob.** `base_branches` entries are **regex** (e.g. `release/.*`,
> `.*` for everything) — distinct from `path_filters`/`path_instructions` which
> use **minimatch globs** [6][7][12]. `"wave/.*"` matches `wave/...`; to also match
> `wave3/...` (no slash) you need `"wave.*"` or an explicit alternation. See §4.

### 3.3 Where CodeRabbit reads config from — base branch

CodeRabbit **reads `.coderabbit.yaml` from the PR's base branch**, not from the PR
head [coderabbit-common-errors]. Consequences for stacks:
- A config change (e.g. new `path_instructions`) only takes effect for a stacked
  PR once it's present **on that PR's base branch**. Land config changes at the
  **bottom** of a stack (or directly on `main`) so the whole stack inherits them.
- If a stacked PR's base is a feature branch that predates a `.coderabbit.yaml`
  edit, that PR uses the old config until rebased.

### 3.4 Manual triggers, pausing, and Autofix on stacks

- `@coderabbitai review` (incremental) / `@coderabbitai full review` force a
  review even on a non-matching base or paused PR [faq].
- `auto_pause_after_reviewed_commits` (default 5) pauses incremental reviews after
  N reviewed commits — relevant for long-lived bottom branches that accumulate
  rebase pushes; `@coderabbitai resume` un-pauses [auto-review].
- **`@coderabbitai autofix stacked pr`** opens a *new stacked PR* with CodeRabbit's
  fixes layered on top of the current PR (instead of committing to the branch) —
  itself a stacked-PR producer. Not supported on Azure DevOps [autofix][autofix-blog].

---

## 4. `.coderabbit.yaml` options that matter for stacks

| Key (under `reviews:`) | Type | Default | Why it matters for stacks |
|---|---|---|---|
| `auto_review.base_branches` | array of **regex** | `[]` (default branch only) | **The critical one.** Must match intermediate stack-branch names or those PRs get no auto-review [6][7][12]. |
| `auto_review.drafts` | bool | `false` | Stacks live as drafts while in flight; `false` defers review until `gh pr ready`. Set `true` only if you want early feedback per link [auto-review]. |
| `auto_review.auto_incremental_review` | bool | `true` | Re-reviews each push. After a `--update-refs` force-push the intermediate branches change, re-triggering reviews — expected [7]. |
| `auto_review.auto_pause_after_reviewed_commits` | int | `5` | Long-lived bottom branches accumulate rebase pushes; bump or set `0` to keep reviewing [auto-review]. |
| `auto_review.ignore_title_keywords` | array of string | `[]` | Add `"[skip review]"`/`"WIP"` to suppress review on in-progress upper links [auto-review]. |
| `path_filters` | array of **glob** (minimatch) | `[]` | Exclude generated/process artifacts so they don't inflate any PR's diff. `!`-prefix excludes [path-filters]. |
| `path_instructions` | array of `{path: glob, instructions}` | `[]` | Per-area review guidance — keeps focused PRs reviewed by focused rules [path-instructions]. |

### Config-source precedence (so a stacked PR's review is predictable)

Sources **do not merge** by default; highest wins [config-overview]:
`Global overrides (org UI)` → repo `.coderabbit.yaml` → central `coderabbit` repo →
repo UI settings → org UI settings → schema defaults. A YAML syntax error makes the
**entire file silently ignored** — verify with `@coderabbitai configuration`
[config-overview][coderabbit-common-errors].

### Recommended edit for this repo

The current `base_branches` uses `"wave/.*"`, which matches `wave/foo` but **not**
`wave3/...` (the `§5` convention). Broaden it so stack branches are reviewed:

```yaml
reviews:
  auto_review:
    enabled: true
    drafts: false
    base_branches:
      - main
      - "wave/.*"          # existing wave root branches: wave/<topic>
      - "wave\\d+/.*"      # NEW: stack links wave3/01-schema, wave3/02-resolver, ...
    ignore_title_keywords:  # NEW: let WIP upper links sit un-reviewed
      - "WIP"
      - "[skip review]"
```

(If you adopt the simpler `am/wave3/...` naming from §5, use `"am/.*"` instead.)
Everything else in the existing file — `profile: chill`, the `path_filters`
excluding `dist/`, `.mulch/`, `docs/research/`, etc., and the ADR-aware
`path_instructions` for `src/**`, `src/adapters/**`, `test/**` — already supports
focused stacked reviews and needs no change.

---

## 5. Concrete branch/PR-stack convention for agent-manager's wave backlog

The repo's backlog is **wave-based** (CLAUDE.md references "iter4 Wave B/C/D",
"plan-in-waves" in `deep-work-loop`, and Seeds `sd plan` decomposition into child
seeds). Map a wave onto a stack like this.

### 5.1 Branch naming

```
wave<N>/<NN>-<slug>
```
- `<N>` — wave number (matches the Seeds plan / `sd plan` id when possible).
- `<NN>` — two-digit position **in the stack**, bottom = `01`. Ordering = review
  order = merge order.
- `<slug>` — the touched surface, ideally one of the CLAUDE.md layers
  (`schema`, `resolver`, `config`, `cli`, `mcp`, `adapter-<tool>`, `wiki`, `web`).

Example (Seeds plan `pl-4eec`, "ProfileVariant" — ADR-0036):
```
wave4/01-schema-variant       base: main
wave4/02-resolver-variant     base: wave4/01-schema-variant
wave4/03-mcp-variant-tools    base: wave4/02-resolver-variant
wave4/04-cli-profile-variant  base: wave4/03-mcp-variant-tools
```

### 5.2 The two invariants that keep each PR independently reviewable

1. **One layer per link.** A link touches one CLAUDE.md layer (one `src/core/*`
   file, or one adapter dir, or the CLI command). If a link touches two layers,
   split it — that's the whole reason to stack.
2. **Tests ride with their code.** Per the repo's TDD convention, the test file
   lives in the *same* PR as the code it covers (`test/core/schema.test.ts` in the
   schema link). CodeRabbit's `test/**` `path_instructions` then reviews the test
   against the right rules in the same focused diff.

### 5.3 A no-dependency helper script (drop in `scripts/`)

```bash
#!/usr/bin/env bash
# scripts/stack-sync.sh — rebase the whole current wave stack onto origin/main
# and push every link. Run from the TOP branch of the stack.
set -euo pipefail
git config rebase.updateRefs true
git config rerere.enabled true
git fetch origin
top="$(git rev-parse --abbrev-ref HEAD)"
git rebase origin/main --update-refs            # cascades all intermediate refs
# push every wave<N>/* branch this rebase touched:
mapfile -t branches < <(git for-each-ref --format='%(refname:short)' "refs/heads/${top%%/*}/")
git push --force-with-lease origin "${branches[@]}"
echo "Synced & pushed: ${branches[*]}"
```

### 5.4 End-to-end wave lifecycle

```bash
# 0. claim the wave's seeds
sd update pl-4eec --status in_progress

# 1. build the stack (one --draft PR per link, §1.2), recording gh-merge-base (§1.3)

# 2. iterate: address review on any link, then resync the whole stack:
bash scripts/stack-sync.sh        # §5.3 — rebases + force-pushes all links

# 3. CodeRabbit auto-reviews each link against its own base (needs §4 base_branches)
#    — manual nudge if needed: gh pr comment <n> --body "@coderabbitai review"

# 4. merge bottom-up; GitHub retargets the rest to main automatically:
for n in 101 102 103 104; do
  gh pr ready "$n"
  gh pr merge "$n" --squash --delete-branch --auto   # --auto waits for CI (ci.yml)
done

# 5. close the seeds
sd close <ids> && sd sync
```

### 5.5 CI / branch-protection interplay

- `.github/workflows/ci.yml` runs on each PR. With `--auto`, `gh pr merge` waits
  for required checks — so a stacked PR only lands when `bun test` (2906 tests),
  `lint`, and `typecheck` pass on *its own* focused diff.
- Enable **"Automatically delete head branches"** in repo settings so bottom-up
  merges trigger GitHub's retarget-and-cleanup for the links above
  [github-retarget-changelog][so-74024491].
- Optionally **"Require branches to be up to date before merging"** — but note this
  forces a rebase/`update-branch` of the next link after each merge, which the §5.4
  loop already does via `--auto` re-runs [zonca-automerge].

### 5.6 PR body convention (machine + human legible)

```
Stack 2/4 — wave4 ProfileVariant
Depends on #101 (schema). Blocks #103 (mcp).
Seeds: sd-... | ADR-0036
```
A consistent `Stack i/N` + `Depends on #` line lets reviewers (and CodeRabbit's
summary) understand position, and mirrors Seeds' forward-`blocks` semantics.

---

## 6. Pitfalls checklist

- [ ] **Intermediate PR not reviewed?** Its base branch isn't matched by
  `auto_review.base_branches` (regex, not glob). See §4 [6][12].
- [ ] **Config edit not applied to a stacked PR?** CodeRabbit reads
  `.coderabbit.yaml` from the **base branch**; land config at the bottom / on
  `main` [coderabbit-common-errors].
- [ ] **`--update-refs` didn't move a branch?** It's checked out in another
  worktree — Git refuses to update those. Common with the repo's `git worktree`
  flow [1][9].
- [ ] **Force-push clobbered a teammate?** Always `--force-with-lease`, never bare
  `--force` [nutrient][6].
- [ ] **Whole `.coderabbit.yaml` ignored?** A single YAML syntax error silently
  voids the file. Verify with `@coderabbitai configuration` [coderabbit-common-errors].
- [ ] **Reviewing generated junk?** Confirm `path_filters` excludes it (this repo
  already excludes `dist/`, `.mulch/`, `.seeds/`, `docs/research/`, etc.).
- [ ] **`gh pr create` errors "already a PR"?** Use `gh pr edit <n> --base ...`
  to retarget an existing PR instead [cli/cli#5792].

---

## Sources

1. GitHub CLI manual — `gh pr update-branch` — https://cli.github.com/manual/gh_pr_update-branch
2. GitHub CLI manual — `gh pr merge` — https://cli.github.com/manual/gh_pr_merge
3. GitHub CLI manual — `gh pr create` (`--base`, `--head`, `gh-merge-base`) — https://cli.github.com/manual/gh_pr_create
4. `gh pr ready` / draft behavior — https://cli.github.com/manual/gh_pr_ready
5. Substack — Stacked PRs with `git rebase --onto` / `--update-refs` — https://substack.com/home/post/p-143436429
6. CodeRabbit docs — auto-review (`base_branches` semantics, regex, default-branch) — https://docs.coderabbit.ai/configuration/auto-review
7. CodeRabbit docs — FAQ (review triggering, primary-branch detection) — https://docs.coderabbit.ai/faq
8. cli/cli #2693 — "Support stacked-diffs workflow with `gh pr create`" — https://github.com/cli/cli/issues/2693
9. Adam Johnson — "Rebase stacked git branches with `--update-refs`" — https://adamj.eu/tech/2022/10/15/how-to-rebase-stacked-git-branches/
10. Graphite docs — CLI quick start / stacking — https://graphite.com/docs/cli-quick-start
12. `spr` (commit→PR mapping, synthetic base branch) — https://github.com/ejoffe/spr ; DeepWiki spacedentist/spr
13. `ghstack` — https://github.com/ezyang/ghstack
17. Dave Pacheco — "My workflow for stacked PRs on GitHub" — https://www.davepacheco.net/blog/2025/stacked-prs-on-github
18. Graphite docs — create / submit PRs, "Merge N" — https://graphite.com/docs/create-submit-prs
- `path_filters` / `path_instructions` reference — https://docs.coderabbit.ai/reference/yaml-template ; https://docs.coderabbit.ai/guides/review-instructions
- CodeRabbit config precedence — https://docs.coderabbit.ai/guides/configuration-overview
- CodeRabbit Autofix (`autofix stacked pr`) — https://docs.coderabbit.ai/finishing-touches/autofix ; https://coderabbit.ai/blog/you-don-t-need-to-implement-that-autofix-will
- CodeRabbit common errors (config read from base branch; base_branches fix) — https://github.com/jeremylongshore/claude-code-plugins-plus-skills/blob/main/plugins/saas-packs/coderabbit-pack/skills/coderabbit-common-errors/SKILL.md
- andrewlock — stacked branches with `--update-refs` — https://andrewlock.net/working-with-stacked-branches-in-git-is-easier-with-update-refs/
- Andrew Lock — working with stacked branches (`--onto`, rerere) — https://andrewlock.net/working-with-stacked-branches-in-git-part-1/
- Nutrient — handling stacked PRs (`--force-with-lease`, `rerere`) — https://nutrient.io/blog/how-to-handle-stacked-pull-requests-on-github
- michaelagreiler — Stacked pull requests (review direction, base diff) — https://www.michaelagreiler.com/stacked-pull-requests/
- GitHub Changelog — Pull Request Retargeting (2020) — https://github.blog/changelog/2020-05-19-pull-request-retargeting/
- SO 74024491 — retarget on base-branch merge/delete — https://stackoverflow.com/questions/74024491/
- codetinkerer — stacked branches with vanilla Git ("don't, unless…") — https://www.codetinkerer.com/2023/10/01/stacked-branches-with-vanilla-git.html
- cli/cli #5792 — `gh pr create` and existing PRs — https://github.com/cli/cli/discussions/5792
- zonca — auto-merge after Actions pass — https://www.zonca.dev/posts/2025-10-20-github-actions-auto-merge/
