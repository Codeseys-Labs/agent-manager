# Lens E — ADRs 0037 / 0038 / 0039: Current State and Acceptance Roadmap

Date: 2026-05-05
Scope: Per-tool MCP metadata (0037), dry-run/explain surface (0038),
marketplace v1 retirement (0039). Audit of what is actually in `main`,
what the ADRs require before `accepted`, and how best-of-class peers
(MCP upstream, Terraform/kubectl, Homebrew/Artifact Hub) treat the same
problems.

---

## ADR-0037 — Per-tool MCP metadata (`x-am.*`)

### Current state

Phase 1 has shipped. The ADR front-matter records
`phase_1: shipped in commit 707105b (2026-05-03)`
(ADRs/0037-per-tool-mcp-metadata.md:4-7) and the code backs it up:

- `AmToolMetadata` interface is defined at
  src/mcp/server.ts:100-107 with exactly the fields ADR-0037 §Shape
  specifies (group, tier, auth_required, deprecated, optional
  `deprecation`, progress_supported).
- `DEPRECATED_ALIASES` registry at src/mcp/server.ts:118-125 gives
  five aliases scheduled for v0.4 removal — each flows into `tools/list`
  without hand-editing.
- `PROGRESS_SUPPORTED` set at src/mcp/server.ts:133-139 drives the
  `progress_supported` hint, derived from actual `ctx.emitProgress`
  call sites.
- `buildToolMetadata()` at src/mcp/server.ts:568-582 is a pure
  derivation — no I/O, takes `(toolName, tier)` and reads from the two
  registries above.
- It is wired into `tools/list` at src/mcp/server.ts:3005 —
  `"x-am": buildToolMetadata(t.def.name, t.tier)`. Every tool gets it.

Phase 2 (`output_schema`) and Phase 3 (`error_codes`, `progress_shape`)
are deferred (ADRs/0037-per-tool-mcp-metadata.md:6-7) and not started.

### Missing gates

ADR-0037 is `status: proposed`. Promoting to `accepted` requires:

1. Phase 1 acceptance criterion: confirm every tool in `defineTools()`
   round-trips `x-am`. There are 38 tools and one derivation site, so
   coverage is mechanical — a single "every entry has x-am with
   non-empty group+tier" test would close it.
2. Client contract doc. Spec at ADRs/0037-per-tool-mcp-metadata.md:92-106
   enumerates the fields but there is no `docs/mcp/x-am.md` or equivalent
   that third-party clients can link against. A builder using `am mcp-serve`
   still has to read the ADR + source to know which fields are stable.
3. Phase 2/3 deferral is acceptable but the ADR should carry a
   follow-up pointer ("see issue #N for output_schema coverage plan")
   so it doesn't rot.

### Best-in-class reference

The upstream MCP spec has been moving in this direction. The
2025-03-26 revision introduced five standard *tool annotations* —
`readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`,
plus `title` — authored by Anthropic's Basil Hosmer
(mcpblog.dev 2026-03-13). The 2025-11-25 revision
(modelcontextprotocol.io/specification/2025-11-25/server/tools) adds
`outputSchema`, `execution.taskSupport`, and `icons` as first-class
fields, and community SEPs are pushing `sensitiveHint` + `egressHint`
+ `reversibleHint` to close the "lethal trifecta" gap.

Mapping vs `x-am`:

| x-am field        | Upstream equivalent                              |
|-------------------|--------------------------------------------------|
| `tier`            | `readOnlyHint` + `destructiveHint` combination   |
| `auth_required`   | no upstream analogue (am-specific)               |
| `deprecated`      | no upstream analogue                             |
| `progress_supported` | implicit from `_meta.progressToken` contract |
| `group`           | no upstream analogue                             |
| (future) `output_schema` | upstream `outputSchema` (landed)           |

The `x-` prefix is the right long-term call — ADR-0037 already
flags forward-compat with upstream standardization (lines 206-210).
But the ADR should explicitly document the overlap with `readOnlyHint`
/ `destructiveHint` / `outputSchema` now that those are in the spec,
and commit to *emitting both* when upstream fields are applicable.
That way am-specific clients keep `x-am`, generic clients get standard
annotations, and neither is a second-class citizen.

### Recommended next step

1. Land a minimal conformance test (38/38 tools have `x-am`), a
   `docs/mcp/x-am.md` reference, and a dual-emission addendum:
   whenever `tier == "read-only"`, also set `readOnlyHint: true`;
   whenever `tier == "write-*"`, set `readOnlyHint: false` and
   `destructiveHint: true|false` based on the tool's actual effect.
2. Promote to `accepted`.
3. Phase 2 (`output_schema`) gets its own ADR with a small-batch
   rollout plan (5 high-value tools first: `am_apply`,
   `am_agent_invoke`, `am_status`, `am_registry_search`,
   `am_session_export`) rather than 38-at-once.

---

## ADR-0038 — Dry-run / explain surface pattern

### Current state

Partial. `am run <agent> --dry-run` is the ADR's named MVP and it
shipped: src/commands/run.ts:117 (opts flag), :138 (payload type),
:292-407 (payload builder), :445 (emitter), :560-563 (short-circuit
before subprocess spawn), :897-904 (flag wiring). The ADR-0038 JSON
shape (`action`, `would_do`, `reads_only`, `mutations_prevented`,
`explanation`) is honored.

`am apply --dry-run` is also wired — src/commands/apply.ts:10 declares
the flag, :27 passes it through to `applyResolved`, and :64-71 emits
the "would write" preview with per-adapter file list. The JSON envelope
at apply.ts:88-110 matches the ADR-0037 `output_schema` example almost
verbatim (action, profile, dryRun, results[adapter,status,files,...]).

However, `--diff` and `--force` (apply.ts:11-12) are still declared
but **not wired to anything** — the ADR's §Context §Pillar 1 bullet
identifies this explicitly and the code has not moved. These two flags
sit in the args block without consumers.

Other coverage-plan items from the ADR (lines 112-125):

- `am import` — ADR-0028 `--report` flag exists; has not been
  renamed/aliased as `--dry-run` for convention consistency.
- `am marketplace install` — no dry-run (search of
  src/commands/marketplace.ts for `dryRun`/`dry-run` returns zero).
  This matters less now given ADR-0039 retirement but is still the
  current shipped surface.
- `am wiki sync` — src/commands/wiki.ts:1504 already has `--dry-run`
  emitting structured JSON (lines 1565-1580); alignment with the
  shared ADR-0038 envelope shape should be verified.
- `am install` / `am uninstall` / `am update` / `am mcp-superset` /
  `am secrets-rotate` / `am secrets-migrate` all carry `--dry-run`
  flags (see `dry-run|dryRun` ripgrep across src/commands). Each
  was implemented independently — envelope conformance to the
  ADR-0038 shape is not systematically enforced.

### Missing gates

The ADR is `status: proposed`. Before `accepted`:

1. Wire `--diff` / `--force` through `apply.ts` or delete them.
   Having declared-but-unused flags is exactly the "preview invisible
   until after the fact" problem the ADR calls out.
2. Rename/alias `am import --report` to `--dry-run` per ADR-0038
   coverage-plan item 4.
3. A shared `DryRunEnvelope<T>` TypeScript type in `src/lib/` (or
   `src/core/`) and a lint rule / test that every dry-run emitter
   uses it. Today each command hand-rolls its own shape.
4. Deprecation warning surface for `am marketplace install` is now
   tied to ADR-0039; the ADR-0038 coverage-plan bullet for it
   becomes "deprecate, don't add."

### Best-in-class reference

Terraform `plan` is the gold standard: it runs full provider
resolution, emits a structured diff, and can be saved to a file that
`apply` later consumes verbatim (developer.hashicorp.com/terraform/cli/
commands/plan; oneuptime 2026-02-23 on HCP "structured run output").
kubectl goes one better with two modes: `--dry-run=client` (validate
locally, same as Terraform plan semantics) and `--dry-run=server`
(round-trip through the API server for admission-controller validation
without persistence).

Implications for agent-manager:

- Saving a dry-run for later `apply -f plan.json` is a credible
  evolution of ADR-0038 once the shared envelope is stable. It
  pairs with ADR-0039's "no marketplace, use git" to make
  preview/apply auditable.
- Two-mode dry-run is worth considering for `am apply`: a `client`
  mode (current behavior — validate locally) and a `server` mode
  that hits `am sync push --dry-run` to validate against a
  hosted worker (pillar 5/6). Out of scope for ADR-0038 but
  anticipated by its Coverage-plan item 5.

### Recommended next step

Close gates (1)-(3) above in a single PR. The `DryRunEnvelope<T>`
type is the load-bearing change — without it, conformance drifts as
new commands land. Promote to `accepted` once `apply` wires the
remaining flags and `import` aligns naming.

---

## ADR-0039 — Marketplace v1 retirement

### Current state

Proposed, not yet acted on. The ADR retires pillar 4, redirects users
to (a) MCP Registry (ADR-0024) for servers, (b) `git subtree add` for
skills/instructions/agents bundles.

Shipped code is unchanged:
- src/marketplace/ still contains 7 files (client, installer,
  scanner, schema, security, types, validate) — ~1,612 LOC per
  ADR-0039 line 48.
- src/commands/marketplace.ts has no `@deprecated` JSDoc and no
  stderr deprecation warning (ripgrep `ADR-0039|0039` in src/ returns
  zero). The `am marketplace install` command at line 173-199 runs
  installer code without any of ADR-0039's gate-2 requirements.
- README.md:5, 169, 173-175 still markets "browse and install plugins
  from git-based marketplaces" — gate-3 scrub not done.
- ADR-0031b (pillar 4 amendment) does not exist (search for `0031b`
  and `pillar-4` in ADRs/ returns zero). ADR-0031a (pillar 6) shipped,
  so the amendment pattern is in place.

### Missing gates

ADR-0039 itself enumerates verification gates (lines 206-225). All
five remain open:

1. ADR-0031b amendment: not written.
2. `@deprecated` JSDoc + stderr warning: not present
   (installer.ts grep confirms).
3. README / AGENTS.md scrub: not done.
4. No-callers verification: not relevant yet since code is active.
5. v1.0 removal milestone tracking: not present.

### Best-in-class reference

The "git-backed bundle" pattern the ADR endorses is exactly how
Homebrew **taps** work: `brew tap <user>/<repo>` clones a GitHub
repo named `homebrew-<repo>` into `$(brew --repository)/Library/Taps`,
and thereafter formulae in that tap are addressable via
`<user>/<repo>/<formula>` (docs.brew.sh/Taps). The trust model is "you
chose to add this URL." No central catalog, no manifest schema, no
signature — just git + a directory convention.

Helm **Artifact Hub** (artifacthub.io) is the counter-example: it
centralizes discovery across chart repos, plugins, and operators, but
the *distribution* is still git/OCI registries underneath.
Artifact Hub is a discovery layer on top of an existing
distribution substrate, not a replacement for it.

OpenVSX (for VS Code extensions) inverts this: a centralized registry
that signs extensions but imports from VSIX artifacts rather than git.
It provides the signature/reputation layer ADR-0039 explicitly calls
out as "materially expensive" (lines 178-181) and declines.

Conclusion for agent-manager: ADR-0039's choice is sound. git-subtree
is the Homebrew-tap model; Artifact-Hub-style discovery can be added
later as a read-only index on top of git URLs without reviving the
marketplace installer surface. The OpenVSX-style signature layer is
a separate future ADR if supply-chain threat model demands it.

### Recommended next step

Execute gates 1-3 in a single PR:

1. Write `ADRs/0031b-pillar-4-amendment.md` mirroring ADR-0031a.
2. Add `@deprecated` JSDoc to the four public entry points
   (`src/marketplace/installer.ts`, `security.ts`, `client.ts`,
   `src/commands/marketplace.ts`) and emit a single-line stderr
   notice on first `am marketplace *` invocation per process
   (reuse the `warnDeprecated()` pattern at src/mcp/server.ts:591-598).
3. README + AGENTS.md scrub of the "many marketplaces" marketing copy.

Then promote ADR-0039 to `accepted`. Draft the
`docs/guides/bundle-from-git.md` companion (ADR-0039 line 98) as a
follow-up, unblocked by the promotion.

---

## Cross-cutting observation

All three ADRs share an *acceptance-gate pattern* that is healthy:
each enumerates explicit conditions before `proposed → accepted`. The
weakest link across the three is documentation — x-am has no client
reference, ADR-0038 has no shared envelope type, ADR-0039 has no
git-subtree guide. A single Wave that ships (a) `docs/mcp/x-am.md`,
(b) `src/lib/dry-run-envelope.ts` + `docs/cli/dry-run.md`, and (c)
`docs/guides/bundle-from-git.md` + ADR-0031b would close all three
ADRs' documentation debt at once and make each promotable.
