# agent-manager (`am`) — Claude Code instructions

> **Canonical project documentation lives in [`AGENTS.md`](AGENTS.md).**
>
> agent-manager's entire reason for existing is that every AI tool stores the
> same information in a different file. We refuse to do that to our own repo:
> there is **one** agent-instruction document, [`AGENTS.md`](AGENTS.md), and it
> is the single source of truth for the vision, the six pillars, the
> architecture, the directory layout, the tech stack, the CLI surface, the key
> design decisions, and the "how to add an adapter / CLI command / MCP tool /
> schema change" guides.
>
> **Read [`AGENTS.md`](AGENTS.md) first.** Do not duplicate its content here —
> if a fact about the project changes, edit `AGENTS.md`, not this file. This
> file carries only Claude-Code-specific session tooling (below), which is
> managed by `ml` / `sd` / `cn` and regenerated automatically.

## Git Commit Style

Follow the existing pattern: `feat:`, `fix:`, `test:`, `docs:`, `refactor:` prefix followed by a concise description. No attribution lines or co-author tags.

## Before you start / before you ship (pointers — details in AGENTS.md)

- **Vision is the yardstick.** Read AGENTS.md "North star" and weigh every change
  against it: the git-backed superset that CLI+UI both operate on, profiles that
  scope **access** at runtime (ADR-0055), inside-and-outside-agent workflows, for
  an individual dev. (Not duplicated here — it lives in AGENTS.md by design.)
- **Secret hygiene.** Run `bunx lefthook install` once per clone (the `prepare`
  script does this on `bun install`). Pre-commit runs betterleaks over staged
  changes; CI enforces the same scan as a hard gate. Deliberate redaction-test
  fixtures are allowlisted in `.betterleaksignore` — keep it tight. Never commit a
  real credential.
- **PR review = two layers.** Before pushing, review the diff locally with codex
  and address what it finds. After the PR is open, **act on CodeRabbit's comments**
  — fix the real ones, reply/resolve the rest — before merge. See AGENTS.md
  "How We Work §4".

<!-- mulch:start -->
## Project Expertise (Mulch)
<!-- mulch-onboard:v0.10.0 -->

This project uses [Mulch](https://github.com/jayminwest/mulch) v0.10.0 for structured expertise management.

**At the start of every session**, run:
```bash
ml prime
```

Injects project-specific conventions, patterns, decisions, failures, references, and guides into
your context. Run `ml prime --files src/foo.ts` before editing a file to load only records
relevant to that path (per-file framing, classification age, and confirmation scores included).

For monolith projects where dumping every record wastes context, set
`prime.default_mode: manifest` in `.mulch/mulch.config.yaml` (or pass `--manifest`) to emit a
quick reference + domain index. Agents then scope-load with `ml prime <domain>` or
`ml prime --files <path>`.

**Before completing your task**, record insights worth preserving — conventions discovered,
patterns applied, failures encountered, or decisions made:
```bash
ml record <domain> --type <convention|pattern|failure|decision|reference|guide> --description "..."
```

Evidence auto-populates from git (current commit + changed files). Link explicitly with
`--evidence-seeds <id>` / `--evidence-gh <id>` / `--evidence-linear <id>` / `--evidence-bead <id>`,
`--evidence-commit <sha>`, or `--relates-to <mx-id>`. Upserts of named records merge outcomes
instead of replacing them; validation failures print a copy-paste retry hint with missing fields
pre-filled.

Run `ml status` for domain health, `ml doctor` to check record integrity (add `--fix` to strip
broken file anchors), `ml --help` for the full command list. Write commands use file locking and
atomic writes, so multiple agents can record concurrently. Expertise survives `git worktree`
cleanup — `.mulch/` resolves to the main repo.

`ml prune` soft-archives stale records to `.mulch/archive/` instead of deleting them; pass
`--hard` for true deletion. Restore an archived record with `ml restore <id>`. Do not read
`.mulch/archive/` directly — those records are stale by definition. If you need historical
context, run `ml search --archived <query>`.

### Before You Finish

If you discovered conventions, patterns, decisions, or failures worth preserving during
this session, record them before closing:

```bash
ml learn                                                                    # see what files changed
ml record <domain> --type <convention|pattern|failure|decision|reference|guide> --description "..."
ml sync                                                                     # validate, stage, commit
```

Skip if no insight surfaced. Unrecorded learnings are lost; ritual filler records are also noise.
<!-- mulch:end -->

<!-- seeds:start -->
## Issue Tracking (Seeds)
<!-- seeds-onboard:v0.4.5 -->
<!-- seeds-onboard-schema:4 -->

This project uses [Seeds](https://github.com/jayminwest/seeds) v0.4.5 for git-native issue tracking.

**At the start of every session**, run:
```
sd prime
```

This injects session context: rules, command reference, and workflows. Pass `--format json|compact|markdown|plain|ids` on any command for agent-friendly output.

**Quick reference:**
- `sd ready` — Find unblocked work
- `sd search <query>` — Full-text search across titles + descriptions
- `sd create --title "..." --type task --priority 2` — Create issue
- `sd update <id> --status in_progress` — Claim work
- `sd close <id>` — Complete work
- `sd dep add <id> <depends-on>` — Add dependency between issues
- `sd sync` — Sync with git (run before pushing)

### Planning
Use `sd plan` when work is large or ambiguous enough that an LLM benefits from structured decomposition. Submit spawns one child seed per step; `step.blocks` uses forward semantics (step i with `blocks: [j]` means step i blocks step j, and step j gets step i's id in its `blockedBy`).

- `sd plan templates` — List built-ins (`feature`, `bug`, `refactor`) plus custom templates
- `sd plan prompt <seed-id>` — Emit a structured prompt the LLM fills in
- `sd plan submit <seed-id> --plan <file>` — Validate + spawn child seeds
- `sd plan show <pl-id>` — View sections, children, sub-plans
- `sd plan outcome <pl-id> --result success|partial|failure` — Record outcome (storage-only)
- `sd plan review <pl-id> --by <name>` — Record reviewer (informational)

### Before You Finish
1. Close completed issues: `sd close <id>`
2. File issues for remaining work: `sd create --title "..."`
3. Sync and push: `sd sync && git push`
<!-- seeds:end -->

<!-- canopy:start -->
## Prompt Management (Canopy)
<!-- canopy-onboard-v:2 -->

This project uses [Canopy](https://github.com/jayminwest/canopy) for git-native prompt management.

**At the start of every session**, run:
```
cn prime
```

This injects prompt workflow context: commands, conventions, and common workflows.

**Quick reference:**
- `cn list` — List all prompts
- `cn render <name>` — View rendered prompt (resolves inheritance)
- `cn emit --all` — Render prompts to files
- `cn update <name>` — Update a prompt (creates new version)
- `cn sync` — Stage and commit .canopy/ changes

**Do not manually edit emitted files.** Use `cn update` to modify prompts, then `cn emit` to regenerate.

**Mulch metadata:** Prompts can declare expertise dependencies via `mulch.prime.domains`, `mulch.prime.files`, `mulch.budget`, `mulch.on_empty`, plus a top-level `extends_mulch` flag (override-by-default; merge with parent when `true`). Canopy never shells out to `ml` — `cn render --json` surfaces the resolved declaration in a top-level `mulch` field for consumers to act on. See SPEC.md "Mulch Metadata".
<!-- canopy:end -->
