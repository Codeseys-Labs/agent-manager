---
status: accepted
date: 2026-05-31
---

# ADR-0053: `am setup` — first-run setup wizard

> **Status note (accepted):** The wizard shipped in #19 (`src/commands/setup.ts`,
> `test/commands/setup*.test.ts`). The brownfield-import step (step 4b below) was
> wired in a follow-up: the wizard now invokes the existing `am import auto`
> engine (ADR-0028) via a `runImport` orchestration call rather than
> reimplementing detection/merge, gated by `--import`/`--no-import` for a
> deterministic non-interactive contract, and skipped after a `--from` clone (the
> cloned catalog is authoritative). The age secrets backend remains fenced to AES
> per the Wave 2 / ADR-0042 fence.

## Context

The production-readiness audit (`docs/audit/assessment-2026-05-31/`) found that the
single biggest gap between agent-manager-as-marketed and agent-manager-as-built is
onboarding. The README dramatizes an `am init` that detects tools, prompts
"Import all? [Y/n]", merges servers, and scans secrets — but the real `am init`
(`src/commands/init.ts`) only creates the config repo, optionally generates a key,
optionally sets a remote, and then *prints* `Run \`am import auto\``. There is no
guided flow, no clone-from-remote path for a new machine, and the interactive
prompts are not driveable non-interactively (no `--yes`/`--json` contract).

Every primitive a wizard needs already exists and is tested: `getDetectedAdapters()`,
the `am import auto` engine (ADR-0028), `applyResolved` + the ADR-0038 dry-run
envelope, `am doctor`'s `Check[]` runner, `generateKey`/`saveKey`, `addRemote`, and
`am install`'s TTY-guarded clack pattern. The missing piece is an **orchestration
layer**, not new capability.

Research (`docs/research/backlog-setup-wizard-ux.md`) surveyed how `gh auth login`,
`aws configure`/`configure sso`, `gcloud init`, `firebase init`, `supabase init`,
`vercel`, and `chezmoi init` structure guided onboarding. The dominant pattern is
**decompose, don't monolith**: setup is a thin orchestrator over independently
re-runnable steps, every prompt has a non-interactive twin, re-runs are
non-destructive (probe → merge → confirm-before-clobber), and the run ends on a
green health check.

## Decision

Add a new top-level command **`am setup`** that orchestrates first-run configuration
end-to-end. It does NOT replace the granular commands (`am init`, `am import`,
`am apply`, `am doctor`) — it sequences them, and each remains independently usable.

**Step sequence** (full spec in `docs/design/am-setup-wizard.md`):

0. **Preflight & mode resolution.** `interactive = process.stdin.isTTY && !--yes &&
   !--non-interactive && !--json && !CI`. Non-interactive → defaults-or-error
   (never hang; emit a structured error on a required value with no source).
1. **State probe (idempotency).** Reuse doctor/status checks to detect existing
   config, key, remote, detected adapters; show a summary so a re-run is a review.
2. **Fresh vs clone-from-remote.** `am setup --from <url|shorthand>` clones an
   existing catalog into the config dir (chezmoi-style URL guessing, `--ssh`), then
   applies — the missing "new machine" path. Otherwise create/merge the default
   config via `withConfig({ noCommit: true })` mirroring `am init`'s first-run path.
3. **Secrets.** Default to the **legacy AES backend** (ADR-0012) — the age backend
   (ADR-0042) is fenced until its apply-path runtime is fixed and integration-tested
   (Wave 2 / ADR-0042 status). Offer generate-key / enter-passphrase / skip.
4. **Tool selection.** `multiselect` preselected with detected adapters.
4b. **Brownfield import.** Run the existing `am import auto` engine (ADR-0028) to
   pull the detected tools' native configs INTO the catalog so a stranger's
   pre-existing MCP servers survive the round-trip instead of being clobbered by
   the subsequent apply. Interactive: confirm first (default yes). Non-interactive:
   import by default; `--no-import` opts out. Skipped when no tools are detected
   (nothing to import) and after a `--from` clone (the cloned catalog is
   authoritative — importing the local machine's configs would pollute it). The
   wizard invokes the import command's `run` as a library call; it does NOT
   duplicate detection or merge logic.
5. **Profile.** Create an explicit default profile (defuses the default-passthrough
   surprise where an absent profile exports the whole catalog to every tool).
6. **Apply.** Dry-run preview (ADR-0038 envelope) → confirm → `applyResolved`;
   `--no-apply` to stop short. Per-target opt-in respects Wave 1's apply confirmation.
7. **Green health check.** Reuse `am doctor`'s `Check[]`; end on `outro` (success)
   or per-check `log.error` + non-zero exit (failure).

**Non-interactive contract:** `--yes`, `--non-interactive`, `--json`, `--from`,
`--tools`, `--profile`, `--no-import`, `--no-apply`, `--force`. Precedence
flag > env > existing config > default (matches ADR-0003). `--json` emits the
doctor `Check[]` result plus `cloned`/`imported`/`keyGenerated`/`applied` flags,
and the exit code reflects health. In `--json` mode the embedded import call runs
silently (json=false, quiet=true) so the wizard emits one authoritative payload.

`am init` is retained (and may print "for a guided setup, run `am setup`"). The wizard
is built on existing primitives; no core engine change is required beyond the Wave 1
ZodError-UX and default-profile-warning fixes it depends on.

## Consequences

### Positive

- Closes the headline onboarding gap; the README's promised flow becomes real.
- Adds the missing clone-from-remote ("new machine") path — pillar 1's core value.
- Fully scriptable (`--json`/`--yes`) for CI and dotfile bootstraps.
- Re-runnable and non-destructive; doubles as a repair tool (it ends on doctor).

### Negative

- A new ~300–400 LOC command + tests to maintain.
- Some surface overlap with `am init` (mitigated: init stays minimal; setup orchestrates).
- Depends on Wave 1 (ZodError UX so the wizard never shows a raw Zod dump) and
  Wave 2 (secrets fenced to AES) landing first.

### Neutral

- Uses clack primitives already pinned (`@clack/prompts ^0.9.1`); verify
  `spinner`/`tasks`/`note` options against the installed version before use.

## Alternatives Considered

1. **Expand `am init` in place instead of a new command.** Rejected: `init` is the
   low-level "make the repo" primitive; overloading it with a full wizard couples two
   concerns and breaks the decompose pattern that every surveyed tool follows.
2. **A TUI-only wizard (Silvery).** Rejected for v1: the clack flow works in any
   terminal and is trivially non-interactive-able; a TUI wizard is heavier and can't
   be driven headlessly. The TUI remains for ongoing management, not first-run.
3. **No wizard; just fix the README to describe the manual steps.** Rejected: the
   audit's bar is "a stranger gets value without reading source"; a 4-command manual
   sequence with no clone-from-remote path does not meet it.

## References

- `docs/research/backlog-setup-wizard-ux.md` — gh/aws/gcloud/firebase/chezmoi/clack patterns
- `docs/audit/assessment-2026-05-31/onboarding-and-wizard.md` — the gap analysis
- `docs/design/am-setup-wizard.md` — the full step-by-step design
- ADR-0028 (brownfield import), ADR-0038 (dry-run envelope), ADR-0040 (withConfig),
  ADR-0042 (age secrets — fenced for v1), ADR-0003 (config precedence)
