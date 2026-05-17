---
status: accepted
date: 2026-05-16
accepted: 2026-05-17
amends: ADR-0039
---

# ADR-0052: Marketplace v1 Code Removal Target

## Context

[ADR-0039](0039-marketplace-v1-scope-decision.md) (accepted 2026-05-05)
retired pillar 4 (Marketplace) in favor of MCP Package Registry
([ADR-0024](0024-mcp-registry-integration.md)) for servers and git-subtree
/ git-submodule vendoring for skill/instruction/agent bundles. ADR-0039
committed to a **removal target of v1.0** for the deprecated
`src/marketplace/*` surface and the `am marketplace *` command group, but
deliberately deferred the *mechanics* of removal — the precise release,
deletion sequencing, post-removal CLI behavior, and treatment of users
who installed bundles via the deprecated path.

The current package version is `0.5.0-rc6` (`package.json`). The
deprecation surface that ADR-0039 mandated is in place: every module under
`src/marketplace/` and `src/commands/marketplace.ts` carries a
`@deprecated Marketplace v1 is retired per ADR-0039.` JSDoc on its public
entry points, and any `am marketplace *` invocation prints to stderr:

```
WARNING: am marketplace is deprecated per ADR-0039 and will be removed. See ADRs/0039 for migration path.
```

(single source of truth: `src/commands/marketplace.ts:20-21`). This ADR
is *follow-through* on ADR-0039's commitment, not net-new policy. It
does not re-litigate whether to retire the marketplace; that question
is closed.

The open mechanics questions this ADR resolves are:

- **Deletion sequencing.** Does the removal land in one atomic PR, or
  staged (commands first, internals later)? ADR-0039's no-callers
  verification (gate 4) established that `src/marketplace/*` has no
  production importers outside the deprecated `src/commands/marketplace.ts`,
  so staging produces no integration value.
- **Post-removal CLI behavior.** What happens when a user runs
  `am marketplace add <url>` after the removal release? Special-cased
  "this command was removed" stub, or the standard citty "unknown
  command" error?
- **Vendored bundles.** Any developers who experimented with
  `am marketplace add <url>` during the 0.4–0.5 development cycle may have
  orphan entries in their `state.toml` / installed-plugin registry. The
  product has not shipped to npm so this population is small in practice,
  but the migration story still needs to be specified for completeness.
  There is no auto-migration to the git-subtree path; that path is manual
  by ADR-0039's design.
- **Doc/README scrub.** README.md still carries a "Marketplace
  (deprecated)" section and pillar-4 retirement language pointing at
  ADR-0039. These have to come out in the same PR that removes the
  code, leaving only a CHANGELOG pointer.
- **Choice of release.** ADR-0039's "removal target v1.0" admits two
  defensible interpretations: cut the implementation in `0.6.0` (next
  minor — the warning has been in flight for a full minor cycle), or
  cut it in `1.0.0` (symbolic — v1 has no marketplace surface from day
  one). They are not equivalent; they differ in how long deprecated
  code rides the release train.

## Decision

This ADR commits to all of the following, taken together as the
removal plan:

- **Removal version: `0.6.0`.** The implementation is deleted in the
  first `0.6.0` release. `1.0.0` remains the symbolic milestone, but
  no marketplace surface is present from `0.6.0` onward — `1.0.0`
  inherits a marketplace-free codebase. This is the staged
  interpretation of ADR-0039's "v1.0 removal target": next-minor cut,
  v1.0 stable. The choice between `0.6.0` and `1.0.0` is itself a
  sub-decision and is explicitly justified in *Alternatives Considered*
  below.
- **Grace period: the entire `0.5.x` line.** Current `0.5.0-rc6` and
  every subsequent `0.5.x` (including stable `0.5.0` and any patch
  releases) ships the deprecated surface unchanged. The stderr
  warning text at `src/commands/marketplace.ts:20-21` is the only
  signaling channel; **no `0.5.x` may strengthen the warning to a
  hard error** — that would be the breakage of `0.6.0` shipped under
  a `0.5.x` patch version, which violates SemVer
  ([SemVer §4](https://semver.org/#spec-item-4) — the 0.y.z
  initial-development clause permits any change in a minor bump,
  including the eventual removal in `0.6.0`, but once a deprecation
  contract is established, strengthening it within the same minor
  line is the breakage we are choosing not to inflict mid-grace-period).
  One full minor of warning is the standard grace period and is what
  we get.
- **Single atomic deletion PR.** The removal PR deletes, in one
  commit:
  - `src/commands/marketplace.ts`
  - `src/marketplace/` (all 7 files: `client.ts`, `installer.ts`,
    `scanner.ts`, `schema.ts`, `security.ts`, `types.ts`,
    `validate.ts`)
  - the `marketplace` subcommand registration in `src/cli.ts`
  - `test/commands/marketplace.test.ts` and the entire
    `test/marketplace/` directory
  - the README's "Marketplace (deprecated)" section and the pillar-4
    retirement language at the locations described in *Doc/README
    scrub* below
  Staging (e.g. delete the command surface in one PR, the internals
  later) is rejected: ADR-0039's gate 4 verified that
  `src/marketplace/*` has no production importers outside the
  deprecated command file, so staging produces no integration value
  and only invites drift between the two PRs.
- **Post-removal CLI behavior: no stub.** With the citty subcommand
  gone, `am marketplace add <url>` returns the standard citty
  "unknown command" error and a non-zero exit. We do **not** add a
  special-cased "this command was removed; see ADR-0039" stub. The
  stderr warning has been pointing users to ADR-0039 for the full
  lifetime of `0.5.x`; post-removal silence (modulo the standard
  unknown-command error) is acceptable. A stub carries the same
  ADR-0039 maintenance debt at lower cost but non-zero, and "we
  removed this and now also have to maintain the removal stub" is
  exactly the kind of vestigial surface the deletion was meant to
  eliminate.
- **Vendored bundles: manual migration only.** Any developers with
  orphan entries in `state.toml` / installed-plugin registry from
  experimental `am marketplace add <url>` runs during the 0.4–0.5
  cycle are not auto-migrated. Per ADR-0039, the supported path is
  `git subtree add` (or `git submodule`) plus `am import`, both of
  which are manual by design. This is a one-time user-facing break;
  the `0.6.0` release notes MUST call it out explicitly with a
  pointer to ADR-0039 for the migration recipe and to this ADR for
  the removal commitment.
- **Doc/README scrub.** The same removal PR deletes the README's
  §Marketplace (deprecated) section and the pillar-4 retirement
  language wherever it appears in README.md (the §The six pillars
  list and the §Bundles from git section). The only post-removal
  mention of the marketplace lives in CHANGELOG.md as a single line:
  `(removed in 0.6.0; see ADR-0039 / ADR-0052)`. AGENTS.md, having
  already had its marketplace marketing scrubbed under ADR-0039 gate
  3, requires no further edit.

This ADR was promoted to `accepted` on 2026-05-17 after maintainer
sign-off and adversarial review (4 defects fixed). The `0.6.0`
release-engineering checklist will absorb the deletion PR per the
plan above.

## Consequences

### Positive

- **Removes ~1500 LOC** from the codebase — `src/marketplace/*` (1,612
  LOC per ADR-0039's evidence inventory) plus the command surface
  and tests. The product becomes materially smaller and the public
  surface area more honest.
- **Eliminates the largest open supply-chain surface.** Even after
  Wave 1's B-01 hardening (command allowlist + prompt-on-novel-executable
  + `sandboxEnv()`) the marketplace installer remains the most
  attack-prone code path in the product. Deleting it removes that
  class of risk entirely.
- **Aligns docs with code.** README's "Marketplace (deprecated)"
  section and the pillar-4 retirement language are vestigial reading
  experience for new users; they describe a surface that was already
  not the recommended path. After the scrub, the docs describe what
  the product actually does.
- **Frees CI/test minutes.** `test/marketplace/` contributes test
  files and assertions to every CI run on a frozen surface that has
  no shipping callers. Deletion removes that ongoing cost.
- **Closes the "what is the marketplace v1 API?" question
  permanently.** ADR-0039 already answered "there isn't one"; this
  ADR makes that answer load-bearing in the binary.

### Negative

- **Hard cliff for any private downstream pinned to `src/marketplace/*`
  internal exports.** ADR-0039's gate 4 verified no *in-tree*
  callers, but a private fork or an unpublished consumer outside this
  repo is not visible to that verification. Any such consumer breaks
  at the `0.6.0` upgrade with no migration assistance from this
  project.
- **Users who delayed the migration must do it on a known cliff.**
  The migration to git-subtree is manual. Users who took the
  deprecation warning as informational rather than urgent will hit
  the break the moment they `am upgrade` to `0.6.0`. Release notes
  mitigate but do not eliminate this.
- **Loses the marketplace test corpus as a regression net.** Even
  for the non-marketplace code that the marketplace tests
  incidentally exercised (config resolution, secret decryption,
  filesystem layout), the deletion removes those incidental
  assertions. Coverage of those subsystems comes from their own
  test directories, but the redundancy goes away.
- **Decision is irreversible at low cost.** Re-introducing a
  marketplace surface after deletion requires re-litigating
  ADR-0039's alternative A (commit to v1, find a customer, build a
  catalog spec, accept the supply-chain costs) from scratch. The
  intermediate state ("deprecated but still shippable") is
  destroyed by this change. We are choosing not to keep that
  optionality.

### Neutral

- **MCP Package Registry path is unchanged.** ADR-0024's flow (browse,
  install, pin) is unaffected; it has always been the pillar-1 path
  for servers and continues to be.
- **git-subtree bundle pattern is unchanged.** ADR-0039 documented it
  as the manual path for skill/instruction/agent bundles; this ADR
  neither extends nor restricts it.
- **Pillar-4 documentation is already retired.** ADR-0031 amendments
  already mark pillar 4 as "MCP Registry + git-vendored bundles."
  This ADR removes the *implementation* of the retired pillar but
  changes nothing about the pillar-level documentation.
- **`0.5.x` users see no behavior change.** The stderr warning text,
  command surface, and B-01 hardening posture are all preserved
  through the entire `0.5.x` line. The `0.6.0` release is the only
  inflection point.

## Alternatives Considered

### Option A — Delete in `0.6.0` (chosen)

Delete the marketplace surface in the next minor release, `0.6.0`,
treating one full minor of stderr warning (the entire `0.5.x` line)
as the standard grace period.

**Selected because:**

- The deprecation warning has been in flight since the `0.5.0-rc`
  series, so users and downstreams have had a full release cycle
  of notice by `0.6.0`.
- v1.0 should not ship deprecated code into the stable line. ADR-0039
  named "v1.0" as the removal target; the cleanest reading is that
  `0.6.0` cuts the implementation and `1.0.0` ships clean.
- One PR delivers the removal cleanly; no additional release-engineering
  ceremony is required beyond a release-notes call-out.

### Option B — Delete in `1.0.0` (symbolic milestone)

Read ADR-0039's "v1.0 removal target" literally: the deletion lands
*in* `1.0.0`, which means the deprecated surface ships through the
entire `0.6.x`–`0.9.x` range.

**Rejected because:**

- Ships deprecated code through multi-quarter `0.6.x`–`0.9.x`
  development, with stderr warnings printed every release for a
  surface no maintainer is investing in.
- Continues to spend CI minutes and test maintenance on a frozen
  surface for the same multi-quarter window. The marginal cost per
  release is small but the cumulative cost is non-trivial.
- Materially delays freeing the supply-chain surface — the largest
  positive consequence in this ADR — for no proportional user
  benefit. Users who haven't migrated by the end of `0.5.x` are not
  meaningfully more likely to migrate during `0.6.x` or `0.7.x`;
  they migrate when the cliff arrives.
- Symbolic alignment is a weak rationale against multi-quarter cost.

### Option C — Hard error in `0.6.0`, delete in `1.0.0`

Strengthen the warning to a hard non-zero exit in `0.6.0`
(`am marketplace add ...` prints "removed; see ADR-0039" and exits
1), then delete the implementation in `1.0.0`.

**Rejected because:**

- A hard error in `0.6.0` and a code deletion in `0.6.0` are
  functionally identical for users running marketplace commands in
  automation: their script breaks at `0.6.0` either way.
- Doing both adds release-engineering cost (one breaking change in
  `0.6.0`, another deletion-shaped change in `1.0.0`) with no user
  benefit beyond what Option A already provides.
- If we are willing to fail the user's script in `0.6.0` (which we
  are; that is the deprecation-warning premise), we are willing to
  delete the code in `0.6.0`.

### Option D — Keep frozen indefinitely

Leave the deprecation warning in place forever; never delete the
code. The surface stays installed-but-discouraged in perpetuity.

**Rejected because:**

- ADR-0039 explicitly committed to a "removal target v1.0," so
  perpetual freezing contradicts a decision already accepted.
- The supply-chain surface persists indefinitely; B-01 hardening
  remains load-bearing maintenance forever.
- The CI/test/lint cost on the frozen surface compounds across
  every release with zero offsetting customer benefit.

Listed only to make the decision chain auditable; this option is
not viable under ADR-0039.

## References

- [ADR-0024 MCP Registry integration](0024-mcp-registry-integration.md)
- [ADR-0031 Product scope and pillars](0031-product-scope-and-pillars.md)
- [ADR-0032 Terminology glossary](0032-terminology-glossary.md) — Registry vs Marketplace
- [ADR-0039 Marketplace v1 scope decision](0039-marketplace-v1-scope-decision.md) — primary parent; this ADR is its removal-mechanics follow-through
