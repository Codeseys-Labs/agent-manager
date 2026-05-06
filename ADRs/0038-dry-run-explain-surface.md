---
status: accepted
date: 2026-05-02
accepted: 2026-05-05
---

# ADR-0038: Dry-Run / Explain Surface Pattern

## Context

The 2026-05-02 all-pillars review identified "no dry-run / no preview /
no explain" as the single most convergent theme across pillars:

- **Pillar 1:** `am apply --diff` and `--force` flags exist in the CLI
  surface but are NOT passed through to the apply pipeline
  (`src/commands/apply.ts:10-13`). Users cannot see what will change.
- **Pillar 3:** `am run <agent>` has no `--dry-run`. First visible action
  is spawning the subprocess.
- **Pillar 4:** `am marketplace install <plugin>` has no preview; manifest
  diff and existing-entry collision are invisible until after the fact.
- **Pillar 6:** TUI has no preview-before-apply for any mutating action.

Each is currently a separate problem. This ADR proposes **one convention**
that all four solve the same way.

The goal: for any `am` command that mutates the world (catalog, disk,
running processes, remote endpoints), provide a **`--dry-run` mode that
emits structured JSON describing the intended action without executing it.**

## Decision

### The convention

Every mutating command gains a `--dry-run` flag. In dry-run mode:

1. The command runs all validation and resolution (schema, secrets,
   variant resolution per ADR-0036, tier checks, permission-policy
   selection, etc.) EXACTLY as it would in live mode.
2. The command EMITS a structured explanation to stdout (JSON when
   `--json` is set; human-readable table otherwise).
3. The command DOES NOT spawn subprocesses, write files, make network
   calls, or mutate git state. Reads are fine; writes are not.
4. Exit code 0 when the intended action is valid, nonzero when
   validation/resolution fails (same as live mode would).

### Shared output shape

All `--dry-run` JSON responses include these fields:

```json
{
  "action": "run-agent" | "apply" | "import" | "marketplace-install" | ...,
  "would_do": [<structured steps>],
  "reads_only": true,
  "mutations_prevented": [<what would have been written/spawned>],
  "explanation": {
    <action-specific fields>
  }
}
```

Example — `am run claude --variant bedrock --dry-run "fix it"`:

```json
{
  "action": "run-agent",
  "would_do": [
    "resolve agent 'claude' variant 'bedrock'",
    "spawn subprocess via ACP",
    "send prompt and stream updates"
  ],
  "reads_only": true,
  "mutations_prevented": ["process spawn", "session file write"],
  "explanation": {
    "agent": "claude",
    "variant": "bedrock",
    "tier": "tier-1-native",
    "protocol": "acp",
    "command": "npx",
    "args": ["-y", "@agentclientprotocol/claude-agent-acp@latest"],
    "env_keys": ["PATH", "HOME", "CLAUDE_CODE_USE_BEDROCK", "AWS_PROFILE", "AWS_REGION"],
    "env_secrets_redacted": ["AWS_PROFILE=<redacted>"],
    "cwd": "/mnt/e/CS/github/agent-manager",
    "permission_policy": "auto-approve",
    "allowed_paths": ["/mnt/e/CS/github/agent-manager"]
  }
}
```

### What `--dry-run` does NOT do

- Does not probe external services (no `curl` to an A2A endpoint).
- Does not validate that the subprocess would succeed. It validates
  that the COMMAND, not the OUTCOME, is well-formed.
- Does not perform idempotency checks ("this command would be a no-op"
  is a separate concept; use `am status` for drift).

### What `--dry-run` MAY do (read-only I/O)

- `Bun.which()` / equivalent PATH lookup IS allowed. Knowing whether
  the binary is actually on PATH is cheap, read-only, and gives the
  operator an actionable signal ("would spawn `claude` but it isn't
  installed"). Corrects an earlier draft that forbade all external
  calls (2026-05-02 concurrent-review Codex W1). If the binary is not
  found, dry-run output includes `binary_resolved: null` and a
  `warnings` array entry — dry-run still succeeds (exit 0), because
  the intent is to EXPLAIN, not to assert runnability.
- Reading agent-manager's own config files IS allowed (obviously).
- Resolving variants / secrets / permission-policy fields IS allowed.

### Coverage plan

Not every mutating command gets dry-run in the first PR. Priority order:

1. **`am run <agent>`** (this ADR's MVP proof) — highest value because
   subprocess spawn is the hardest to "take back."
2. **`am apply [--diff]`** — wire the already-declared `--diff` flag
   through `applyResolved`. Currently the CLI flag is silently dropped
   (`src/commands/apply.ts:10-13`).
3. **`am marketplace install <plugin>`** — preview what the manifest
   would add, which entries would collide with existing catalog entries.
4. **`am import <tool>`** — already has `--report` flag per ADR-0028;
   reframe as `--dry-run` for consistency.
5. **`am wiki sync`** — when M5 lands (plan at
   `docs/plans/wiki-sync-m5.md`), dry-run should show what would be
   committed/pulled/pushed.

Commands OUT of scope for this ADR:
- Read-only commands (`am list`, `am status`, `am config show`). No need.
- `am use <profile>` — single-file state mutation with clear output;
  dry-run is redundant.

### The `explain` verb — deferred

An earlier draft of this ADR proposed `--explain` as an alias for
`--dry-run`. Rejected for MVP (2026-05-02 concurrent-review correction,
Codex W1): two names for the same flag adds discoverability churn
without adding capability. `--dry-run` is the sole spelling. A future
ADR MAY add `--explain` as a dedicated verb with different semantics
(e.g. post-execution explanation of what a previous run actually did)
— but that's a separate concept, not an alias.

## Consequences

### Positive
- One product principle, many implementations. Users learn the pattern
  once and expect it on every mutating command.
- Trivially testable. Dry-run output is JSON; assertions are
  "these keys are present; these keys have these values."
- Fits cleanly into Pillar 1 (`am apply` drift preview), Pillar 3 (agent
  spawn preview), Pillar 4 (marketplace install preview), Pillar 6 (TUI
  "preview before apply" dialog).
- Security win: users see the env keys + allowed paths BEFORE spawning
  an agent. Exposes any permission surprises (variant defaulted to
  auto-approve? allowed_paths too wide?) at dry-run time.

### Negative
- Every mutating command is now ~1 extra code path. Modest — dry-run
  mode is "don't call the mutator," which is a small branch.
- Risk of dry-run output drifting from live behavior. Mitigation: the
  ADR MVP locks in tests that compare resolved-config between dry-run
  and live modes (same input → same resolution).
- Not every resolution step has a clean "run validation, don't execute"
  split (e.g. the ACP handshake itself is a validation). We scope to
  pre-spawn resolution; mid-execution validation is not dry-run-able.

### Neutral
- No new dependencies. The `--dry-run` flag is pure CLI ergonomics.

## Alternatives Considered

**Per-command ad-hoc preview flags (`--diff`, `--report`, `--preview`,
etc.).** Status quo. Rejected — three different words for the same
concept. The 2026-05-02 review explicitly flagged this as one
convergent theme; one flag across commands is the clarification.

**A separate top-level verb (`am preview apply`, `am preview run`).**
Considered. Rejected — doubles the command surface; users must learn
"preview" as a verb. `--dry-run` is an industry idiom (Make, Ansible,
kubectl, Terraform).

**Rely on `--verbose` instead of adding a flag.** `--verbose` describes
logging depth, not side-effect elision. They are orthogonal: dry-run
should respect `--verbose` for how chatty the JSON is, but `--verbose`
alone is not a side-effect inhibitor.

**Always emit dry-run-style output even in live mode (logged).** The
synthesis calls for this separately (Tier C observability). Different
problem; don't conflate. Live mode should log what it's doing; dry-run
mode should NOT do it. Both can coexist.

## References

- `docs/research/2026-05-02-all-pillars-review/00-synthesis.md`
  (Theme 1: dry-run/preview missing; Tier A2)
- `docs/research/2026-05-02-all-pillars-review/01-catalog-git.md` §5.1
- `docs/research/2026-05-02-all-pillars-review/03-protocol-router.md` §6.1
- `docs/research/2026-05-02-all-pillars-review/04-marketplace.md` §6.2
- ADR-0036 (variants schema — dry-run surfaces `variant_used`)
- Prior art: `kubectl --dry-run=client`, Ansible `--check`, Terraform
  `plan` vs `apply`, Make `-n`, `git push --dry-run`.

## Implementation note (MVP scope)

First PR after this ADR accepts ships `am run <agent> --dry-run`:

1. Add `--dry-run` + `--explain` (alias) flags to `am run` args.
2. In `src/commands/run.ts`, short-circuit BEFORE `client.connect()` when
   dry-run is set. Emit the JSON shape above using existing resolution
   output.
3. Test coverage: dry-run returns the correct `command/args/env_keys`
   for each variant (if ADR-0036 is also live), same keys that a live
   run would use.
4. Documentation: README "Quick Start" and `am run --help` mention
   `--dry-run` as the first thing to try.

Subsequent PRs cover `am apply`, `am marketplace install`, `am import`,
following the same shape. Each PR updates this ADR's "Coverage plan"
checklist.

## Verification gates (closed 2026-05-05)

| Gate | Status | Evidence |
|------|--------|----------|
| Shared envelope type | ✓ | `src/lib/dry-run-envelope.ts` (122 LOC) — `DryRunEnvelope<T>` interface |
| Conformance test | ✓ | `test/commands/dry-run-envelope.test.ts` (327 LOC, 31 tests passing) |
| `am run --dry-run` wired | ✓ | `src/commands/run.ts` emits envelope shape (Lens E confirmed) |
| `am apply --dry-run` wired | ✓ | `src/commands/apply.ts` emits envelope shape |

### Deferred to future PRs (out of scope for this acceptance)

- `am import`: still uses `--report` flag; switching to `--dry-run` is an
  API break. Migrate when 2.x major version cuts.
- `am marketplace install --dry-run`: marketplace v1 retired by ADR-0039;
  no point adding a feature.
- `am apply --diff` and `am apply --force` flags: declared in args but
  intentionally unwired pending design review (Lens E flagged but not
  scoped to this PR).
- Dual-emit `readOnlyHint` / `destructiveHint` upstream MCP annotations
  (overlaps with ADR-0037 Phase 2; tracked there).
