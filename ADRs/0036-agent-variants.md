---
status: proposed
date: 2026-05-02
---

# ADR-0036: Per-Agent Variants for Multi-Provider / Multi-Account Routing

## Context

`agent-manager` currently models each agent as a single fixed launch
command + env (Pillar 3). `src/core/agent-registry.ts:91-106` has one
`command` per built-in; `AgentProfileSchema` at `src/core/schema.ts:88-107`
exposes only `model: string` plus adapter passthroughs.

The 2026-05-02 all-pillars Codex review (P1 §4, P3 §4) identified this as
the single biggest schema gap: users want to run the SAME agent via
different backends without inventing parallel agent entries.

Concrete user scenarios the current schema can't express:
- `claude` via anthropic.com direct vs AWS Bedrock vs GCP Vertex vs OpenRouter
- `codex` via ChatGPT account vs OpenAI API key vs Azure
- `aider` via OpenRouter vs direct provider vs local vLLM
- Per-project selection: work project uses Bedrock, personal project uses
  anthropic.com direct, both entries named `claude`

Today the only workaround is creating separate catalog entries (`claude`,
`claude-bedrock`, `claude-vertex`) — each is a complete duplicate, all the
tier/command/permission metadata diverges, and `am run <agent>` can't
switch between them without renaming.

## Decision

Add a `variants` field to the agent schema. A variant is a named named
tuple of `{ protocol, command, args, env, permission_policy? }`. One
agent entry; many ways to launch it.

### TOML shape

```toml
[agents.claude]
# Default when `am run claude "..."` is invoked without --variant.
# If absent, the first-defined variant wins.
default_variant = "anthropic"

[agents.claude.variants.anthropic]
protocol = "acp"
command = "npx -y @agentclientprotocol/claude-agent-acp@latest"
# env takes secret refs (${VAR}) resolved through the existing envelope
# encryption layer (ADR-0012). No new credential store.
env = { ANTHROPIC_API_KEY = "${ANTHROPIC_API_KEY}" }

[agents.claude.variants.bedrock]
protocol = "acp"
command = "npx -y @agentclientprotocol/claude-agent-acp@latest"
args = []
env = {
  CLAUDE_CODE_USE_BEDROCK = "1",
  AWS_PROFILE = "work",
  AWS_REGION = "us-east-1"
}
# Variant-level permission override (optional). Unset → inherits class
# default ("deny" post-2026-05-02) + caller's explicit opt-in.
permission_policy = "auto-approve"

[agents.claude.variants.openrouter]
protocol = "acp"
command = "npx -y @agentclientprotocol/claude-agent-acp@latest"
env = {
  ANTHROPIC_BASE_URL = "https://openrouter.ai/api/v1",
  ANTHROPIC_API_KEY = "${OPENROUTER_API_KEY}"
}
```

### Resolution order (highest priority wins)

1. Explicit CLI flag: `am run claude --variant bedrock "..."`
2. Project config: `.agent-manager.toml` → `agents.claude.default_variant`
3. Global config: `agents.claude.default_variant`
4. **If none of the above produces a name, error with a clear
   "ambiguous: set default_variant or pass --variant" message.**

> **Note (2026-05-02 concurrent-review correction, Codex W1).**
> An earlier draft of this ADR said "First-defined variant wins." That
> is rejected: TOML table-order is not a durable API, JS object-order
> has integer-key quirks, and the hierarchical config merge can swap
> insertion order across layers. Requiring an explicit `default_variant`
> when multiple variants exist makes the resolution deterministic and
> reviewable. Single-variant cases still implicitly default (no
> ambiguity to resolve).

### Project vs global merge semantics

The existing hierarchical config merge (ADR-0003) uses a **shallow
merge on the `agents` section**. A project's `[agents.claude]` block
today REPLACES the global agent entry wholesale, which loses
`variants` defined globally.

This ADR requires one of two things for the MVP:

- **Option A (recommended):** deep-merge `agents.<name>.variants` and
  `agents.<name>.default_variant` specifically. Other fields keep
  shallow semantics. Documented in `src/core/config.ts`.
- **Option B (acceptable MVP):** variants are resolved from the RAW
  layers, not the merged config. The resolver walks project-config
  `agents.<name>.variants` + `default_variant` AS WELL AS global
  `agents.<name>.variants` + `default_variant`, merging at resolution
  time. The rest of the config merge stays shallow.

The implementation chooses Option B for the MVP because it's scoped
to the variant resolver and doesn't risk regressing existing
hierarchical-merge tests. A future ADR may promote Option A.

### Composition with existing layers

- **Secrets (ADR-0012):** variant `env` values using `${VAR}` resolve
  through the existing `interpolateEnvAsync` path. Secrets encrypted at
  rest; decrypted at spawn time. No new credential store.
- **Sandbox (ADR-0033 Phase B):** variant `env` is passed to
  `sandboxEnv(variantEnv)` on spawn. Allow-list behaviour unchanged —
  AWS/OpenAI/Anthropic prefixes still denied by default; variant must
  explicitly opt them in per-value.
- **Permission policy (2026-05-02 SEC-2):** variant MAY declare a
  `permission_policy` override in the schema, but **the MVP does not
  enforce it.** The field is accepted + echoed in dry-run output for
  transparency only. Wiring enforcement to `AmAcpClient.setPermissionPolicy`
  is a follow-up PR — shipping the schema without enforcement would give
  users a false sense of security (concurrent-review Codex W1 correction,
  2026-05-02). Until enforcement lands, the class default `"deny"` + the
  caller's explicit opt-in remain authoritative.
- **Agent tiers (ADR-0033):** tier classification is on the AGENT, not
  the variant. A tier-1-native agent stays tier-1 across all its
  variants. Shim wrappers (tier-2) can have variants too —
  `aider.variants.openrouter` overrides aider's model flag.

### CLI + MCP surface

- `am run <agent> --variant <name> [prompt]`
- `am run <agent> --list-variants` (dry-run adjacent, see ADR-0038)
- `am agent variants <agent>` — list variants + which is default
- `am agent variants set-default <agent> <variant>` — mutates config
  (auto-commits per ADR-0002)
- MCP tool: `am_agent_invoke` accepts `variant: string` parameter.
  Response includes `variant_used` for traceability.

### What the minimum viable implementation covers

Not everything. The MVP for this ADR's acceptance:

1. Zod schema in `src/core/schema.ts` accepts `variants` + `default_variant`
2. `am run --variant <name>` resolves through the order above
3. Resolved command+args+env flow to `AmAcpClient.connect` (ACP path only)
4. Tests lock the resolution order + reject unknown variants with a
   clear error ("variant 'bedrock' not defined for 'claude'; available: anthropic")

Out of scope (follow-ups, explicitly):
- A2A variants (same model should work; verify in Phase-2 implementation)
- `am_agent_invoke` MCP `variant` parameter (separate PR; needs tool-metadata ADR-0037 first)
- Per-variant permission policy override (added in the schema but not
  wired to enforcement in this MVP)
- `am agent variants` CLI subcommand (schema + `--variant` flag first;
  ergonomic subcommand is a later PR)

## Consequences

### Positive
- Single catalog entry per agent, many ways to launch. Matches how users
  think: "I want to use Claude, but via Bedrock today."
- Variant-scoped encrypted env reuses ADR-0012; no new cred store.
- Per-variant permission policy admits the real-world case where a
  corporate-gateway variant is genuinely safer to auto-approve than a
  direct-to-internet variant.
- Falls cleanly into Pillar 3 (protocol router) without crossing
  pillar boundaries.

### Negative
- `AgentProfileSchema` becomes more complex; more shapes to validate.
- `am run` flag surface grows. Discoverability concern — mitigated by
  `--list-variants` in the dry-run output.
- First-defined-wins default is a subtle ordering dependency. Projects
  importing a shared config need to understand that adding a new variant
  at the top of `variants` changes behaviour. We accept this; explicit
  `default_variant` is the escape hatch.

### Neutral
- No runtime perf impact — variant resolution is in-memory map lookup.
- ADR-0033 tier model unchanged; variants are below the tier abstraction.

## Alternatives Considered

**Separate top-level agent entries (`claude-bedrock`, `claude-vertex`).**
Today's workaround. Rejected — duplicates all non-variant metadata,
breaks tier inheritance, `am run <agent>` can't switch without rename.

**Variant as a profile-level concept** (e.g.
`profiles.work.agents.claude.variant = "bedrock"`). Appealingly orthogonal
but wrong place. Profiles select a SUBSET of a catalog; variants select a
BACKEND for the same entity. A user needing Bedrock-on-work-project-AND-
Vertex-on-personal wants profile × variant, which requires variants at the
agent level anyway. This ADR covers the primitive; profiles-select-variant
is a natural follow-up.

**Passing env via existing `settings.env`.** `settings.env` is a
single global map (`src/core/schema.ts:133-161`). Two variants of the
same agent can't both set `ANTHROPIC_BASE_URL` to different values.
Per-variant env is required.

**LiteLLM-style provider prefix (`model = "bedrock/claude-sonnet"`).**
Elegant for model routing but aider-specific; doesn't generalize to
Codex (which has no model string), Amazon Q (which has no model string
at all), or tier-3 catalog-only agents. Variant is the wider abstraction.

## References

- `docs/research/2026-05-02-all-pillars-review/03-protocol-router.md` §4
  — the TOML proposal originated here
- `docs/research/2026-05-02-all-pillars-review/00-synthesis.md`
  — Tier A1 rationale + cross-pillar impact
- ADR-0012 — envelope encryption (variants reuse it, don't replace it)
- ADR-0031 — pillar scoping (this is a Pillar 3 extension)
- ADR-0033 — agent tiers (unchanged by this ADR)
- ADR-0037 (proposed, not yet written) — per-tool MCP metadata.
  Once accepted, would add a `variant` parameter to `am_agent_invoke`.
- `src/core/schema.ts:88-107`, `src/core/agent-registry.ts:91-185`,
  `src/commands/run.ts:83-172`, `src/protocols/acp/env-sandbox.ts:63-71`

## Implementation notes (for the MVP PR)

When promoted to `accepted`, the implementation should:

1. Extend `AgentProfileSchema` with `variants` map + `default_variant`.
   Keep backward compat: existing configs without variants still work.
2. Add `VariantResolver` helper that takes `(agentName, variantName?,
   config, projectConfig)` and returns `{ command, args, env,
   permission_policy? }`.
3. Thread through `src/commands/run.ts:130-172` before `createAcpClient()`.
4. Update env-sandbox call: `sandboxEnv({ ...resolvedVariantEnv,
   ...opts?.env })`.
5. Emit `variant_used` in the `am run` return payload (dry-run and live).
6. Tests in `test/core/schema.test.ts` (schema), `test/commands/run/*`
   (resolution), `test/protocols/acp/variants.test.ts` (env flows through).

Opt-in flag for rollout: `AM_VARIANTS=1` env var gates the feature during
the first release after this ADR accepts. Remove the flag in the
release-after-next once adopted.
