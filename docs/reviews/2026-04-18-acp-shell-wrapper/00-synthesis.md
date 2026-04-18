# ACP Shell Wrapper — Synthesis

**Date:** 2026-04-18
**Question asked:** Can we build an "acp-shell" wrapper so `am run <agent>` works for tools that don't speak ACP natively? Also document openclaw/acpx for future integration + community-adapter testing.
**Method:** 3 parallel research agents — R-A (ACP spec minimum + wrapper feasibility), R-B (openclaw/acpx upstream analysis), R-C (am's ACP coverage gap audit).
**Per-facet reports:** `R-A-feasibility.md`, `R-B-acpx-analysis.md`, `R-C-coverage-gaps.md`.

## The three answers

### Q1: Is an acp-shell wrapper feasible?
**Yes.** The ACP spec (`protocol/prompt-turn.md`) explicitly allows an agent to emit zero intermediate `session/update` notifications and deliver the entire response as a single `agent_message_chunk` + `stop`. Four methods are baseline MUST: `initialize`, `session/new`, `session/prompt`, `session/update` notifications. `session/load` is capability-gated — advertise `loadSession: false` and it disappears from the SDK's expectations.

**Recommended archetype: headless-CLI wrapper.** One-shot spawn per prompt, collect stdout, emit one chunk, signal end_turn. Low fragility (depends only on stable user-facing flags), covers the most candidates. REST is a reasonable v2 for Cody/Copilot-API agents. PTY-emulation is explicitly NOT recommended — fragile, version-sensitive, and VSCode-extension agents have no binary to drive anyway.

**Security caveat (flagged prominently):** wrapping `aider --yes` or similar auto-approve modes bypasses am's permission model. ADR-0033 must state that wrappers inherit the wrapped tool's trust posture and document how users can constrain this.

### Q2: What does openclaw/acpx give us?
A **reference project** maintained by a credible team (2166 stars, MIT, actively pushed, 3 humans + bots, release-it/husky discipline). 16 agents, of which only 6 overlap with ours: claude, codex, gemini, cursor, copilot, kiro.

**Integration decision: selective borrowing with attribution, NOT marketplace integration.**

acpx has no plugin manifest — `am marketplace add https://github.com/openclaw/acpx` would find nothing parseable. Instead:
1. Cherry-pick 4 commercially-relevant agents acpx has that we don't: **droid**, **qoder**, **opencode**, **kilocode** (acpx confirms a `kilo-code` ACP binary we initially missed — conflicting data, see §Caveats below).
2. Adopt acpx's **pinned-semver pattern** for claude/codex (they pin specific versions, we use `@latest` → cold-start via npx).
3. Port their `resolveInstalledBuiltInAgentLaunch` pattern — prefers a locally-installed binary over npx. Measurable startup-time win for claude/codex.
4. Add **pi-acp** as an ACP conformance target in am's integration tests (openclaw's own ACP reference agent).

Short-term bet is safe. Their alpha banner warns of interface churn, so avoid hard-forking; treat as upstream reference.

### Q3: What's the state of am's current ACP list?
**7 of 16 entries are nominal/fake.** Smoke-tested evidence combined with R-C's upstream audit:

| Agent | Status | Reason |
|---|---|---|
| claude | ✅ real | @agentclientprotocol/claude-agent-acp, live-verified |
| codex | ✅ real | @zed-industries/codex-acp, live-verified |
| gemini | ✅ real | gemini --acp (Google CLI) |
| kiro | ✅ real | kiro-cli-chat acp, live-verified (v2.0.1) |
| cursor | ⚠ partial | cursor-agent binary exists but ACP support not confirmed |
| copilot | ⚠ partial | gh copilot is CLI; ACP support uncertain |
| cline | ⚠ partial | VSCode-ext only, no standalone binary (unwrappable) |
| roo-code | ❌ nominal | VSCode-ext only |
| windsurf | ❌ nominal | IDE-only, no windsurf-cli |
| aider | ❌ nominal | has --chat-mode not --acp; wrappable-not-native |
| amazon-q | ❌ nominal | q chat has --acp flag but not documented upstream |
| amp | ❌ nominal | sourcegraph/amp repo 404s |
| augment | ❌ wrong bin | actual binary is `auggie` not `augment-cli` |
| goose | ❌ nominal | goose is TUI-first, no --acp |
| devin | ❌ nominal | Cognition SaaS, no CLI |
| sourcegraph | ❌ nominal | cody CLI doesn't document ACP |

R-C's top-3-to-remove: devin, amp, windsurf. Honestly, **we should remove all 7 entries that aren't live-verifiable** and move them to "wrappable-via-shim" tier behind a flag.

## The catalog overhaul (the real output)

This is not just an "add wrapper" task. iter4 R4 warned us that a nominal ACP list that doesn't match reality is a broken promise. The real work is three-tier:

### Tier 1 — **Native ACP agents** (verified installable with working handshake)
- claude, codex, gemini, kiro (today)
- Add: **qwen** (native per Qwen Code docs), **auggie** (fix from `augment-cli`), **openhands** (native ACP per docs.openhands.dev), **opencode**, **qoder**, **droid**, **kilocode** (the one acpx confirms — need to verify binary independently)
- Target: ~11 agents, all with live-test green checks

### Tier 2 — **Wrapped CLI agents** (headless-CLI shim, `acp-shell` sub-binary)
- aider (--message-file + --yes + --no-stream), amazon-q CLI (q chat --no-interactive), cody, gh-copilot, cursor-agent, amp CLI if it ships, plandex (--no-confirm)
- Opt-in: disabled by default, `am agent enable-shim <name>` flips a flag, documents the security caveat (wrapped agent inherits its own trust posture; `--yes` bypasses am permissions)
- Single `am-acp-shell` binary (or embedded mode in am-cli); config specifies wrapped command + argv template

### Tier 3 — **Catalog-only** (has am adapter for config sync, no spawnable agent)
- cline, roo-code, continue, windsurf, kilo-code (VSCode-extension), forge, cursor-editor
- `am agent list` shows these as "adapter-only — not spawnable"
- `am apply` still writes their configs; `am run` rejects them with a clear message

### Removal
- devin (SaaS only), amp (404), and any name in `BUILT_IN_ACP_AGENTS` that R-C flagged as pure nominal. Removed entries come back only with real evidence + verified binary.

## Implementation phases

### Phase A — Catalog truth pass (1-2 hours, ship standalone)
No new code; just align `BUILT_IN_ACP_AGENTS` with reality:
- Remove: devin, amp, windsurf, roo-code, cline (mark catalog-only)
- Rename: `augment-cli` → `auggie`
- Add: qwen, openhands (both have native ACP documented)
- Add tests that `am agent detect <each>` runs deep probe in CI (against a fixture) so the list stops drifting.
- Update README matrix to show three tiers.

### Phase B — acp-shell wrapper (3-4 hours)
Build `src/protocols/acp/shell-wrapper.ts` + integration with `AmAcpClient`:
- `ShimConfig`: `{ command: string[], promptTemplate: string, responseExtractor: "stdout" | "stderr" | "both" | regex, env?, cwd? }`
- One-shot flow: initialize (return stub caps), session/new (mint id, record cwd), session/prompt (spawn `command` with `promptTemplate` substituted, capture output, emit as `agent_message_chunk`, signal `end_turn`)
- No session continuity — each prompt is fresh process, loadSession: false
- Built-in shim registry: aider (aider --message-file - --yes --no-stream --no-pretty), q (q chat --no-interactive), cody (cody chat -m)
- Security: prominent warning in help output; shim commands run with the wrapped tool's native permission model

### Phase C — openclaw/acpx borrow (1 hour)
- Port `resolveInstalledBuiltInAgentLaunch` so claude/codex prefer local install over npx (matches acpx pattern)
- Pin npm @version where possible instead of @latest (reproducibility)
- Add docs/references/openclaw-acpx.md linking the upstream as prior art

### Phase D — ADR-0033 (inline, 30 min)
Record scope, archetypes, tiers, security posture, non-goals. Future audits measure against this.

## Recommendation

Proceed with **Phase A (catalog truth) + Phase D (ADR)** now, defer **B + C** pending user confirmation. Phase A is low-risk and directly addresses the iter4 finding that our ACP list lies. Phase B + C are additive and can be sequenced later.

Total Phase A + D: ~2 hours. Would ship as `0.5.0-rc6` or hold for 0.6.0.
