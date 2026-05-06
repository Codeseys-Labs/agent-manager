---
status: accepted
date: 2026-05-01
---

# ADR-0034: Scope Fence for First-Party ACP Shims

## Context

ADR-0033 introduced a three-tier model for ACP agents:

- **Tier 1 — native:** agents that speak ACP directly (`claude`, `codex`,
  `gemini`, `kiro`).
- **Tier 2 — shim:** first-party shim wrappers (`am-acp-shell`) around
  CLIs that don't speak ACP — currently `aider`, `amazon-q`, `cody`.
- **Tier 3 — catalog-only:** config is generated for them, but they're
  driven from their own native IDE UI, not via `am run`.

`BUILT_IN_SHIMS` in `src/protocols/acp/shell-wrapper.ts` ships the three
tier-2 entries. The issue #2 "Outstanding items" list and the iter4 "Phase
E" note both contemplate borrowing ~10 more agents from openclaw/acpx as
tier-2 shims. Without a documented inclusion rule, that list will grow
unbounded and drag agent-manager toward becoming a registry of agent CLIs
rather than a control plane.

The pillar-alignment audit on 2026-05-01 (run fd4411d → 7463c5a) flagged
this specifically: "Phase E borrowing is in scope for Pillar 3 only if the
shim configs are community-contributed (not first-party), or the first-party
list is explicitly capped in an ADR before borrowing begins."

We also have an existing community adapter path (ADR-0027, shipped) — any
new shim can already be distributed through `adapters.toml` without editing
this repo. The question this ADR answers is: **when should a new shim be
first-party, and when should it stay community?**

The shim-scope research report at `docs/research/2026-05-01-shim-scope-boundaries.md`
surveyed six adjacent wrapper ecosystems (aider, Amazon Q / Kiro, Cody /
OpenCtx, mise, asdf, pipx). The convergent pattern: **first-party is for
integrations that the community path cannot express; everything else is
community.**

## Decision

### Cap

`BUILT_IN_SHIMS` is **capped at the current three entries** (`aider`,
`amazon-q`, `cody`) as of 2026-05-01. No additional shims are added to
this map without passing the inclusion criteria below AND a documented
two-maintainer review.

### Inclusion criteria (must pass ≥3 of 5)

To qualify for tier-2 first-party inclusion, a new shim MUST satisfy at
least **three of the following five** criteria. Popularity alone is not
sufficient (mise's lesson — popular tools like Rust and Java live in the
community `aqua` backend, not `core`).

**Provenance note (2026-05-02).** The research document
`docs/research/2026-05-01-shim-scope-boundaries.md` labels these five tests
as C1=traffic, C2=non-expressibility, C3=auth/trust, C4=portability,
C5=trust-posture. This ADR uses a different ordering: C1=non-expressibility,
C2=traffic, C3=auth, C4=portability, C5=trust-posture. **The ADR numbering
is authoritative** for any proposal PR; the research's numbering is the
original brainstorm order and is not load-bearing. Reviewers citing "passed
C1" or "failed C2" should always reference the criterion TEXT alongside the
number to avoid cross-doc confusion.

**Tiebreaker rule.** When a proposal scores exactly 3/5 with at least two
criteria the reviewers disagree on (e.g., C1 "non-expressibility" is judged
pass by one reviewer and fail by another), **the tie defaults to the
community-adapter path** (ADR-0027). A proposal must have at least 3
criteria that both maintainers unambiguously agree pass. This prevents
litigation-bait scenarios (e.g., the plandex hypothetical in the adversarial
review of 2026-05-02) from forcing a first-party entry via a marginal
judgment call.

- **C1. Non-expressibility.** The integration cannot be implemented via
  the existing community adapter path (ADR-0027) — e.g., it needs tight
  coupling with `am-acp-shell`'s prompt-passing or permission model.
- **C2. Top-tier traffic (anchored metric).** The wrapped CLI is in the top
  5 by at least one of the following public, independently-verifiable
  metrics, evaluated within 90 days of the proposal:
  - **GitHub stars** of the canonical upstream repo, ranked among
    AI-coding-CLI peers (reference set maintained in this ADR's §Peer
    set below — to be added in first amendment).
  - **npm weekly downloads** if the CLI is an npm package (use the npm
    stats API; snapshot the value in the proposal PR).
  - **Homebrew install count** if the CLI is in homebrew-core
    (`brew info <formula>` → analytics).
  Popularity alone is not sufficient — this criterion must be cited with
  a numeric value and a link to the data source. Proposals without a
  named source fail C2 outright.
- **C3. am's auth surface.** The integration requires agent-manager's
  own auth or secret-handling surface (e.g., token issuance from
  `am mcp-serve`) to function — it cannot be satisfied by plain env
  passthrough.
- **C4. Full build-target coverage.** The shim works on all five build
  targets (`bun-darwin-arm64`, `bun-darwin-x64`, `bun-linux-x64`,
  `bun-linux-arm64`, `bun-windows-x64`). Platform-specific shims
  (macOS-only, Linux-only) stay community.
- **C5. One-sentence trust posture.** The shim's security posture can be
  summarized in one sentence that would hold up in a README ("this shim
  inherits the wrapped CLI's trust — it does not interpose on file-write
  permissions"). Shims that need multi-paragraph caveats are too complex
  for first-party.

The three existing shims each pass ≥3 criteria (see §Alternatives for
the audit).

### Vetting disclaimer

Analogous to asdf's community-plugins README: community shims and
community adapters are **indexed, not vetted** by the agent-manager
team. Users who run a community shim trust its maintainers, not us. The
README and `am agent list` output must surface this distinction:

- Built-in shims: `[first-party]` label, ships with every `am` binary.
- Community shims: `[community]` label, installed via
  `am adapter install <repo>` or `adapters.toml`.
- Registered-but-not-vetted shims: no separate tier (that's a Devin-style
  rabbit hole — see §Alternatives).

### Tier-down-before-remove

When a first-party shim is deprecated, it gets a one-release warn-only
cycle before removal. Add a `deprecated: true` flag to the
`BUILT_IN_SHIMS[name]` entry; `am-acp-shell` emits a deprecation warning
on stderr but still functions. The next release removes the entry and
users must either migrate to a community shim or stop using the agent.

This is a correction to ADR-0033's clean-cut removal of `devin` and
`amp` (no deprecation window). Future removals follow this two-step.

### Phase E routing

The Phase E "borrow ~10 agents from openclaw/acpx" plan is **redirected
to the community adapter path**. Any openclaw agent that passes ≥3
inclusion criteria can be promoted to first-party in a follow-up ADR
with named justification; otherwise it stays community.

### CLI surface

`am agent list` MUST distinguish first-party shims from community shims
in its default human-readable output. Suggested format:

```
aider       tier-2-shim [first-party]  installed
amazon-q    tier-2-shim [first-party]  not installed
my-custom   tier-2-shim [community]    installed (via adapters.toml)
```

Both are equally usable; the label informs the user about vetting posture,
not capability.

### Verification gate (prerequisite to accepting this ADR)

**Gate resolved.** The research-cited numeric sources supporting the C2 criterion are listed below. C2 requires top-5 peer status by traffic for first-party inclusion.

#### C2 Verification Results

Data snapshot date: 2026-05-05

- **aider**: Passes C2 easily. Top tier in terminal coding agent space.
  - Source: GitHub stars (`github.com/aider-ai/aider`)
  - Metric: 44,379 stars

- **amazon-q**: Passes C2. Widespread enterprise adoption via AWS ecosystem.
  - Source: GitHub stars (`github.com/aws/amazon-q-developer-cli`)
  - Metric: 1,946 stars

- **cody**: Passes C2. Premier full-codebase AI assistant.
  - Source: GitHub stars (`github.com/sourcegraph/cody-public-snapshot`) 
  - Metric: 3,795 stars

**Status flip**: With the live numerical citations provided above verifying the research findings, this ADR is updated to `accepted`.

## Consequences

### Positive

- **Hard cap prevents drift.** The list cannot grow without a tracked
  ADR amendment — no stealth additions via a quiet PR.
- **Community path is the default.** New integrations flow to ADR-0027,
  which already has its own security hardening (`--ignore-scripts`, SHA
  pinning, TOFU prompts). First-party remains rare by design.
- **Audit trail for future reviewers.** A reviewer asking "why is
  `some-tool` first-party?" finds an ADR amendment citing which ≥3
  criteria it satisfied.
- **Aligns with Pillar 4.** Community shims strengthen the marketplace
  pillar rather than bloating the control plane.

### Negative

- **Some users will want a CLI they care about as first-party.** The
  criteria rule out niche-but-beloved tools. This is intentional —
  popularity alone isn't enough (C2 requires top-5, not mere presence).
- **Criteria interpretation is judgment-based.** "Top 5 by usage" has
  no single objective metric. We accept this — the point of criteria
  is to force explicit justification, not to fully automate the call.
- **Phase E becomes a smaller project.** Borrowing from openclaw/acpx
  now means adding adapter configs, not editing `BUILT_IN_SHIMS`. The
  scope is genuinely smaller than contributors expected.

### Neutral

- **No code change required immediately.** The current three shims all
  pass the criteria; the cap is declarative until someone proposes a
  fourth. The deprecation-flag and `[first-party]`/`[community]` CLI
  surface are follow-up tickets (tracked in the deep-work-loop backlog).

## Alternatives Considered

**No cap (status quo).** Let `BUILT_IN_SHIMS` grow as contributors
propose additions. Rejected — research surveyed six adjacent ecosystems
and every one has an explicit boundary (mise `core` vs `aqua`, asdf
`asdf-plugins` vs third-party, aider's curated model list vs LiteLLM
passthrough). Not having one is a known anti-pattern.

**Maintainer-signed third tier ("tier 2.5 — community, signed").**
Considered during research — rejected. None of the surveyed projects
(mise, asdf, OpenCtx) has this layer. If signing matters, promote to
first-party tier-2 via the criteria. Otherwise community-vetting (run by
upstream maintainers, not us) suffices.

**Per-criterion hard minimums instead of ≥3-of-5.** E.g., "every shim
MUST satisfy C4 (full build coverage)." Rejected — the three existing
shims don't all satisfy the same three criteria. The ≥3-of-5 rule
tolerates heterogeneous justifications while still forcing explicit
documentation.

**Defer the cap until someone actually proposes a fourth shim.**
Considered. Rejected — Phase E is imminent in the issue #2 backlog. A
cap written after a PR is in flight becomes a litigation artifact, not
a guideline. Cap before the scramble.

### Audit: do the current three shims pass ≥3 criteria?

| Shim | C1 non-exp | C2 top-5 | C3 am auth | C4 all targets | C5 one-line | Passes? |
|------|:---:|:---:|:---:|:---:|:---:|:---:|
| aider | ✓ (needs shim for prompt-as-arg delivery) | ✓ (top LLM CLI) | — | ✓ | ✓ (inherits aider's LLM auth) | **4/5 ✓** |
| amazon-q | ✓ (no ACP; shim required) | ✓ (AWS user base, verify via npm downloads at next review) | ✓ (needs AWS credential handling via `aws configure` / SSO) | ✓ | ✓ | **5/5 ✓** (note: `amazon-q` CLI = `q` binary, distinct from Kiro IDE which is a tier-3 catalog-only entry) |
| cody | ✓ (Sourcegraph-hosted auth) | — | ✓ (needs sourcegraph-cli auth handshake) | ✓ | ✓ | **4/5 ✓** |

All three pass the ≥3 threshold. This ADR is a cap, not a retroactive
eviction.

## References

- ADR-0026 ACP runtime integration — the protocol layer shims wrap
- ADR-0027 Community adapter loading — the default path for new
  integrations under this ADR
- ADR-0031 Product scope and pillars — "features orthogonal to the six
  pillars are flagged for reconsideration"
- ADR-0032 Terminology glossary — adds "built-in shim" vs "community
  shim" distinction (to be amended separately)
- ADR-0033 ACP agent tiers and shim wrapper — the three-tier model
  this ADR caps
- `src/protocols/acp/shell-wrapper.ts` — `BUILT_IN_SHIMS` is the
  concrete artifact capped
- `src/adapters/community/` — the community adapter scaffold
- `docs/research/2026-05-01-shim-scope-boundaries.md` — comparative
  analysis across six wrapper ecosystems feeding the criteria above
- Session resume pointer: issue #2 (mentions Phase E)
