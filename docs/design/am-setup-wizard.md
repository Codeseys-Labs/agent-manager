# Design: `am setup` first-run wizard

Implements [ADR-0053](../../ADRs/0053-am-setup-first-run-wizard.md). Grounded in
`docs/research/backlog-setup-wizard-ux.md`.

## Goal

A single guided, resumable, non-interactive-capable command that takes a stranger
from "just installed `am`" to "native configs written + green health check" without
reading source.

## File plan

- NEW `src/commands/setup.ts` — the orchestrator (citty `defineCommand`).
- EDIT `src/cli.ts` — register `setup: () => import("./commands/setup").then(m => m.setupCommand)`.
  (This is the ONLY hub-file edit; per INTEGRATION-PLAN.md, Wave 3 owns the cli.ts subcommand addition.)
- NEW `test/commands/setup.test.ts` — drive `setupCommand.run()` with clack mocked and
  `AM_CONFIG_DIR` pointed at a temp dir; cover interactive happy path, `--yes`
  non-interactive, `--json`, `--from` clone, and idempotent re-run.
- Reuse (do not duplicate): `getDetectedAdapters`, `runMergePipeline`/import-auto from
  `src/commands/import.ts`, `applyResolved` + dry-run envelope from controller/apply,
  doctor's check runner, `generateKey`/`saveKey`, `addRemote`, `withConfig`.

## CLI surface

```
am setup [--from <url|shorthand>] [--ssh] [--tools a,b,c] [--profile <name>]
         [--no-apply] [--yes] [--non-interactive] [--json] [--force] [--quiet] [--verbose]
```

Mode resolution (step 0):
```ts
const interactive =
  Boolean(process.stdin.isTTY) && !args.yes && !args["non-interactive"] && !args.json && !process.env.CI;
```
Non-interactive → resolve every value from flag > env > existing config > default;
on a required value with no source, `error(...)` + non-zero exit (never hang).

## Step orchestration

(See ADR-0053 for the narrative; this is the implementer's checklist.)

1. **Probe** — `resolveConfigDir()`, `tryReadConfig`, `getDetectedAdapters()`,
   remote/key presence. Build a `note()` summary. Each subsequent step marks
   itself `new | skip | re-run`.
2. **Fresh vs clone** — if `--from`/confirm: `guessRepoUrl(shorthand,{ssh})` →
   `initRepo` (if needed) + `addRemote` + `pull` under a `spinner`. Else
   `withConfig(configDir, ..., { noCommit: true })` writing the default `Config`
   (mirror `init.ts`). If config exists && !`--force` → merge additively, never clobber.
3. **Secrets** — AES legacy only for v1 (age fenced). `select`: generate key /
   enter passphrase / skip. Print key path + "save this; lives outside git, gitignored".
4. **Tools** — `multiselect`, `initialValues = detectedAdapterNames`. Persist selection.
5. **Profile** — `text` default `"default"`, `initialValue = current default_profile`.
   Always materialize an explicit profile so apply doesn't fail-open the whole catalog.
6. **Apply** — dry-run envelope preview → confirm → `applyResolved`. `--no-apply` skips.
7. **Health** — run doctor checks; `outro` green or per-check `log.error` + `exitCode=1`.

## Idempotency rules

- Re-running on a configured machine is a non-destructive **review**: prefill
  `initialValue` from current config; all-Enter changes nothing.
- Never bail with "Already initialized" (the current `am init` failure mode) — probe
  and resume instead.
- `--force` required to overwrite an existing non-default profile or a drifted apply.

## clack version caution

`@clack/prompts ^0.9.1` is pinned. `intro/outro/text/password/confirm/select/`
`multiselect/group/spinner/note/log/cancel/isCancel/tasks` are available. Verify
`spinner({indicator})`, `note(...,{format})`, `confirm({vertical})`, `selectKey`
against the installed version before use; degrade gracefully if absent.

## Acceptance criteria

- `am setup --yes --json` runs end-to-end non-interactively in a temp `AM_CONFIG_DIR`
  and emits a JSON doctor result; exit code reflects health.
- `am setup --from <local-bare-repo>` clones + applies.
- Interactive path (clack mocked) covers detect → import → key → profile → apply → doctor.
- Re-run on a configured dir does not clobber and does not error out.
- `bun run lint`, first-party `tsc` clean, new tests green.

## Dependencies

- Wave 1: ZodError UX (so a bad config surfaces readably mid-wizard) + default-profile
  passthrough warning.
- Wave 2: secrets fenced to AES (the wizard must not offer the age path until its
  apply runtime is fixed).
- Therefore Wave 3 rebases onto main AFTER waves 1 and 2 merge.
