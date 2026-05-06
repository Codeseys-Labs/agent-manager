# Deliberation prompt — 12 open decisions for agent-manager (am)

You are one of six independent reviewers in a fan-out deliberation. Other
reviewers are voting on the same 12 decisions in parallel. **Do NOT read other
reviewers' files.** Write only to your own scratchpad path (specified below).

Your task: for each decision below, vote one of:
  CHOICE A | CHOICE B | NUANCED (specify) | ABSTAIN (insufficient info)

For each vote, give 1-3 sentence reasoning. Be terse. The goal is signal
density, not essay length.

**Hard rule:** for every decision, vote independently. Do NOT defer to "the
maintainer's recommendation" — your job is to challenge or confirm it.

**Required reading (do this first; you have file toolset):**
- `docs/design/2026-05-05-hosted-ux-secrets-synthesis.md` — synthesis (552 lines)
- `docs/design/2026-05-05-llm-wiki-vision.md` — wiki vision (393 lines)
- `ADRs/0042-universal-secrets-strategy.md` — accepted, the secrets foundation
- `ADRs/0043-hosted-ui-auth-and-git-backend-tiers.md` — proposed, amends ADR-0025
- `ADRs/0022-llm-wiki-design.md` — accepted, the wiki vision contradicts §3-4

You are NOT required to read the research lenses or reviewer files from prior
runs — those are inputs to the synthesis. Read the synthesis, not the inputs.

---

## TRACK A — Hosted-UX (4 decisions)

### A1. Editor: CodeMirror 6 (CHOICE A) vs Monaco (CHOICE B)

Synthesis recommends CM6 for hosted UI on Cloudflare Workers (~250KB vs
~2-3MB bundle). ADR-0043 implies Monaco. Vote on:
  A) CM6 only for hosted UI; Monaco optional for `am serve` local
  B) Monaco everywhere
  NUANCED: e.g. CM6 default + Monaco lazy-loaded behind a feature flag

### A2. `op://` 1Password CLI integration: detect-and-prompt-install (A) vs document-as-prereq (B)

If user's TOML contains `op://...` references and `op` CLI isn't installed,
should am offer to install it (e.g. via brew/scoop), or just document
"install op CLI yourself" in setup docs? Vote:
  A) Detect missing `op`, prompt user to install
  B) Document as prereq only; show clear error if missing
  NUANCED: e.g. detect + show install command but never auto-execute

### A3. Reject `[settings.secrets].team_passphrase` in schema (A) vs allow with warning (B)

Synthesis Lens A rejects shared-team-passphrase as anti-pattern. Vote:
  A) Reject in schema (validator error if present)
  B) Allow with prominent warning in `am doctor` output
  NUANCED: e.g. reject by default, allow via `--unsafe-shared-passphrase` flag

### A4. `config_template` field for file-based MCP secrets in MVP (A) vs defer to v2 (B)

§4.5 of synthesis ships `config_template` to handle MCP servers that read
secrets from config files (not env vars). It's a known plaintext-on-disk
window. The P0-3 fix added SIGTERM + sweeper but the underlying surface
remains. Vote:
  A) Ship in MVP — needed for some popular MCP servers
  B) Defer to v2 — too much plaintext-disk risk for initial release
  NUANCED: e.g. ship behind `--unsafe-config-template` opt-in flag

---

## TRACK B — LLM-wiki (8 decisions)

### B1. Rename `.agent-manager/wiki/` → `.am-wiki/` (A) vs keep current (B)

Doc assumes rename for brevity. Cost: deprecation period. Vote:
  A) Rename to `.am-wiki/`
  B) Keep `.agent-manager/wiki/` for consistency with `.agent-manager.toml`
  NUANCED: e.g. rename to `.am/wiki/` as a halfway path

### B2. `am wiki init`: copy (A) vs symlink (B) — REVERSAL of ADR-0022 §3-4

Wiki vision argues copy. ADR-0022 picked symlink. The wiki vision proposes a
new ADR-0044 to amend ADR-0022. Vote on the underlying technical question:
  A) Copy materialised files (works on Windows, agents see the wiki even
     without am)
  B) Symlink (saves disk, single-source-of-truth, fails on Windows pre-symlink-perm)
  NUANCED: e.g. settings.wiki.mirror_strategy with copy default

### B3. Sync direction: bidirectional (A) vs push-only (B)

Bidirectional means project changes sync up AND global changes materialise
down. Push-only means project → global only. Vote:
  A) Bidirectional (richer UX, harder to ship — see Lens-B-style review of
     vision)
  B) Push-only for MVP, bidirectional in a v2
  NUANCED: e.g. push-only with explicit `am wiki pull` for opt-in down-sync

### B4. Default `.gitignore` posture: gitignored (A) vs committed (B)

Vision proposes gitignored-by-default. Alternative: committed-by-default.
Trade-off: visibility/sharing vs accidental secret leaks before ADR-0042 is
fully integrated. Vote:
  A) Gitignored-by-default
  B) Committed-by-default
  NUANCED: e.g. gitignored until ADR-0042 secrets integration is live, then
  committed-by-default

### B5. Promotion gesture: frontmatter flag (A) vs command-only (B) vs both

Vision says both: `promote: true` in frontmatter AND `am wiki publish <slug>`.
Could simplify. Vote:
  A) Frontmatter flag only (auto-promote on commit)
  B) Command only (`am wiki publish`)
  NUANCED: e.g. both — frontmatter declares intent, command actually moves

### B6. AGENTS.md schema for wiki: hardcoded template (A) vs per-project customisable (B)

Vote:
  A) Hardcoded template with version pin in frontmatter; users can't customise
  B) Per-project customisable from the start
  NUANCED: e.g. hardcoded MVP, customisable extension point in v2

### B7. SessionReader gap (2/13 adapters → 4+/13) before two-tier (A) vs alongside (B)

Currently only 2 of 13 IDE adapters can read sessions. Two-tier sync requires
content to separate. Vote:
  A) Block two-tier until ≥4/13 adapters support session reading
  B) Build two-tier in parallel with adapter expansion
  NUANCED: e.g. ship two-tier with skeleton-only, expand adapters concurrently

### B8. Tier model: two-tier (A) vs three-tier-now (B) vs two-tier-extensible (NUANCED)

Vision is two-tier (project + global). Three-tier would add monorepo/workspace.
Vote:
  A) Two-tier only; revisit if users demand workspace tier
  B) Three-tier from day one (project + workspace + global)
  NUANCED: two-tier MVP, layout-compatible with workspace tier added later

---

## Output format

Write your votes to your assigned scratchpad. Begin file with
`[reviewer: <model-slug>]` (your assigned slug, see your task instructions).

Use this template (terse, no preamble):

```
[reviewer: <slug>]

# Fan-out vote — <date>

## Track A — Hosted-UX

A1: CHOICE <A|B|NUANCED|ABSTAIN>
- Reasoning (1-3 sentences)

A2: CHOICE <A|B|NUANCED|ABSTAIN>
- Reasoning

A3: CHOICE <A|B|NUANCED|ABSTAIN>
- Reasoning

A4: CHOICE <A|B|NUANCED|ABSTAIN>
- Reasoning

## Track B — LLM-wiki

B1: CHOICE <A|B|NUANCED|ABSTAIN>
- Reasoning

[... B2 through B8 ...]

## Closing — strongest convictions

In ≤80 words: which of the 12 are you HIGH-confidence on, and which are
LOW-confidence (would change with new evidence)? List by ID.
```

That's it. ≤700 words total per reviewer. Cite sections like `synthesis §Q3.3`
or `wiki vision §2.2` if useful, but you do NOT have to.

**Write only to your assigned path.** Do not modify any other file.
