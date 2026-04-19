# openclaw/acpx — prior-art reference

**Repo:** <https://github.com/openclaw/acpx>
**License:** MIT
**Status at time of borrow:** Active, alpha. Repo banner states *"alpha and the
CLI/runtime interfaces are likely to change"*.
**Reviewed at:** 2026-04-18 (commit `be51994`, last push 2026-04-16).

`acpx` is a headless CLI client for the [Agent Client Protocol][acp]. It is a
**sibling project** to `agent-manager`: both tools spawn ACP-compatible agent
binaries over stdio and route JSON-RPC between the caller and the agent. See
[`docs/reviews/2026-04-18-acp-shell-wrapper/R-B-acpx-analysis.md`][rb] for the
full comparison.

[acp]: https://agentclientprotocol.com
[rb]: ../reviews/2026-04-18-acp-shell-wrapper/R-B-acpx-analysis.md

## Why this file exists

We deliberately **did not** hard-fork or vendor `acpx`. Its alpha banner means
its interfaces can change without notice and its CLI surface overlaps `am run`
in ways that would force us to track their breaking changes. Instead, Phase C
of [ADR-0033][adr] cherry-picks one pattern from `acpx` that gives a
measurable end-user win, with attribution.

This document records what we borrowed and what we explicitly did **not** —
so a future reader (or a future borrow) has a clear scope boundary.

[adr]: ../../ADRs/0033-acp-agent-tiers-and-shim-wrapper.md

## What we borrowed

### `resolveInstalledBuiltInAgentLaunch`

**Upstream source:**
<https://github.com/openclaw/acpx/blob/main/src/agent-registry.ts> (lines
145-210 as of commit `be51994`).

**The idea.** For built-in agents whose upstream adapter is distributed as an
npm package (e.g. `@agentclientprotocol/claude-agent-acp`,
`@zed-industries/codex-acp`), `acpx` records both the `npx …@latest` cold-start
command **and** the name of the binary the package installs globally. At
resolve time, if the local binary is on `PATH`, acpx uses it directly; only
when it is not does acpx fall back to the `npx` invocation.

**Why it matters.** `npx -y @agentclientprotocol/claude-agent-acp@latest` costs
2–5s of cold-start on every invocation even when the package is already
cached — npx still walks the registry to resolve `@latest`. Users who `npm i
-g @agentclientprotocol/claude-agent-acp` expect the global bin on their
`$PATH` to be used. Without this check, it is not.

**Our implementation.**

- [`src/core/agent-registry.ts`][local-registry]:
  - New optional field `BuiltInAgentSpec.localBinary?: string`.
  - New function `resolveInstalledBuiltInAgentLaunch(name, spec)` that returns
    the on-PATH binary path if `spec.localBinary` is set **and** `Bun.which`
    resolves it; otherwise returns the unchanged `spec.command`.
  - Only `claude` (→ `claude-agent-acp`) and `codex` (→ `codex-acp`) opt in.
    `gemini` (`gemini --acp`), `kiro` (`kiro-cli-chat acp`), and the tier-2
    shims leave `localBinary` unset — their `command` is already the native
    invocation; re-resolving would be a layering violation.
- [`src/protocols/acp/registry.ts`][local-proto]:
  - `resolveAgent()` calls `resolveInstalledBuiltInAgentLaunch` after the
    config-override check. A user's explicit
    `[settings.acp.agents.<name>]` command is **never** second-guessed —
    we only re-resolve the built-in default.
  - `listAgents()` applies the same resolver so the list reflects what will
    actually be spawned, not what the registry would naively emit.

[local-registry]: ../../src/core/agent-registry.ts
[local-proto]: ../../src/protocols/acp/registry.ts

**Test coverage.** `test/protocols/acp/client.test.ts` — the
`resolveInstalledBuiltInAgentLaunch / local-binary preference` describe-block
stubs `Bun.which` via `__setLaunchWhichFnForTests` and asserts both branches
(hit, miss), plus that config overrides are not second-guessed and
non-`localBinary` agents (e.g. `gemini`) keep their original command.

## What we explicitly did NOT borrow

1. **The full agent lineup.** `acpx` ships 16 built-in agents; the overlap
   with `am` is 6 (`claude`, `codex`, `gemini`, `cursor`, `copilot`, `kiro`).
   The other 10 acpx-unique agents (pi, openclaw, droid, iflow, kilocode,
   kimi, opencode, qoder, qwen, trae) are complementary — mostly
   China-region CLIs and one Discord harness — and would each need
   independent upstream verification before we claim they speak ACP. We
   defer this to a separate catalog-truth pass.

2. **Pinned semver ranges (`@^0.25.0` style).** `acpx` pins
   `@agentclientprotocol/claude-agent-acp@^0.25.0` where `am` currently uses
   `@latest`. Pinning is objectively more reproducible but has its own
   maintenance tax (we must update the range when upstream ships breaking
   changes). Tracked as a follow-up, not blocking Phase C.

3. **The `AGENT_ALIASES` map.** `acpx` uses a tiny separate map for aliases
   (e.g. `factory-droid -> droid`). `am` does not have aliased built-ins
   today. If we add one (e.g. `kiro -> kiro-cli-chat`) we would design it
   against our `UnifiedAgent.source` model, not copy acpx's inline string map.

4. **The whole CLI surface.** `acpx` has its own `acpx run`, its own session
   store, its own `--agent` escape hatch. `am run` is our canonical entry
   point; we are not going to host two. `acpx` remains a good external tool
   for users who want a thinner wrapper than `am`.

5. **Vendoring as a submodule.** The CLI-surface overlap plus the alpha
   banner means the engineering effort to dedupe exceeds the value. `acpx`
   is MIT; copying 40 lines with attribution is the right scope.

## Attribution pattern

Inline attribution lives at the top of the borrowed function in
`src/core/agent-registry.ts`:

```ts
/**
 * …
 * Borrowed from openclaw/acpx's `resolveInstalledBuiltInAgentLaunch`
 * (<https://github.com/openclaw/acpx/blob/main/src/agent-registry.ts>, MIT).
 * See `docs/references/openclaw-acpx.md` for attribution + scope boundary.
 */
```

and at the top of the `BuiltInAgentSpec.localBinary` field docblock.

## License note

`acpx` is MIT. The MIT license permits copying with attribution; our
attribution lives (a) in source comments, (b) in this file, and (c) in the
ADR-0033 Phase C commit message. We are not reshipping `acpx` code verbatim
beyond the 40-line pattern described above; everything else — the tier model,
the agent list, the shim wrapper, the env-sandbox — is `am`-original.

## Related documents

- [`ADRs/0033-acp-agent-tiers-and-shim-wrapper.md`][adr] — the decision this
  borrow lives under.
- [`docs/reviews/2026-04-18-acp-shell-wrapper/R-B-acpx-analysis.md`][rb] —
  the full comparative analysis (26 agents, 4 interop options).
- [`docs/reviews/2026-04-18-acp-shell-wrapper/00-synthesis.md`][syn] — the
  Phase A/B/C/D landing plan this file is the Phase C attribution for.

[syn]: ../reviews/2026-04-18-acp-shell-wrapper/00-synthesis.md
