---
status: proposed
date: 2026-05-02
---

# ADR-0035: Community Shim Registration Protocol

> **Precondition for ADR-0034 Phase E.** ADR-0034 §"Phase E routing" redirects
> the openclaw/acpx borrowing plan to "the community adapter path" and its
> §Tiebreaker rule defers close calls to "the community-adapter path (ADR-0027)."
> Both statements assume a working registration route for community-supplied
> ACP shims. **That route does not exist today.** ADR-0027 covers community
> *adapters* (detect/import/export/diff/schema) — it has no vocabulary for
> ACP shims, and `am-acp-shell` resolves only `BUILT_IN_SHIMS`. Until this
> ADR is accepted and implemented, ADR-0034's Phase-E language is vacuous:
> there is nowhere for a redirected proposal to land.
>
> This ADR is **design-only**. It proposes the registration protocol. No code
> in this repo changes on acceptance; implementation is tracked as a follow-up.

## Context

### What exists today

1. **Adapter loading (ADR-0027, shipped).** `am adapter install` writes an
   entry to `~/.config/agent-manager/adapters.toml`. At runtime, the registry
   proxies `detect`/`import`/`export`/`diff`/`schema` calls over JSON-RPC to a
   subprocess. This is the *IDE adapter* path — it has nothing to say about
   ACP spawning, prompt delivery, or agent runtime trust.

2. **Built-in shims (ADR-0033 Phase B).** `src/protocols/acp/shell-wrapper.ts`
   ships a `BUILT_IN_SHIMS` map keyed by agent name. Each entry is a
   `ShimConfig` (argv, prompt template, response extractor, timeout, env
   overlay). `am-acp-shell <agent>` resolves the name by table lookup; unknown
   names exit with code 2.

3. **Enable flow (ADR-0033).** `am agent enable-shim <name>` refuses if
   `!BUILT_IN_SHIMS[name]`. There is no mechanism for a user to register a
   new shim without editing this repo.

4. **Scope fence (ADR-0034, proposed).** Caps `BUILT_IN_SHIMS` at three
   entries and directs everything else to "the community-adapter path."

### The gap

ADR-0034's redirect needs an *ACP-shim* community path — a way for a user to:

- declare "agent X is an ACP shim I trust, wrapping CLI Y with these flags";
- have `am agent list` surface it as `tier-2-shim [community]`;
- have `am agent enable-shim X` accept it;
- have `am-acp-shell X` spawn it under the same PB-1/PB-3/PB-4 guard rails as
  first-party shims.

The existing `adapters.toml` is the wrong artifact: its entries describe
subprocess adapters that answer `adapter/*` methods, not shim configs that
feed `ShimAcpServer`. The two speak different protocols (JSON-RPC adapter
methods vs. ACP). Reusing the same file would conflate them.

### What makes shim registration distinct from adapter registration

| Dimension | Community adapter (ADR-0027) | Community shim (this ADR) |
|-----------|------------------------------|---------------------------|
| What runs | User-supplied executable implementing `adapter/*` JSON-RPC | Wrapped CLI (e.g. `aider`) driven by `ShimAcpServer` |
| am's role | Proxy JSON-RPC calls | Spawn CLI, deliver prompt, collect response, emit ACP frames |
| Config shape | `CommunityAdapterConfig` (source, command, checksum) | `ShimConfig` (argv, promptTemplate, responseExtractor, timeoutMs, env) |
| Trust posture | Runs as user; ADR-0027 trust warning on install | Inherits wrapped CLI's trust (auto-approves file writes per ADR-0033) |
| Spawn frequency | On-demand per `am` command | Per `session/prompt` turn |
| Protocol version gate | `adapter/initialize` handshake | ACP `PROTOCOL_VERSION` (baked into `am-acp-shell`) |

The shim path reuses ADR-0027's *supply-chain controls* (SHA pinning, git
audit trail, explicit install) but not its *runtime protocol*.

## Decision

Introduce **community shim registration** as a distinct registration surface
parallel to ADR-0027's `adapters.toml`. The protocol covers four concerns:

1. On-disk config schema
2. Trust and checksum model
3. Enable flow (`am agent enable-shim <community-name>`)
4. Resolution path inside `am-acp-shell`

No new first-party shims are proposed by this ADR. The three `BUILT_IN_SHIMS`
entries (aider, amazon-q, cody) remain capped per ADR-0034. Adding a fourth
still requires ADR-0034's ≥3-of-5 inclusion review; this ADR is purely about
the community alternative that the tiebreaker rule defers to.

### 1. Schema: `shims.toml`

A new file `~/.config/agent-manager/shims.toml` — sibling to `config.toml`
and `adapters.toml`, git-tracked, reinstallable:

```toml
# shims.toml — community ACP shim registrations (ADR-0035)
#
# Each [shims.<name>] entry describes a tier-2-shim agent that `am-acp-shell`
# can spawn. The <name> becomes the agent name in `am agent list`, `am run`,
# and `am agent enable-shim`.

[shims.plandex]
source        = "git+https://github.com/example/am-shim-plandex@v0.1.0"
command       = ["plandex", "tell", "--no-exec"]
prompt_template   = "arg-last"        # "stdin" | "arg-last" | "arg-named"
prompt_flag       = ""                # required only when prompt_template = "arg-named"
response_extractor = "stdout"         # "stdout" | "stderr" | "both"
timeout_ms        = 120000
env               = { OPENAI_API_KEY = "${OPENAI_API_KEY}" }
checksum          = "sha256:abc123…"  # REQUIRED for non-local sources
installed_at      = "2026-05-02T12:00:00Z"
enabled           = false             # user must run `enable-shim` to flip true
display_name      = "Plandex"
min_am_version    = "0.4.0"
upstream_homepage = "https://github.com/plandex-ai/plandex"
```

**Key differences from `adapters.toml`:**

- The `command` field is a flat argv array (matches `ShimConfig.command`),
  not a single executable path. Shims need multiple flags baked in.
- `prompt_template`, `prompt_flag`, `response_extractor`, `timeout_ms`, `env`
  map directly to `ShimConfig` fields in `shell-wrapper.ts` — no translation
  layer; the TOML is a serialization of the in-memory type.
- `enabled` defaults to `false` (unlike `adapters.toml` where adapter config
  existence implies activeness). Community shims inherit the wrapped CLI's
  trust, so explicit `enable-shim` is a PB-3/PB-4 gate, not just a convenience.

**Zod schema** (to live in `src/protocols/acp/community-shims/schema.ts` in
the implementation follow-up; quoted here so reviewers can evaluate coverage):

```ts
export const CommunityShimConfigSchema = z.object({
  source: z.string().min(1),        // "git+https://...", "npm:...", "local:./..."
  command: z.array(z.string()).min(1),
  prompt_template: z.enum(["stdin", "arg-last", "arg-named"]).default("stdin"),
  prompt_flag: z.string().optional(),
  response_extractor: z.enum(["stdout", "stderr", "both"]).default("stdout"),
  timeout_ms: z.number().int().positive().max(600_000).default(120_000),
  env: z.record(z.string(), z.string()).default({}),
  checksum: z.string().regex(/^sha256:[a-f0-9]{64}$/).optional(),  // see §2
  installed_at: z.string().datetime(),
  enabled: z.boolean().default(false),
  display_name: z.string().optional(),
  min_am_version: z.string().optional(),
  upstream_homepage: z.string().url().optional(),
});
```

**Validation rules:**

- `prompt_template === "arg-named"` ⇒ `prompt_flag` must be a non-empty,
  non-whitespace literal that starts with `-` (guards PB-3: the flag itself
  must be a literal baked into the shim, never user-controlled).
- `command[0]` is passed to `Bun.which` at enable time; installation fails if
  the binary is not on `PATH`.
- `source` starting with `local:` waives the checksum requirement (parity
  with `adapters.toml` `CommunityAdapterConfig`).
- `min_am_version` is checked at `am-acp-shell` spawn time; mismatch aborts
  with a clear error before the CLI runs.

### 2. Trust and checksum model

Reuse ADR-0027's supply-chain discipline, scaled to the shim's larger trust
surface:

- **Checksum is mandatory for non-local `source` values.** The format is
  `sha256:<64-hex>`, matching `adapters.toml`. Scope: the checksum covers the
  shim's *installation manifest* (the upstream repo's
  `am-shim-manifest.toml` or `package.json` "am-shim" block, TBD in the
  implementation ADR), **not** the wrapped CLI binary. Rationale: the wrapped
  CLI (aider, plandex, …) is installed separately via the user's package
  manager and has its own provenance — checksumming it here would be a false
  guarantee.
- **Install-time trust prompt.** `am shim install <source>` shows:
  - source URL and resolved commit/tag
  - argv that will be spawned (so the user can see the auto-approve flags)
  - trust-posture sentence (copied verbatim from the shim's manifest)
  - computed checksum
  Interactive confirmation required; `--yes` bypass is supported for
  scripted setups but logs a warning.
- **Tamper detection at enable time.** `am agent enable-shim <name>`
  recomputes the checksum from the on-disk artifact; mismatch aborts the
  enable with a clear error rather than silently re-installing.
- **Git-backed audit trail.** `shims.toml` is committed to the global config
  repo on install/enable/disable/remove (same pattern as `config.toml`).
- **TOFU prompt on source drift.** If `am shim update <name>` finds a new
  commit hash for a git-sourced shim, the user must confirm the new
  checksum before the old one is overwritten — parallel to the TOFU flow
  ADR-0027 prescribes for adapter upgrades.
- **No auto-discovery.** `shims.toml` is never populated except via
  `am shim install` or direct user edit. `am` never scans for shims on
  startup.

The trust posture is **stricter than adapters.toml** in one respect: the
`enabled` flag defaults to `false`. A `shims.toml` entry without an explicit
enable is a declaration, not a grant of authority. This mirrors
`BUILT_IN_SHIMS` + `am agent enable-shim` for first-party shims.

### 3. Enable flow

`am agent enable-shim <name>` is extended to resolve against both
`BUILT_IN_SHIMS` and `shims.toml`:

```
resolution order (first match wins):
  1. BUILT_IN_SHIMS[name]            — first-party
  2. shimsToml.shims[name]           — community
  3. error: unknown shim
```

The enable flow's user-facing behavior is unchanged (interactive trust
prompt, `--yes` bypass, writes a `runnable: true` flag into the agent
registry) with three additions for community shims:

- The trust banner labels the entry `[community]` and surfaces the `source`
  URL, so the user sees "this is not a first-party shim" before opt-in.
- Checksum reverification runs before the enable commits (per §2).
- If a `BUILT_IN_SHIMS` entry with the same name is later added in a future
  am release, the built-in takes precedence on resolution. `am agent list`
  flags the community entry as `shadowed` and suggests `am shim remove
  <name>` — this is the collision protocol.

`am shim install`, `am shim list`, `am shim remove`, and `am shim update`
are new CLI verbs paralleling `am adapter install` etc. They live under a
new `shim` command group to keep them separable from `adapter` (which
remains scoped to ADR-0027).

### 4. Resolution path inside `am-acp-shell`

Current (ADR-0033):

```ts
export async function serveShimOnStdio(agentName: string): Promise<number> {
  const shim = BUILT_IN_SHIMS[agentName];
  if (!shim) { /* exit 2 */ }
  return runShimServer(shim);
}
```

Proposed:

```ts
export async function serveShimOnStdio(agentName: string): Promise<number> {
  const shim = BUILT_IN_SHIMS[agentName] ?? await loadCommunityShim(agentName);
  if (!shim) { /* exit 2 — list both built-in AND enabled community names */ }
  return runShimServer(shim);
}
```

`loadCommunityShim(name)`:

1. Reads `shims.toml` (path resolution honors `AM_CONFIG_DIR`).
2. Returns `undefined` if the entry is absent or `enabled === false`.
3. Validates against `CommunityShimConfigSchema`.
4. Re-verifies checksum (fail closed on mismatch).
5. Projects the TOML row onto `ShimConfig` and returns it.

**Security invariants the community path MUST preserve** (these are the
PB-* guards from ADR-0033 — community shims get no exemption):

- **PB-1 env scrubbing.** `runShimServer` already routes through
  `sandboxEnv()`. Community `env` values go through the same allow-list and
  `${VAR}` interpolation — no new env-leak surface.
- **PB-3 argv injection.** `command` entries are literal argv elements.
  `prompt_flag` must be validated as starting with `-` and containing no
  whitespace before the shim is accepted. The user's prompt is still never
  interpolated into `command[]`; the only delivery paths are the three
  existing templates.
- **PB-4 output redaction.** Redaction is the MCP boundary's job, not the
  shim's. No change.
- **Timeout ceiling.** `timeout_ms` is capped at 600 000 (10 minutes) by the
  schema — community shims can't set indefinite timeouts that pin processes.

No changes to `ShimAcpServer` itself. The resolution layer is the only new
code; `runShimServer` does not need to know whether its `ShimConfig` came
from a built-in map or a TOML row. This is the property that makes the
design safe: the hot path is identical.

### What this ADR does NOT decide

- **Distribution ecosystem.** Whether shims are distributed as npm packages,
  git repos, both, or via a dedicated marketplace is deferred to the
  implementation ADR. The `source` field accepts arbitrary prefixed strings
  for now.
- **Manifest format.** Whether the upstream manifest is `am-shim-manifest.toml`
  standalone, `package.json#am-shim`, or both — deferred.
- **Promotion path.** When a community shim becomes popular enough to
  warrant first-party status, ADR-0034's ≥3-of-5 criteria still apply. This
  ADR does not create a shortcut.
- **Cross-machine sync.** Whether `shims.toml` syncs through the existing
  global-config git repo or a dedicated one. The expected default is "same
  repo as `config.toml`," but ADR-0025's multi-backend concerns apply and
  are out of scope here.

## Consequences

### Positive

- **Unblocks ADR-0034 §Tiebreaker and §"Phase E routing".** Both clauses
  defer to "the community-adapter path"; this ADR makes that path real for
  ACP shims. The 10 openclaw agents can now be packaged as community shims
  without editing `BUILT_IN_SHIMS`.
- **First-party cap preserved.** No new entries in `BUILT_IN_SHIMS`; the
  ≥3-of-5 gate in ADR-0034 remains the only way to promote.
- **`ShimAcpServer` stays pure.** Community shims ride the same runtime code
  path as built-ins — only the resolution layer is new. The hot path is
  identical, which is what makes the PB-* invariants transferable.
- **Mental-model parallel with ADR-0027.** Users and reviewers see the same
  install/trust/checksum/TOFU ceremony in a second place.

### Negative

- **Two registration files to maintain.** `adapters.toml` and `shims.toml`
  now both exist. Docs and `am doctor` must explain the distinction.
- **Command-namespace inflation.** `am shim install/list/remove/update`
  duplicates `am adapter …`. Accepted — parallel namespaces are clearer than
  multiplexing on one verb.
- **Schema drift risk.** `ShimConfig` (TS) and its TOML mirror must stay in
  sync; the implementation ADR MUST derive one from the other.
- **Trust-posture confusion.** `[community]` shims inherit the wrapped CLI's
  `--yes` auto-approve just like `[first-party]` shims do; the install-time
  trust banner is the only thing that surfaces this — it must be prominent.
- **Checksum scope limitation.** The manifest checksum covers the shim's
  install manifest, not the wrapped CLI binary itself. Users who assume
  defense-in-depth we don't provide would be misled; the docs must be
  explicit that wrapped CLI provenance is the user's responsibility.

### Neutral

- **No code lands with this ADR.** Implementation is a follow-up; ADR-0034's
  language becomes operational at the *decision* level now, at the *code*
  level when the implementation ADR ships.
- **Marketplace-pillar overlap.** Whether `shims.toml` becomes a sub-feature
  of ADR-0031 Pillar 4 (marketplace) or stays a peer of `adapters.toml` is
  a presentation question the implementation ADR can answer.

## Alternatives Considered

**Reuse `adapters.toml`.** Squeeze shim configs into a new adapter type
inside `adapters.toml`. Rejected — shims don't implement the adapter JSON-RPC
protocol, they're a `ShimConfig` fed to `ShimAcpServer`. Conflating the two
into one file would force a discriminator union in the Zod schema and
cross-wire code paths that should stay separate. Two files, two purposes.

**Inline shim configs in `config.toml`.** Add a `[shims.<name>]` section to
the existing main config. Rejected — `config.toml` is the user's catalog
(servers/instructions/skills/agents/profiles) and its Zod schema is
deliberately locked. Shims are an installed-artifact list more like
`adapters.toml` than a catalog entry. They also need a checksum field that
doesn't belong in `config.toml`.

**Make all shims community.** Remove `BUILT_IN_SHIMS` entirely and ship a
default `shims.toml` with the three entries. Rejected — would invert
ADR-0033's trust model. Built-in shims ship with the binary and are
trusted by release provenance; collapsing them into `shims.toml` would
require every new am install to re-run trust prompts for the defaults.
Also would orphan `am-acp-shell` during first-boot before `shims.toml`
exists.

**Use `adapter/initialize`-style protocol for community shims.** Require
community shims to be subprocesses that speak an RPC protocol, like
community adapters. Rejected as overkill — `ShimConfig` is ~100 bytes of
static declaration. A subprocess layer would add ~50-100 ms per session
prompt (per ADR-0027's own spawn cost note) for zero benefit — there's no
logic to host in the subprocess. The shim's logic already lives in
`ShimAcpServer`.

**Delegate entirely to external tooling (mise, asdf, pipx).** Recommend
users install shim configs via an OS package manager. Rejected — am owns
the trust boundary (PB-1/PB-3/PB-4 guards) and the enable flow. An external
tool can't gate `am-acp-shell`'s resolution or emit the right audit trail
into the global config repo.

**Skip this ADR; require all community shims to be promoted to first-party
via ADR-0034.** Rejected — that recreates the bottleneck ADR-0034
explicitly designed to avoid, and it silently makes ADR-0034's
"community-path default" rhetoric unusable.

## References

- [ADR-0026](./0026-acpx-acp-runtime-integration.md) — ACP runtime, the
  protocol shims plug into
- [ADR-0027](./0027-community-adapter-loading.md) — community adapter
  protocol this ADR parallels (but does not extend directly)
- [ADR-0031](./0031-product-scope-and-pillars.md) — Pillar 3 (protocol
  router) and Pillar 4 (marketplace) alignment
- [ADR-0032](./0032-terminology-glossary.md) — Registry vs Marketplace
  distinction (shims live on the Marketplace side)
- [ADR-0033](./0033-acp-agent-tiers-and-shim-wrapper.md) — introduces
  `BUILT_IN_SHIMS`, `am-acp-shell`, `enable-shim` — the surface this ADR
  extends to community entries
- [ADR-0034](./0034-shim-scope-and-inclusion-criteria.md) — Phase-E
  redirect and §Tiebreaker rule that depend on this ADR being accepted
- `src/protocols/acp/shell-wrapper.ts` — `BUILT_IN_SHIMS`, `ShimConfig`,
  `ShimAcpServer` (no changes in this ADR)
- `src/commands/agent-enable-shim.ts` — the enable-flow entry point that
  gains the community-resolution step
- `src/adapters/community/{types,loader,proxy}.ts` — reference for supply-
  chain patterns (source pinning, checksums, `adapters.toml`) that inform
  `shims.toml`'s design
