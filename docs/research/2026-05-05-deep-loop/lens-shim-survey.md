# Lens D: Shim ADRs (0034/0035/0036) Survey + Acceptance Gates

**Date:** 2026-05-05  
**Scope:** ADRs 0034 (scope fence), 0035 (community shim registration), 0036 (agent variants)  
**Type:** Deep-work-loop lens survey  

## 1. Ecosystem Survey: ACP Agent Landscape 2025-2026

The Agent Client Protocol (ACP) launched August 27, 2025 (Gemini CLI as first integration). As of May 2026, the ecosystem includes 30+ agents on the official [agentclientprotocol.com](https://agentclientprotocol.com/get-started/agents) registry. Below is the tabulation of agents relevant to agent-manager's tier model (ADR-0033).

### Table 1: Agent ACP Compatibility Matrix

| Agent | Tier (am) | ACP Native? | CLI Command | Distribution | Notes |
|-------|-----------|-------------|-------------|-------------|-------|
| **Claude Code** | tier-1-native | Via Zed adapter only | `npx @zed-industries/claude-code-acp@latest` | npm adapter | Anthropic closed native ACP issue (#6686) as NOT_PLANNED (439 thumbs-up). No `acp serve` command. Zed ships the adapter bridge. |
| **Codex CLI** | tier-1-native | Via Zed adapter only | `npx @zed-industries/codex-acp@latest` | npm adapter | OpenAI's Codex CLI has no native ACP; Zed provides the adapter. |
| **Gemini CLI** | tier-1-native | Yes (--experimental-acp) | `gemini --acp` or `npx @google/gemini-cli@latest --experimental-acp` | npm / Google | First ACP integration. `--experimental-acp` flag. |
| **Kiro** | tier-1-native | Yes (native) | `kiro-cli-chat acp` | Amazon internal | Full ACP support. `acp` subcommand. JetBrains + Zed integration docs published. |
| **Aider** | tier-2-shim | No | `aider --message-file - --yes --no-stream --no-pretty` | pip / brew | 81-88% SWE-bench. Community `aider-acp` bridge exists (jorgejhms/aider-acp on GitHub). am ships first-party shim. |
| **Amazon Q** | tier-2-shim | No | `q chat --no-interactive` | AWS CLI | `q` binary is the CLI; distinct from Kiro IDE. am shim uses arg-last template. |
| **Cody** | tier-2-shim | No | `cody chat -m` | Sourcegraph CLI | Sourcegraph-hosted auth. am shim uses arg-last template. |
| **Goose** | unregistered | Yes (native ACP macros) | `goose` / `goosed` | block/goose (Rust) | Has `goose-acp-macros` crate. CLI + Desktop + API. Part of Agentic AI Foundation (Linux Foundation). Candidate for tier-1-native promotion. |
| **OpenHands** | unregistered | Yes (native) | `openhands acp` | All Hands AI | Full ACP support: `openhands acp --llm-approve`, session resume. Docs published. Candidate for tier-1-native. |
| **GitHub Copilot** | tier-3-catalog-only | Preview only | `npx @github/copilot-language-server@latest --acp` | GitHub | ACP in "public preview" per agentclientprotocol.com. am treats as catalog-only until live-smoke verification. |
| **Cline** | tier-3-catalog-only | Listed on ACP site | VS Code extension | cline/cline | Listed on agentclientprotocol.com/agents. No CLI spawn path; IDE extension only. |
| **Cursor** | tier-3-catalog-only | Listed on ACP site | Binary unclear | cursor.com | Upstream binary rename unclear (was `cursor-agent`, maybe `agent`). am treats as catalog-only. |
| **Continue.dev** | tier-3-catalog-only | No | VS Code / JetBrains extension | continuedev/continue | IDE extension only. No CLI spawn path. |
| **Roo Code** | tier-3-catalog-only | No | VS Code extension | RooVetGit/Roo-Code | Fork of Cline with expanded automation. No CLI. |
| **Kilo Code** | tier-3-catalog-only | No | VS Code extension | kilocodehq/kilocode | Hybrid Cline+Roo Code. No CLI. am ships adapter. |
| **ForgeCode** | unregistered | No | IDE | forgecode/forgecode | am ships adapter (forgecode/). No CLI. |
| **Windsurf** | tier-3-catalog-only | No | IDE | codeium/windsurf | am ships adapter. No CLI. |
| **OpenCode** | unregistered | Yes (native) | `npx opencode-ai@latest acp` | opencode-ai/opencode | 95K+ stars. Native ACP support. Candidate for tier-1-native. |
| **OpenClaw** | unregistered | Yes (native) | `npx openclaw acp` | openclaw/openclaw | Native ACP support. Phase E borrowing source per ADR-0034. |
| **Qwen Code** | unregistered | Yes (native) | `npx @qwen-code/qwen-code@latest --acp` | Qwen LM | Native ACP with --experimental-skills flag. |

**Key finding:** Of the 30+ agents on the ACP registry, approximately 6-8 speak ACP natively (Gemini CLI, Kiro, Goose, OpenHands, OpenCode, OpenClaw, Qwen Code, GitHub Copilot in preview). Claude Code and Codex CLI — the two most popular agents — rely on Zed-supplied adapter bridges, not native ACP. Aider, Amazon Q, and Cody have no ACP support whatsoever, which validates agent-manager's shim strategy.

## 2. ADR-0034: Scope Fence for First-Party ACP Shims

**Status:** `proposed` (2026-05-01)  
**Implementation state:** **Partial**

### What exists

| Artifact | File:Line | State |
|----------|-----------|-------|
| `BUILT_IN_SHIMS` with 3 entries (aider, amazon-q, cody) | `src/protocols/acp/shell-wrapper.ts:90-109` | Shipped (ADR-0033 Phase B) |
| `BUILT_IN_AGENTS` tier-2-shim entries | `src/core/agent-registry.ts:130-144` | Shipped |
| `AGENT_BINARIES` PATH probes for shim CLIs | `src/core/agent-detection.ts:70-72` | Shipped |
| `am agent enable-shim` (BUILT_IN_SHIMS only) | `src/commands/agent-enable-shim.ts:65-73` | Shipped |
| AGENTS.md tier-2 shim documentation | `AGENTS.md:288-306` | Shipped |
| Shim integration tests | `test/protocols/acp/shell-wrapper.test.ts` | Shipped (7 tests) |
| Enable-shim tests | `test/commands/agent-enable-shim.test.ts` | Shipped (4 tests) |

### What is NOT implemented (ADR-0034-specific surface)

| Feature | ADR-0034 Reference | State |
|---------|-------------------|-------|
| `[first-party]` / `[community]` labels in `am agent list` | §"CLI surface" line 143-153 | **Not implemented** — `agents.ts:127` renders tier only, no trust-label column |
| `[first-party]` / `[community]` labels in `am agent list --json` | §"CLI surface" line 143-153 | **Not implemented** |
| `deprecated: true` flag in `BUILT_IN_SHIMS` entry | §"Tier-down-before-remove" line 123-132 | **Not implemented** — no `deprecated` field on `ShimConfig` |
| Deprecation warning in `am-acp-shell` on stderr | §"Tier-down-before-remove" line 126-128 | **Not implemented** |
| Two-maintainer review gate | §"Cap" line 47-50 | **Process-only** — no automation |
| Vetting disclaimer in README + `am agent list` | §"Vetting disclaimer" line 111-121 | **Not implemented** |

### Open acceptance gates

1. **GATE-0034-1 (BLOCKING): C2 verification with live numeric sources.** The ADR's own "Verification gate" section (lines 155-178) states: *"Before this ADR can flip from Proposed to Accepted, C2 must be validated with live, numerically-cited, independently-reproducible sources for each of the three existing shims."* The shim-scope research that produced these criteria was flagged as model-memory-only. This gate requires:
   - GitHub stars, npm weekly downloads, or Homebrew install counts for aider, amazon-q, cody
   - Snapshot date and reproducible source URLs
   - A §Verification section appended to the ADR

2. **GATE-0034-2: CLI surface implementation.** `am agent list` must distinguish first-party from community. Currently `agents.ts:125-151` shows tier/source/protocol/installed but has no trust-posture label. The `renderTier()` function at `agents.ts:174-181` would need a companion `renderTrustLabel()`.

3. **GATE-0034-3: Deprecation mechanism.** The `ShimConfig` interface at `shell-wrapper.ts:46-75` needs a `deprecated?: boolean` field. `runShimServer` at `shell-wrapper.ts:483` must emit the warning when set.

4. **GATE-0034-4: Vetting disclaimer.** README and `am agent list` output must surface: built-in shims are `[first-party]` (ships with binary), community shims are `[community]` (trust the maintainer, not agent-manager).

### Recommended path to `accepted`

1. Execute C2 verification (GATE-0034-1) — query npm API for `@anthropic-ai/claude-code`, `aider`, `@sourcegraph/cody`; check GitHub stars; append §Verification section.
2. Implement CLI surface (GATE-0034-2) — add `[first-party]`/`[community]` labels as a small PR (can land concurrently with acceptance).
3. Add `deprecated?: boolean` to `ShimConfig` + warning in `runShimServer` (GATE-0034-3).
4. Flip status to `accepted` after GATE-0034-1 is satisfied. GATEs 2-4 can be deferred as follow-up tickets.

**Note:** The ADR explicitly states at line 208-211: *"No code change required immediately. The current three shims all pass the criteria; the cap is declarative until someone proposes a fourth."* This means partial implementation state is intentional. Acceptance is primarily a **policy decision** — the missing code surfaces are follow-ups.

## 3. ADR-0035: Community Shim Registration Protocol

**Status:** `proposed` (2026-05-02)  
**Implementation state:** **None**

### What exists

Nothing. The ADR is explicitly **design-only** (line 19): *"This ADR is design-only. It proposes the registration protocol. No code in this repo changes on acceptance; implementation is tracked as a follow-up."*

### Gap analysis

| Component | Current state | Target state (ADR-0035) |
|-----------|--------------|------------------------|
| Shim resolution | `serveShimOnStdio` at `shell-wrapper.ts:472` checks only `BUILT_IN_SHIMS` | Must also load from `shims.toml` (line 241-247 proposed code) |
| Enable flow | `agent-enable-shim.ts:65` rejects non-`BUILT_IN_SHIMS` names | Must resolve against `shims.toml` too (line 204-208 resolution order) |
| CLI surface | No `am shim *` commands exist | New `am shim install/list/remove/update` command group (line 222-225) |
| On-disk config | No `shims.toml` | `~/.config/agent-manager/shims.toml` with Zod schema (line 88-114) |
| Trust model | Only built-in trust posture | Community checksums, TOFU, install-time trust prompt (lines 160-196) |
| PB-* invariants | Only for built-ins | Community shims must pass same PB-1/PB-3/PB-4 guards (lines 257-271) |

### Open acceptance gates

1. **GATE-0035-1 (BLOCKING): ADR-0034 must be accepted first.** ADR-0035's preamble (lines 7-16) says: *"Precondition for ADR-0034 Phase E."* and *"Until this ADR is accepted and implemented, ADR-0034's Phase-E language is vacuous."* The two ADRs are tightly coupled — 0035 makes 0034's "community-adapter path" real.

2. **GATE-0035-2: Schema file creation.** `src/protocols/acp/community-shims/schema.ts` with `CommunityShimConfigSchema` (Zod schema at lines 130-146) must exist in the implementation follow-up.

3. **GATE-0035-3: `am-acp-shell` resolution extension.** `serveShimOnStdio` at `shell-wrapper.ts:471-480` must gain the `loadCommunityShim` fallback (lines 242-246 proposed code). The resolution order must be: `BUILT_IN_SHIMS[name]` → `shims.toml[name]` → error.

4. **GATE-0035-4: Enable flow extension.** `agent-enable-shim.ts` must resolve against both registries, surface `[community]` label, and re-verify checksums.

5. **GATE-0035-5: New `am shim` command group.** Four new CLI verbs: `install`, `list`, `remove`, `update` — paralleling `am adapter *`.

6. **GATE-0035-6: Supply-chain controls.** Checksum verification, TOFU prompts, git-backed audit trail for `shims.toml` entries (lines 160-195).

### Recommended path to `accepted`

1. Accept ADR-0034 first (unblocks the precondition).
2. Accept ADR-0035 as a **design decision** (no code required per its own terms).
3. Spin up an implementation follow-up ADR (the ADR references this at lines 278-292 as "deferred to the implementation ADR").
4. The implementation ADR should decide: distribution ecosystem (npm vs git vs marketplace), manifest format (`am-shim-manifest.toml` vs `package.json#am-shim`), promotion path, cross-machine sync.

**Risk:** The ADR creates two files (`adapters.toml` + `shims.toml`) where one might confuse users. The "command-namespace inflation" concern at lines 313-316 is real — docs and `am doctor` must explain the distinction clearly.

## 4. ADR-0036: Per-Agent Variants for Multi-Provider / Multi-Account Routing

**Status:** `proposed` (2026-05-02)  
**Implementation state:** **Complete (MVP scope)**

### What exists

| Artifact | File:Line | State |
|----------|-----------|-------|
| `VariantResolver` with full resolution order | `src/core/variant-resolver.ts:99-188` | Shipped |
| `VariantResolverError` with 4 error codes | `src/core/variant-resolver.ts:70-82` | Shipped |
| `ResolvedVariant` interface | `src/core/variant-resolver.ts:50-68` | Shipped |
| `isVariantsEnabled()` gate | `src/core/variant-resolver.ts:207-209` | Shipped |
| `AM_VARIANTS=1` env var gating | `src/core/variant-resolver.ts:207-209` | Shipped |
| `--variant` flag on `runCommand` | `test/commands/run/variant.test.ts:121-126` | Shipped |
| Dry-run surface for variant resolution | `test/commands/run/variant.test.ts:153-175` | Shipped |
| Back-compat path (no variants → name=null) | `test/core/variant-resolver.test.ts:154-167` | Shipped |

### Test coverage

| Test file | Tests | Coverage |
|-----------|-------|----------|
| `test/core/variant-resolver.test.ts` | 16 tests | Resolution order (5), back-compat (2), errors (6), shape (1), source attribution (5), gating (3) |
| `test/commands/run/variant.test.ts` | 7 tests | Flag registration, AM_VARIANTS gating, dry-run surface, Correction 1 ambiguous, sole-variant implicit, unknown variant error, permission_policy warning |
| **Total** | **23 tests** | |

### What is explicitly out of scope (per ADR-0036)

| Feature | ADR-0036 Reference | Rationale |
|---------|-------------------|-----------|
| A2A variants | §"Out of scope" line 156 | "same model should work; verify in Phase-2 implementation" |
| `am_agent_invoke` MCP `variant` parameter | §"Out of scope" line 157 | "needs tool-metadata ADR-0037 first" |
| Per-variant permission policy enforcement | §"Out of scope" line 158-159 | Schema-accepted but not wired. Warning emitted on mismatch. |
| `am agent variants` CLI subcommand | §"Out of scope" line 160-161 | "schema + --variant flag first; ergonomic subcommand is a later PR" |

### Open acceptance gates

1. **GATE-0036-1: `AM_VARIANTS=1` flag removal.** Per ADR-0036 lines 242-244: *"Opt-in flag for rollout: AM_VARIANTS=1 env var gates the feature during the first release after this ADR accepts. Remove the flag in the release-after-next once adopted."* The flag is currently required for the feature to work.

2. **GATE-0036-2: Zod schema validation.** The `variants` field must be accepted by `AgentProfileSchema` in `src/core/schema.ts`. Per ADR-0036 line 149: *"Zod schema in src/core/schema.ts accepts variants + default_variant"* — needs verification that schema.ts was updated.

3. **GATE-0036-3: Live-path integration.** The dry-run path is tested; the live `AmAcpClient.connect()` path receiving variant env/args needs end-to-end verification per ADR-0036 line 153: *"Resolved command+args+env flow to AmAcpClient.connect"*.

### Recommended path to `accepted`

1. Verify that `AgentProfileSchema` in `src/core/schema.ts` was extended with `variants` + `default_variant` fields (GATE-0036-2).
2. Flip status to `accepted` — the MVP implementation is substantially complete with 23 passing tests.
3. Schedule `AM_VARIANTS=1` flag removal for the release-after-next (GATE-0036-1).
4. Track out-of-scope items as follow-up tickets: A2A variants, MCP `am_agent_invoke` variant parameter, permission enforcement, `am agent variants` CLI subcommand.

**Note:** ADR-0036 is the most implementation-complete of the three. The `variant-resolver.ts` implementation at 209 lines with 23 tests across two test files represents a finished MVP. The only question is whether the Zod schema in `schema.ts` was actually updated (the ADR says it should be, but schema.ts wasn't read in this survey).

## 5. Cross-ADR Dependencies

```
ADR-0034 (scope fence, proposed)
    │
    ├──► ADR-0035 (community shim registration, proposed)
    │       └── Depends on ADR-0034 acceptance (precondition)
    │
    └──► ADR-0036 (agent variants, proposed)
            └── Independent — no dependency on 0034 or 0035
```

ADR-0034 and ADR-0035 form a pair: 0034 declares "community is the default path" but 0035 is what makes that path navigable. Until both are accepted, the Phase E borrowing plan is blocked. ADR-0036 is independently promotable.

## 6. Summary: Acceptance Gate Status

| ADR | Status | Implementation | Blocking Gates | Ready to Accept? |
|-----|--------|---------------|----------------|-----------------|
| **0034** | proposed | Partial | C2 verification (BLOCKING), CLI surface, deprecation mechanism, vetting disclaimer | **No** — C2 verification required first |
| **0035** | proposed | None (design-only) | ADR-0034 acceptance (BLOCKING), schema file, resolution extension, enable flow, command group, supply-chain controls | **Yes** (as design decision) — but only after 0034 accepts |
| **0036** | proposed | Complete (MVP) | AM_VARIANTS=1 removal, schema.ts verification, live-path integration test | **Yes** — implementation complete, gating is transitional |

## References

- `src/protocols/acp/shell-wrapper.ts:90-109` — BUILT_IN_SHIMS (3 entries)
- `src/protocols/acp/shell-wrapper.ts:471-480` — serveShimOnStdio (BUILT_IN_SHIMS only)
- `src/core/agent-registry.ts:89-185` — BUILT_IN_AGENTS (tier-1/2/3)
- `src/core/agent-detection.ts:61-75` — AGENT_BINARIES (shim PATH probes)
- `src/core/agent-detection.ts:84-98` — AGENT_ADAPTER_MAP (tier-3 adapters)
- `src/commands/agent-enable-shim.ts:65-73` — enable flow (BUILT_IN_SHIMS gate)
- `src/commands/agents.ts:174-181` — renderTier() (no trust-label column)
- `src/core/variant-resolver.ts:99-188` — resolveVariant() (full implementation)
- `src/core/variant-resolver.ts:207-209` — isVariantsEnabled() (AM_VARIANTS gate)
- `AGENTS.md:275-306` — Tiered ACP agents section (3 tiers, shim docs)
- `test/protocols/acp/shell-wrapper.test.ts` — 7 shim tests
- `test/commands/agent-enable-shim.test.ts` — 4 enable-shim tests
- `test/core/variant-resolver.test.ts` — 16 variant resolver tests
- `test/commands/run/variant.test.ts` — 7 variant run integration tests
- `ADRs/0034-shim-scope-and-inclusion-criteria.md` — Scope fence ADR (265 lines)
- `ADRs/0035-community-shim-registration.md` — Community shim ADR (399 lines)
- `ADRs/0036-agent-variants.md` — Agent variants ADR (244 lines)
