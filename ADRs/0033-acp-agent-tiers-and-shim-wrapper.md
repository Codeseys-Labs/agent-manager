---
status: accepted
date: 2026-04-18
pending_amendment_by: ADR-0034
---

# ADR-0033: ACP Agent Tiers and Shim-Wrapper Architecture

> **Pending amendment (2026-05-02) by [ADR-0034](0034-shim-scope-and-inclusion-criteria.md),
> which is currently `status: proposed`.**
>
> When ADR-0034 is promoted to `accepted`, this header flips from
> `pending_amendment_by` to `amended_by` and the amendment becomes load-bearing
> policy. Until then:
>
> - The clean-cut removal of `devin` and `amp` recorded in the body remains the
>   operative historical precedent.
> - ADR-0034's proposed "tier-down-before-remove" deprecation policy is NOT
>   yet binding. Implementers choosing to remove a shim should follow the body
>   of this ADR (clean-cut) unless / until ADR-0034 accepts.
> - ADR-0034 also depends on a community-shim registration path that does not
>   yet exist (tracked as CODEX-2). That design gap must close before ADR-0034
>   can plausibly flip to accepted.
>
> The `pending_amendment_by` pattern is documented in `ADRs/template.md` —
> an accepted ADR cannot defer authoritatively to a non-accepted one, but it
> can forward-reference a proposed amendment so readers see the in-flight
> change without treating it as settled.

## Context

Iter4 R4 and the 2026-04-17 live-smoke test revealed that agent-manager's
`BUILT_IN_ACP_AGENTS` list (16 entries) **overstates reality**. Of 16 entries:

- 4 verified to work end-to-end: claude, codex, gemini, kiro
- 7 are pure nominal (no upstream ACP binary exists): devin, amp, windsurf,
  roo-code, aider, augment (wrong binary name), amazon-q
- 5 are ambiguous / partial / VSCode-extension-only: cursor, copilot, cline,
  goose, sourcegraph

A nominal ACP list harms users in two ways:
1. `am agent list` shows 16 "available" agents but most fail on first use,
   triggering silent `npx` fetches, timeouts, or "command not found" errors.
2. Future audits have no yardstick — is `devin` aspirational or broken?

Separately, the user asked whether we can build an **acp-shell wrapper** that
fakes the ACP protocol on top of a non-ACP-native CLI tool (e.g. aider, q,
cody). Research concluded: yes, feasible via a headless-CLI archetype, because
the ACP spec allows an agent to emit zero intermediate updates and deliver
the response as a single final chunk.

A third input: openclaw/acpx is an actively maintained reference project with
16 agents, 10 of which we don't cover (droid, qoder, iflow, kimi, qwen, trae,
opencode, pi, kilocode, openclaw). Selective borrowing under MIT is safe.

## Decision

Split `BUILT_IN_ACP_AGENTS` into **three explicit tiers**, each with a
different expectation, surface, and trust posture.

### Tier 1 — Native ACP agents

Agents where the upstream publishes a documented ACP binary or subcommand that
we've verified speaks the protocol end-to-end.

**Inclusion criteria:**
- Upstream documents ACP support (URL in our agent entry).
- A live deep-probe test in CI (`am agent detect <name>` returns "verified").
- Binary is installable via a documented path (npm, brew, manual download).

**Shipping list for 0.5.x+:** claude, codex, gemini, kiro.
**Shipping-after-verification:** qwen, openhands, auggie (renamed from
augment-cli), opencode, qoder, droid, kilocode (acpx-confirmed; needs our
independent verify).

### Tier 2 — Wrapped CLI agents (acp-shell)

Agents where the upstream tool is a headless-capable CLI but does NOT speak
ACP natively. A single `am-acp-shell` sub-binary shims the protocol by:

1. Accepting ACP `initialize` / `session/new` / `session/prompt` over stdio.
2. On each `session/prompt`, spawning the wrapped CLI with a template like
   `aider --message-file - --yes --no-stream --no-pretty < prompt`.
3. Collecting stdout, emitting one `agent_message_chunk` and one `stop`
   (spec-legal per protocol/prompt-turn.md).
4. Advertising `loadSession: false` so the SDK doesn't expect session
   continuity — each prompt is a fresh process.

**Candidates (ranked by R-A viability score):**
- aider (5/5 — documented one-shot flags)
- amazon-q CLI (4/5 — `q chat --no-interactive`)
- cody (4/5 — `cody chat -m`)
- gh-copilot (4/5 — `gh copilot suggest`)
- cursor-agent (4/5 — `cursor-agent acp` if not native)
- plandex (3/5 — `plandex send --no-confirm`)

**Security posture (MUST appear in `--help` and README):**
> Tier-2 wrapped agents inherit the trust posture of the underlying CLI.
> am does NOT interpose on permissions — if the wrapped flags auto-approve
> (e.g. `--yes`), every file mutation the agent requests proceeds without
> am's approval UI. Use Tier 2 only with agents whose auto-approve mode you
> trust in your environment.

Tier-2 agents are OFF by default. User opts in per-agent via
`am agent enable-shim <name>` which flips a per-agent flag in the catalog
and records the acknowledgment of the security caveat.

### Tier 3 — Catalog-only (non-spawnable)

Agents / tools where am has an **adapter** (syncs catalog → native config)
but no spawnable ACP runtime and no wrappable CLI. These are still
first-class for `am apply` but cannot be `am run`.

**Examples:** cline, roo-code, continue, windsurf (VSCode extensions),
kilo-code (VSCode extension), forge (MCP-only), cursor-editor.

**Surface:** `am agent list` shows them with `Runnable: no (adapter-only)`.
`am run <tier-3>` returns a clear error: "<name> is a catalog-only
integration; am writes its config but cannot spawn it. Use it from its
native UI."

### Removal

Entries that are neither Tier 1 nor Tier 2 nor Tier 3 and have no path to
any of the three are **removed** from `BUILT_IN_ACP_AGENTS`:

- **devin** — Cognition SaaS with no CLI. Path: if/when they ship one.
- **amp** — sourcegraph/amp 404s; no evidence of binary existence.

These can come back with a PR that includes a verified binary URL and a
passing deep-probe test.

## Consequences

### Positive

- Users discover truth: `am agent list` shows what actually works, not what
  we wish worked.
- Future audits have a tier schema to test against. "Is X a Tier-1 agent?"
  is now a crisp question.
- Tier 2 unlocks aider (large user base), q (AWS users), cody (Sourcegraph
  users) for `am run` — roughly 3x the reachable agent surface.
- openclaw/acpx becomes a reference point, not a competitor — we borrow
  their pinned-semver pattern + their `resolveInstalledBuiltInAgentLaunch`
  optimization in a later phase.
- The Tier-1/2/3 framing answers iter4 R4's "ACP list lies" finding with
  a durable structure rather than a one-shot cleanup.

### Negative

- Tier-2 wrappers lose streaming fidelity — users see "one big chunk at
  the end" instead of token-by-token output. Documented as a known
  limitation. Users who want streaming continue to use Tier-1 native
  agents.
- Tier-2 wrappers lose permission-model integration. The security caveat
  is prominent; enable-shim requires opt-in. Still a real sharp edge.
- Removing nominal entries (devin, amp, etc.) might break anyone whose
  scripts reference `am run devin "..."`. Acceptable — those scripts
  never worked; removing a broken promise is a bug fix, not a regression.

### Neutral

- Phase A (catalog truth pass) can ship standalone without Phase B
  (acp-shell wrapper). Ordering is: A → D (ADR) → B → C (acpx borrow).

## Alternatives Considered

**Leave BUILT_IN_ACP_AGENTS as-is, document caveats.** Rejected — the
nominal list actively misleads users at first contact. Documentation
can't compensate for surface that lies.

**Remove all non-verified entries and stop there.** Considered. Rejected
because aider/q/cody have real user demand and the wrapper work is
finite (~3-4 hours scoped).

**Fork openclaw/acpx and ship a joint package.** Rejected. Their alpha
banner warns of interface churn, and our vision is broader than theirs
(catalog + git sync + wiki + 3 UIs). Selective borrowing under MIT
preserves our scope while benefiting from their decisions.

**Build a PTY-emulation wrapper for REPL-only agents.** Rejected —
fragile, version-sensitive, doesn't help the VSCode-extension-only
agents anyway.

## Implementation sequence

1. **Phase A (catalog truth pass)** — rewrite `BUILT_IN_ACP_AGENTS` to
   Tier-1-only; mark the 5 catalog-only targets; remove devin + amp.
   Update `am agent list` output to show the "Tier" column. Add CI test
   asserting every Tier-1 entry passes `agent detect`.
2. **Phase B (acp-shell wrapper)** — implement `src/protocols/acp/shell-wrapper.ts`;
   add `am agent enable-shim <name>` command + `am agent list` shows
   Tier-2 candidates with enable-hint; wire 3 initial wrappers (aider,
   q, cody).
3. **Phase C (acpx borrowing)** — port `resolveInstalledBuiltInAgentLaunch`;
   pin npm versions; add openclaw/acpx as documented prior art.
4. **Phase D (docs)** — this ADR (done); update README with tier matrix;
   add SECURITY note for Tier 2.

## Implementation status (as of 2026-04-20, v0.5.0-rc6)

Phases A–D shipped. Plus three security gates and two post-landing review
passes caught a CRITICAL regression before ship:

**Delivered:**
- Phase A: 14 tiered entries (4 tier-1, 3 tier-2, 7 tier-3). devin, amp,
  augment (wrong binary), sourcegraph nominal entries removed.
- Phase B: `am-acp-shell` second binary, `ShimAcpServer`, `BUILT_IN_SHIMS`
  (aider / amazon-q / cody), `am agent enable-shim <name>` with security
  caveat and per-agent opt-in flag.
- Phase C: `resolveInstalledBuiltInAgentLaunch` prefers local
  `claude-agent-acp` / `codex-acp` binaries over npx cold-start (2–5s
  saved per invocation).
- Phase D: README tier matrix, CLAUDE.md + AGENTS.md tier framing,
  `docs/references/openclaw-acpx.md` attribution doc.

**Security gates (REV-2):**
- `sandboxEnv()` allowlists env; strips AM_*, AWS_*, *_TOKEN/SECRET/KEY,
  OPENAI_*, ANTHROPIC_*, GOOGLE_* before spawning ACP subprocesses.
- `redactProgressMessage` wraps MCP `notifications/progress` emission so
  streamed secrets don't escape to third-party IDE logs.
- `enable-shim --yes` gate is prominent and matches the ADR caveat text.

**Concurrency (REV-1 MEDIUM-2):**
- 8 CLI mutating commands now route through `withConfig` + `configMutex`:
  install, uninstall, update, profile create/delete, init, marketplace
  install/uninstall, plus `agent enable-shim`.
- TUI `handleRemoveServer`, `handleImport`, and `handleApply` collapsed
  onto the canonical controller pipeline — no more fourth apply path.

**REV-4 CRIT-1 (caught before ship):** `enable-shim` originally wrote to
`agents.<name>.adapters.acp.command`, but `resolveAgent` reads
`agents.<name>.acp.command` directly. The entire Tier-2 opt-in flow was
dead on arrival. Fixed, and the test now asserts the resolved route, not
just the write. See `docs/reviews/2026-04-18-acp-shell-wrapper/REV-4-integration.md`.

**REV-5 post-ship audit:** caught two additional misses by prior reviews
— `install.sh` and the Homebrew formula didn't install `am-acp-shell`
(dead-on-arrival for binary-install users), and `am agent detect`
emitted the tier-3 message for tier-2 shims. Both fixed post-rc6. See
`docs/reviews/2026-04-18-acp-shell-wrapper/REV-5-post-rc6-audit.md`.

**CI status (2026-04-20):** green on macOS + Linux + integration. Windows
remains `continue-on-error: true` (REV-3 pre-existing failures — tracked
as outstanding).

## References

- `docs/reviews/2026-04-18-acp-shell-wrapper/00-synthesis.md`
- `docs/reviews/2026-04-18-acp-shell-wrapper/R-A-feasibility.md`
- `docs/reviews/2026-04-18-acp-shell-wrapper/R-B-acpx-analysis.md` (openclaw)
- `docs/reviews/2026-04-18-acp-shell-wrapper/R-C-coverage-gaps.md`
- `docs/reviews/2026-04-18-acp-shell-wrapper/REV-1-system-review.md`
- `docs/reviews/2026-04-18-acp-shell-wrapper/REV-2-security.md`
- `docs/reviews/2026-04-18-acp-shell-wrapper/REV-3-test-ci.md`
- `docs/reviews/2026-04-18-acp-shell-wrapper/REV-4-integration.md`
- `docs/reviews/2026-04-18-acp-shell-wrapper/REV-5-post-rc6-audit.md`
- `docs/references/openclaw-acpx.md`
- ACP spec: https://agentclientprotocol.com
- openclaw/acpx: https://github.com/openclaw/acpx (MIT)
- ADR-0030 (unified agent registry)
- ADR-0031 (product scope and pillars)
- ADR-0032 (terminology glossary)
