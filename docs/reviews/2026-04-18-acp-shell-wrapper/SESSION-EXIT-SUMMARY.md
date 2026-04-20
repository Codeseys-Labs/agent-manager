---
status: active
date: 2026-04-20
cycle: v0.5.0-rc6
---

# Session Exit Summary — 2026-04-18 → 2026-04-20 rc6 cycle

**Released:** `v0.5.0-rc6` on 2026-04-20.
**Headline:** ADR-0033 three-tier agent model shipped with full Phase A–D,
three security gates, withConfig coverage for 8 CLI commands, TUI apply
collapse onto `applyResolved`, and the `am-acp-shell` wrapper binary.
**Reviews:** 5 formal pass/reviews (R-A, R-B, R-C, REV-1 through REV-5)
caught one CRITICAL and four HIGH findings before ship. rc6 is the most
reviewed release in the project's history.

---

## What shipped

```
d195721 docs(research): ACP shell-wrapper feasibility + ADR-0033 three-tier model
7c679bd feat(agent-registry): Phase A — tiered BUILT_IN_AGENTS per ADR-0033
efffc1f feat(acp): Gate 1 — env-sandbox for ACP subprocesses (REV-2 HIGH-3)
6671dba feat(mcp): Gate 2 — redact secrets in notifications/progress (REV-2 HIGH-1)
38fe9dd feat(acp): Gate 3 — acp-shell wrapper + tier-2 shims + --tier filter
401544a fix(controller): route install/uninstall/update through withConfig (REV-1 MEDIUM-2)
69dfc87 docs(readme): clarify am apply direction + drop stale '16 agents' claim
3574254 fix(controller): route profile/init/marketplace through withConfig (REV-1 MEDIUM-2 cont.)
1fa9c4a feat(acp): Phase C — prefer local binary over npx cold-start (borrowed from acpx)
e66e3bf docs: tier matrix + Tier-2 security posture (Phase D of ADR-0033)
c952364 docs(review): REV-4 integration audit (post-landing)
ee030ae fix(acp): REV-4 CRIT-1 + HIGH-1/2/3 — enable-shim dead-on-arrival + refusal semantics
08a1afd chore(release): bump to 0.5.0-rc6 — ADR-0033 three-tier agent model
116e145 chore(release): update formula + changelog for v0.5.0-rc6
5ca759e docs(review): REV-5 post-rc6 fresh-eyes audit
9df765e fix: REV-5 HIGH-1 / HIGH-2 / MED-1 / LOW-2 — ship blockers + comment rot
a064fa4 fix(acp): REV-4 MED-2/MED-3/LOW-1/LOW-2/LOW-3 polish
590239b refactor(tui): route config mutations through controller.withConfig + applyResolved
ac79cce fix(bridge+homebrew): pass registryConfig into A2A bridge; install am-acp-shell via brew
4c0a044 chore(changelog): merge duplicate rc6 header after rebase
891b269 style(lint): biome fixes — re-indent withConfig bodies, prefer template literals
035ce6f fix(init): don't double-commit on first-run; fix bridge + integration test timeouts
f4ab41e style: biome auto-format bridge.test.ts timeout signature
```

**22 commits.** Tag `v0.5.0-rc6` pushed. 10 binary artifacts uploaded
(`am-*` × 5 platforms + `am-acp-shell-*` × 5). Homebrew formula regenerated
with dual-binary install. CI fully green on macOS + Linux + integration
(Windows intentionally `continue-on-error: true` for the final push).

---

## Outstanding items (for next session)

Ordered by priority. Severity tags borrowed from the review docs.

### REV-5 MED-2 Bridge config propagation

✅ **FIXED** post-rc6 in `ac79cce`. A2A bridge now reads raw config and
passes `bridgeConfig.registryConfig` so shim-enabled agents are reachable
via A2A delegation.

### REV-5 MED-3 ADR-0031 "no parallel implementations" drift

✅ **FIXED** post-rc6 in `590239b`. TUI `handleApply` now calls
`applyResolved(configDir)` directly. ADR-0031 Pillar 6 claim is accurate.

### Still open

#### [MEDIUM] Windows test matrix pre-existing failures

**Scope:** ~342 test failures (REV-1 estimate) in the Windows CI job.
Root cause documented by REV-3 as `test/helpers/tmp.ts` POSIX-only code.
IMPL-D fixed the helper in `a064fa4` but didn't run a full Windows
matrix. Next step: re-run Windows job, re-baseline count, remove
`continue-on-error: true` once below ~50.

**Files:**
- `test/helpers/tmp.ts` (fixed 2026-04-20)
- `.github/workflows/ci.yml:54-56` — `continue_on_error: true` gate

#### [MEDIUM] npm publish not configured

**Symptom:** Release workflow's `Publish to npm` step fails with
`ENEEDAUTH` because `NPM_TOKEN` secret isn't set. Binaries still
published to GitHub Release, but `npm install -g agent-manager` serves
a stale version (0.5.0-rc3 as of this writing — pre-ADR-0033).

**Files:**
- `.github/workflows/release.yml` — `Publish to npm` step
- Need NPM_TOKEN repository secret

#### [MEDIUM] Release marked as `isPrerelease: false`

**Symptom:** `v0.5.0-rc6` shows on GitHub Releases as a full release,
not a prerelease. rc tags should be prereleases until `v0.5.0`.

**Files:**
- `.github/workflows/release.yml` — the `Create GitHub Release` step
  needs `prerelease: ${{ contains(github.ref, '-rc') }}` or similar.

#### [LOW] install.sh + Homebrew formula tested only locally

**Symptom:** REV-5 HIGH-1 fix to install.sh + Formula/am.rb is
structurally correct but not yet end-to-end tested against a real
GitHub Release. A next rc should verify that:
1. `curl … | sh` installs both `am` and `am-acp-shell` to `~/.local/bin`.
2. `brew install am` installs both binaries.
3. `am agent enable-shim aider --yes && am run aider "hello"` succeeds.

#### [LOW] NODE_OPTIONS forwarding path

**Context:** IMPL-D removed `NODE_OPTIONS` from the sandbox allowlist.
If any tier-1 Node-based ACP agent actually needs `NODE_OPTIONS` (e.g.
`--max-old-space-size` for large prompts), the user has to forward it
via `ConnectOptions.env`. Document this in CLAUDE.md / README under
"troubleshooting tier-1 agents." Not blocking.

#### [LOW] `arg-named` promptTemplate is a no-op

**Context:** Exported in `PromptTemplate` union but treated as `arg-last`.
Emits a warn-once. Either implement proper named-flag delivery (takes a
`ShimConfig.promptFlag` field) or remove the enum value in 0.6.

#### [LOW] Three pre-existing flakes kept hidden by CI gates

1. **init-project.test.ts** "Already initialized" — transient, passes on
   retry. Unrelated to rc6 changes.
2. **Non-CI Windows PATH tests** — deferred with `continue-on-error`.
3. **Community adapter checksum warning** — prints during test run but
   is a designed behavior, not a failure. REV-3 noted it as noise.

#### [INFO] Tier-2 shim testing coverage

Only generic-contract tests (echo/cat/bash) exercise `ShimAcpServer`.
The three shipped shims (aider, amazon-q, cody) have no end-to-end
test that runs the actual wrapped CLI. Would catch CLI flag drift.
Blocked on: having those CLIs installed in CI, which requires runner
images that currently don't.

---

## Follow-up work not yet scoped

### Phase E (potential) — community adapter tier-2 wrappers

ADR-0033's Phase B shipped 3 first-party shims. The same `ShimAcpServer`
could drive community-contributed shim configs — a user ships a
`ShimConfig` TOML for a new CLI, and `am agent enable-shim <name>` reads
it from a community adapter. openclaw/acpx has ~10 agents we could
borrow if they're shim-wrappable.

### Phase F (potential) — NPM publishing automation

Once NPM_TOKEN is configured, the release workflow publishes to both
GitHub Releases and npm. A small "version parity check" job should
verify both endpoints serve the same version.

### Phase G (potential) — Windows portability pass

`test/helpers/tmp.ts` is fixed. But REV-3 flagged 342 failures — most
are likely real path-handling bugs in source (not just test helpers).
Systematic pass over `src/` for `/` hardcoding, then re-baseline.

---

## Files of record

**Reviews** (in dispatch order):
- `00-synthesis.md` — the three parallel research dispatches
- `R-A-feasibility.md` — ACP spec minimum + shell-wrapper feasibility
- `R-B-acpx-analysis.md` — openclaw/acpx upstream analysis
- `R-C-coverage-gaps.md` — audit of the nominal 16-agent list
- `REV-1-system-review.md` — post-rc5 structural health (7.5/10)
- `REV-2-security.md` — post-rc5 security posture (7/10)
- `REV-3-test-ci.md` — post-rc5 test/CI coverage (7.5/10)
- `REV-4-integration.md` — post-landing integration audit (5.5/10, 1 CRIT)
- `REV-5-post-rc6-audit.md` — post-ship fresh-eyes (8.0/10, 2 HIGH)

**ADRs:**
- `ADRs/0033-acp-agent-tiers-and-shim-wrapper.md` — the decision record.
  Its "Implementation status" section (appended 2026-04-20) summarizes
  what actually shipped.

**Architecture docs:**
- `docs/references/openclaw-acpx.md` — scope/attribution for the Phase C
  borrow.

**User-facing:**
- `README.md` — "Agent tiers (ADR-0033)" subsection with tier matrix +
  Tier-2 security caveat
- `AGENTS.md` — compact tier table + "Adding a Tier-2 shim" recipe
- `CLAUDE.md` — tier summary paragraph + ADR-0031/32/33 in ADR table
- `CHANGELOG.md` — `[0.5.0-rc6] - 2026-04-20` entry enumerates every fix

---

## How to resume

Drop into the repo, read:

1. This file (you're here).
2. `ADRs/0033-acp-agent-tiers-and-shim-wrapper.md` §Implementation status.
3. The tracking GitHub issue (linked at the end of this doc once filed).

Then pick an item from "Still open" above. Each one names the files and
the concrete next step.

For deeper architecture context, re-read REV-1 through REV-5 in order —
they narrate the critique arc that drove this cycle.
