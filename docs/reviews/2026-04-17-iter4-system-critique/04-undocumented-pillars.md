# Undocumented / Underemphasized Pillars and Features

**Date:** 2026-04-17
**Scope:** Compare ADR-0031's 6 pillars against the 31-ADR corpus, the CLI
surface (31 commands / 33 MCP tools), CHANGELOG, ROADMAP, and docs/designs.
Identify capabilities that (a) exist, (b) were architected or discussed, and
(c) either deserve pillar status or need more surface promotion.
**Inputs:** ADRs 0001-0031, README.md, ROADMAP.md, CHANGELOG.md, src/commands/*,
src/help.ts, docs/designs/2026-04-15-extensibility-import/,
docs/designs/2026-04-16-protocol-positioning/,
docs/designs/2026-04-16-wiki-browser/,
docs/reviews/2026-04-16-iter2-adapter-schemas-and-vision/02-vision-coherence.md.

---

## Summary

ADR-0031 names six pillars: (1) Catalog + git sync, (2) MCP gateway,
(3) Protocol router, (4) Marketplace, (5) LLM-wiki, (6) Three editing surfaces.
That framing is mostly correct — every shipped surface does map to at least
one of them. But three things are wrong in emphasis:

1. **"Catalog + git sync" is doing too much work.** It carries the weight of
   brownfield import, drift detection, encryption-at-rest, secret detection,
   hierarchical merge, profile subsets, MCP package registry (`am install`),
   session harvest, and community adapter loading. At least two of these
   (MCP Package Registry, Session Harvest) are distinct enough in user mental
   model to argue for their own pillar or a prominent sub-bullet.

2. **Session harvest is the real "buried differentiator," not LLM-wiki.**
   ADR-0031 correctly calls out that LLM-wiki is "the least-documented
   differentiator." It is mostly right — but session harvest (ADR-0016) is
   the only ingest pipeline that feeds the wiki, and it is the *only*
   feature in the product that does cross-tool read-side work (13 adapters
   all do write-side; 2 do read-side today). It deserves equal promotion.

3. **"Drift detection" (ADR-0006) is called out in the matrix but is not a
   named pillar or sub-bullet.** It is arguably the single most compelling
   reason a chezmoi-style tool is safer than terraform-style overwrite for
   AI configs — and it is the feature that would have prevented the real
   Claude Code `migrationVersion: 11` wipe incident cited in ADR-0026. It
   should be a first-class sub-bullet of pillar 1.

Counts:
- **Possible new pillars:** 2 (MCP Package Registry; Security & secret
  hygiene) — see per-candidate verdicts below. Neither rises to standalone
  pillar status in my assessment, but both deserve stronger README/ADR-0031
  promotion as sub-pillars.
- **Underemphasized features inside existing pillars:** 6 (drift detection,
  session harvest, brownfield merge, MCP package registry, secret detection
  engine, community adapters).
- **Biggest naming inconsistency:** "catalog" vs "config" vs "config.toml"
  vs "AM repo" — see naming section.

---

## Candidates for New Pillar

### Candidate A: MCP Package Registry (`am search / install / update / uninstall`)

**Name proposal:** Registry (7th pillar) OR elevate to "Catalog + registry"
combined pillar 1.

**Evidence:**
- Dedicated ADR-0024 with its own architecture (client, cache, provenance
  tracking).
- Dedicated command group in `src/help.ts` ("Registry commands") — equal
  billing with Marketplace in the grouped help.
- Its own MCP tool group in ADR-0021 (`registry`: 3 tools).
- `_registry` provenance metadata surfaces in TOML (`src/commands/install.ts`,
  schema validation via `RegistryProvenanceSchema`).
- README has a top-level `### MCP Registry` section (lines 150-158) and a
  full CLI reference table (lines 586-593).
- Commands: `am search`, `am install`, `am update`, `am uninstall` — 4 of the
  31 total CLI commands are dedicated to the registry.
- ROADMAP lists "MCP Registry — Complete" as its own implementation section.

**Verdict:** **Sub-pillar within pillar 1, promote to README bullet inside
pillar 1.** Not a standalone pillar because the registry writes to the same
catalog TOML file as everything else (pillar 1 is its source-of-truth), and
it cannot exist without the catalog. But in ADR-0031's current phrasing
("Servers, skills, agents, plugins, profiles defined once in TOML. User's
choice of git backend. Brownfield import from any supported tool."), the
registry as a *discovery + install* surface is invisible. Add a sentence:
"Discover and install MCP servers from the upstream MCP registry with
version pinning, env-var prompting, and provenance tracking."

Note: ADR-0031 itself mentions the *Marketplace* as pillar 4 — but a
marketplace is a **plugin/skill/agent bundle aggregator**, while the
MCP Registry is an **MCP server package index**. These are not the same
thing. Users confuse them today; calling them both "marketplace" in casual
speech would be wrong. The README helpfully separates them already
(lines 150-171), but ADR-0031 does not acknowledge the distinction.

### Candidate B: Security & Secret Hygiene (encryption + detection + supply chain)

**Name proposal:** "Security & trust" cross-cutting pillar (7th) OR
"Zero-friction security" sub-bullet of pillar 1.

**Evidence:**
- Three dedicated ADRs: 0012 (application-level encryption), 0019 (security
  hardening threat model), 0023 (tiered secret detection with BetterLeaks).
- 24+ provider patterns for secret detection, with both structural (env-var
  name) and value-based (regex) detection.
- `am secret init / set / get / scan / scan --fix / install-scanner` — a
  6-command subgroup.
- Iter10-11 security hardening landed 12+ HIGH/CRITICAL fixes (CHANGELOG
  lines 126-142): agent name sanitization, flow cycle detection, adapter
  checksum verification, timing-safe bearer comparison, SSE timeout, path
  restriction in ACP, plugin ID traversal validation.
- Marketplace supply-chain hardening: SHA pinning, TOFU, `--ignore-scripts`,
  path traversal scrub (ADR-0031 mentions this under pillar 4).
- ROADMAP groups "Secret Detection — Complete" as its own row.

**Verdict:** **Sub-pillar, not standalone.** Security is cross-cutting — it
touches pillar 1 (encryption at rest in TOML), pillar 4 (marketplace
supply-chain), pillar 6 (web UI auth, CORS, cookie handling). Elevating it
to a standalone pillar would be a category error — security is a *property*
across pillars, not a pillar itself. But the *user-facing* workflow
(`am secret init` → `am secret scan --fix` → auto-encrypt on import) is
distinctive enough to deserve a named sub-bullet in pillar 1. Specifically:
"Secrets auto-detected during import and `add`; AES-256-GCM encryption at
rest in TOML; 24+ provider patterns (gitleaks-derived) + BetterLeaks tier-2
scanner. Zero friction: the default experience encrypts."

### Candidate C: Session Harvest (cross-tool transcript export)

**Name proposal:** Sub-pillar of pillar 5 (LLM-wiki) OR standalone 7th pillar
"Session + knowledge".

**Evidence:**
- Dedicated ADR-0016 defining `SessionReader` interface and a unified
  `Session`/`Message` model.
- 3 MCP tools (`am_session_list`, `am_session_export`, `am_session_search`).
- Only 2 of 13 adapters (Claude Code, Codex CLI) implement session read, so
  the matrix line in README already flags this as uneven — that is itself a
  promotion opportunity: "currently 2/13; ROADMAP item to expand."
- Session harvest is the **only** adapter-side read path. All 13 adapters
  write; only 2 read. This asymmetry is under-discussed.
- Feeds LLM-wiki via `am wiki harvest` and `am wiki ingest` — session
  harvest is the raw-material layer for pillar 5.

**Verdict:** **Sub-pillar of pillar 5, explicitly named.** ADR-0031 pillar 5
says "session context capture" — make this concrete: "Session harvest
reads transcripts from Claude Code, Codex CLI, Kilo, Roo, Kiro in their
native formats into a unified model. `am wiki harvest` distills harvests
into wiki pages. This is the only cross-tool read-side pipeline in the
product."

### Candidate D: Drift Detection (across all 13 adapters)

**Name proposal:** Sub-pillar of pillar 1 (catalog).

**Evidence:**
- Dedicated ADR-0006 (Drift Detection Over Overwrite), cited as a design
  principle.
- Implemented across **all 13 adapters** (README matrix line "Drift
  Detection: Y × 13"). 100% coverage.
- `am status` surfaces drift. `am apply` refuses to overwrite without
  `--force`. This is THE safety property that distinguishes am from
  terraform-style overwrite tools.
- ADR-0026's opening Context cites the Claude Code `migrationVersion: 11`
  wipe — the single most concrete user story in the entire ADR corpus —
  and drift detection is the *answer* to it.

**Verdict:** **Sub-pillar of pillar 1, must be named in ADR-0031.** Not a
standalone pillar — it is a property of the catalog pipeline. But it
deserves equal billing with "brownfield import" within pillar 1's bullet.
Proposed pillar 1 rewrite: "Servers, skills, agents, plugins, profiles
defined once in TOML. User's choice of git backend. **Brownfield import**
from any supported tool. **Drift detection** against every tool (the tool
never silently overwrites your changes). **Secret hygiene** auto-applied
during import."

### Candidate E: Community Adapter Loading (ADR-0027)

**Name proposal:** Sub-pillar of pillar 1 (catalog extensibility).

**Evidence:**
- Dedicated ADR-0027.
- `am adapter install / remove / update / verify` — a 5-command subgroup.
- JSON-RPC subprocess protocol with SHA-256 checksum verification (iter10
  security hardening).
- `src/adapters/community/` is a first-class subdirectory.
- CHANGELOG 0.4.0 calls it out as a New Feature.

**Verdict:** **Sub-pillar of pillar 1, call out in README pillar 1 bullet.**
Not standalone — it is pillar 1's extensibility story. ADR-0031 pillar 1
does not mention community adapters at all. It should: "Built-in adapters
for 13 tools; community adapters loaded as JSON-RPC subprocesses (language-
agnostic, checksum-verified)."

### Candidate F: Flows Engine

**Name proposal:** Already in pillar 3 per ADR-0031's explicit non-goals.

**Evidence:**
- ADR-0026 Phase 3 (acp flows).
- `am flow run / list / status` — 3-command subgroup.
- 587 LOC (`src/protocols/acp/flows.ts` per iter2 vision audit).
- ADR-0031 *explicitly* dispositions this: "am is **not** a workflow
  orchestrator. `am flow` exists as a coordination primitive for pillar 3."

**Verdict:** **Correctly positioned in ADR-0031; no change needed.** But
README's standalone `### Flows Engine` section (lines 399-412) is
mis-leading — it presents Flows as equal to ACP/A2A/MCP, when ADR-0031
says it is subordinate. Fold the Flows section under the ACP Agent
Orchestration section, or add an explicit "(a coordination primitive for
multi-step ACP workflows — not a general orchestrator)" subtitle.

---

## Underemphasized Features Within Existing Pillars

These are capabilities that exist, have ADRs or design docs, have code, and
ship in 0.4.0 — but are under-promoted in README / ADR-0031 pillar bullets.

### F1. Drift Detection (pillar 1)

- **Evidence:** ADR-0006; 100% adapter coverage; README matrix row.
- **Where to promote:** ADR-0031 pillar 1 bullet; README pillar 1 bullet;
  add "drift-safe" to the tagline or short form.
- **Suggested phrasing in ADR-0031:** "Catalog is drift-safe: `am status`
  surfaces divergence between TOML and native configs across all 13 tools;
  `am apply` refuses to silently overwrite."

### F2. Session Harvest (pillar 5)

- **Evidence:** ADR-0016; `SessionReader` interface; 2/13 adapter coverage
  with expansion planned.
- **Where to promote:** ADR-0031 pillar 5; README pillar 5 bullet; add a
  dedicated `### Session Harvest` H3 subsection under LLM-wiki.
- **Suggested phrasing:** "Session harvest is the only cross-tool read-side
  pipeline in agent-manager: it reads Claude Code JSONL, Codex CLI JSONL,
  etc., into a unified `Session` model for export, search, and wiki
  ingestion."

### F3. Brownfield Import Merge (pillar 1)

- **Evidence:** ADR-0028; `am import --auto / --report / --marketplace`;
  two-tier identity matching; conflict resolution.
- **Where to promote:** ADR-0031 pillar 1 bullet already says "Brownfield
  import" but does not explain the merge phase. README has a section
  (lines 192-201) but it is buried under `## Quick Start`.
- **Suggested phrasing:** "Brownfield merge handles partial migrations:
  two-tier identity matching (exact package ID, fuzzy name + command +
  endpoint), conflict resolution with `--auto` / `--report`, and marketplace
  scanning with `--marketplace` for installed plugins."

### F4. MCP Package Registry (pillar 1, as sub-pillar)

- **Evidence:** ADR-0024; separate command group in `src/help.ts`; separate
  MCP tool group; 4 dedicated commands; README section + CLI reference.
- **Where to promote:** ADR-0031 pillar 1 bullet; distinguish from
  Marketplace (pillar 4) explicitly — they are different things.
- **Suggested phrasing:** "Discover MCP servers from the upstream MCP
  Registry (`am search`), install with env-var prompts and auto-encryption
  (`am install`), and track versions (`am update`). The Registry is the
  MCP *package* index; the Marketplace (pillar 4) is the plugin/skill/agent
  *bundle* aggregator — distinct systems."

### F5. Secret Detection Engine (pillar 1, cross-cutting)

- **Evidence:** ADR-0023 (tiered detection), ADR-0012 (encryption), 24+
  provider patterns; tier-2 BetterLeaks integration; `am secret scan --fix`
  auto-encrypts.
- **Where to promote:** ADR-0031 pillar 1 bullet; README pillar 1 bullet
  (not buried under `### Encryption and Secret Detection` at line 280).
- **Suggested phrasing:** "Secret hygiene is zero-friction: 24+ provider
  patterns (gitleaks-derived) detect secrets during `am import` and
  `am add server`; optional BetterLeaks tier-2 scanner for inline value
  detection; AES-256-GCM encryption at rest; keys stored outside git."

### F6. Community Adapters (pillar 1, extensibility)

- **Evidence:** ADR-0027; 5-command subgroup; JSON-RPC protocol;
  checksum-verified subprocess loading.
- **Where to promote:** ADR-0031 pillar 1 bullet; README pillar 1 already
  says "thirteen tools" — but does not acknowledge the +N community
  adapter extensibility.
- **Suggested phrasing:** "13 built-in adapters; language-agnostic community
  adapters loaded as checksum-verified JSON-RPC subprocesses
  (`am adapter install`)."

### F7. Unified Agent Registry (pillar 3)

- **Evidence:** ADR-0030; `src/core/agent-registry.ts`; merges config + ACP
  built-in (16 agents) + A2A roster.
- **Where to promote:** ADR-0031 pillar 3 mentions "agents" generically —
  should call out the unified registry as the mechanism that makes the
  "local via ACP or remote via A2A" story *coherent from the user's view*.
  README has it (lines 346-356) but it is labelled "A2A-ACP Bridge," which
  undersells it.
- **Suggested phrasing in ADR-0031 pillar 3:** "A unified agent registry
  (config > ACP built-in (16) > A2A roster) routes the same agent name to
  the right protocol. Same agent can be available both locally (ACP) and
  remotely (A2A); `am run <name>` picks the right path."

### F8. Wiki Context Injection at Apply Time

- **Evidence:** CHANGELOG 0.4.0 "Wiki Context Injection" feature; splice
  markers; `settings.wiki.inject_on_apply`.
- **Where to promote:** ADR-0031 pillar 5; README pillar 5 bullet. This is
  the feedback loop that makes the wiki *useful* — without it, the wiki
  is a knowledge graveyard.
- **Suggested phrasing:** "Wiki entries are auto-injected into generated
  `CLAUDE.md` / `AGENTS.md` on `am apply` via `generateWikiContext()` —
  closing the loop: sessions harvest into wiki → wiki synthesizes back
  into next session's system prompt."

---

## Naming Inconsistencies

### The biggest one: "catalog" vs "config" vs "config.toml" vs "AM repo"

- **README.md** uses "catalog" (the new ADR-0031 term): "Define your
  catalog once," "Catalog + git sync," "The catalog becomes the single
  source of truth."
- **ADRs 0001-0030** almost never say "catalog." They say "config.toml,"
  "config directory," "config repo," "AM repo," and "the repo."
- **ADR-0031** introduces "catalog" as the canonical term — but does not
  rename prior ADRs.
- **`src/`** has **17 occurrences of "catalog" across 5 files**
  (primarily `src/help.ts`, `src/core/resolver.ts`, `src/mcp/server.ts`)
  versus hundreds of occurrences of "config" and `config.toml`.
- **CHANGELOG / ROADMAP** do not use "catalog" at all.
- **`src/help.ts` header** says "agent-manager (am) — the control plane
  for AI agents" (lines up with ADR-0031) but command descriptions still
  say "Generate native IDE configs from catalog" (uses catalog) while
  `am config` is the literal command name.

**Impact:** Users reading the README see "catalog"; users reading the CLI
help see both; users reading ADRs see "config repo." New contributors have
to translate between three terms for the same thing. The `am config`
command name overlaps with the generic word "config" making the
distinction even harder.

**Recommendation:** Pick one.
- **Option 1 (preferred):** "catalog" is the user-facing abstraction;
  "config.toml" is the storage; "AM repo" is the git container. Document
  this mapping in ADR-0031 and in a glossary. Rename `am config` to
  `am settings` to free up the word.
- **Option 2:** Keep "config" everywhere, drop "catalog" from README and
  ADR-0031. Matches prior art and implementation. Less marketing-coherent.

### Second inconsistency: "marketplace" vs "registry"

- **Marketplace** (pillar 4) = git-based plugin/skill/agent bundles.
- **Registry** (implied pillar inside catalog) = MCP server package index
  (`registry.modelcontextprotocol.io`).
- Both accept `install`, `search`, `update`, `uninstall` verbs.
- README keeps them as separate sections. Good.
- ADR-0031 only mentions Marketplace. Bad.
- `am search` searches the Registry. `am marketplace search` searches the
  Marketplace. Similar names, different targets.

**Recommendation:** ADR-0031 must name both. Add a sentence to pillar 4:
"Distinct from the MCP Package Registry (pillar 1 sub-pillar): Marketplace
= plugin/skill/agent bundles from git; Registry = MCP server package index."

### Third inconsistency: "agents" plural command vs "agent" command

- `am agents list|add|remove|ping|delegate` (plural) — in README.md.
- `am agent` (singular) — appears in `src/help.ts` as the canonical name.
- `src/commands/agents.ts` file (plural).
- `agents` is documented as a hidden alias of `agent` per ADR-0029.
- Vision audit (iter2, 02-vision-coherence.md) flagged this as "directly
  user-visible and harm[s] the 'define once' promise."

**Recommendation:** Pick singular (`am agent`) everywhere. The README still
uses plural (lines 363-369, 613-621). Update README to match `src/help.ts`.

### Fourth inconsistency: "flow" (singular) vs flows engine

- Command: `am flow run/list/status` (singular verb-object).
- ADR: "Flows Engine" (plural, capitalized).
- README: "Flows Engine" section header.
- `src/commands/flow.ts` (singular file).

Minor — this is the standard "collection noun → singular command" pattern
(cf. `git branch`, `git tag`). No action needed.

### Fifth inconsistency: "LLM-wiki" vs "Knowledge Wiki" vs "wiki"

- ADR-0031: "LLM-wiki" (hyphenated).
- README: "Knowledge Wiki" (line 308), "LLM-Wiki (pillar 5)" (line 173),
  "wiki" command name.
- ROADMAP: "Knowledge Wiki — Complete (Phase 1)".
- ADR-0020: "LLM Wiki" (space).
- ADR-0022: "wiki" (lowercase, no qualifier).

**Recommendation:** Pick one display name — recommend "LLM Wiki" (space,
matches Karpathy's original) — and use consistently. Command name stays
`am wiki`. Rename Knowledge Wiki H2 in README to match.

---

## Recommended ADR/README Updates

### Minimal (land this in ADR-0031 amendment or a companion ADR-0032)

1. **Expand pillar 1 bullet** to name: brownfield import + drift detection
   + secret hygiene + MCP Package Registry + community adapters. Current
   bullet is one sentence; target is one paragraph.
2. **Expand pillar 5 bullet** to name: session harvest (the ingest side),
   BM25 + NER + graph (the storage side), wiki context injection at apply
   (the feedback loop).
3. **Distinguish Marketplace (pillar 4) from MCP Registry (pillar 1
   sub-pillar)** in a cross-reference sentence.
4. **Name the unified agent registry** in pillar 3 — currently implicit.
5. **Pick one term for "catalog/config/repo"** and add a glossary to
   ADR-0031 mapping all three.

### README-side

1. **Pillars section (lines 27-49):** add the sub-bullets described above.
   Current: one line per pillar. Target: one line + 2-3 sub-bullets per
   pillar.
2. **Rename/merge sections:** fold the standalone `### Flows Engine`
   section under `### ACP Agent Orchestration` (Flows is subordinate to
   ACP per ADR-0031).
3. **Promote Session Harvest** from a buried CLI table row to a `### Session
   Harvest` H3 under LLM-wiki.
4. **Promote Drift Detection** from section `## Drift Detection` (currently
   under CLI Reference — line 471) to inside the pillar 1 bullet.
5. **Fix `am agents` → `am agent`** in all examples (ADR-0029 decision).
6. **Unify "Knowledge Wiki" / "LLM-Wiki" / "wiki"** headings to one term.

### Potential new ADR: ADR-0032 "Naming conventions and glossary"

Given that ADR-0031 introduced new user-facing terms ("catalog," "control
plane," "pillars") without reconciling them with prior ADR vocabulary, a
short ADR-0032 defining the canonical terms and mapping aliases would
prevent future drift. Status: proposed.

Scope would include:
- catalog vs config.toml vs AM repo
- marketplace vs registry
- agent vs agents (singular canonical)
- wiki display name
- adapter vs plugin (community adapter is NOT a marketplace plugin)
- flow (primitive) vs orchestrator (out-of-scope)

---

## Appendix: ADR-to-Pillar Mapping

For reviewers cross-checking the 31 ADRs against ADR-0031's pillars:

| ADR | Concept | ADR-0031 Pillar | Notes |
|-----|---------|------------------|-------|
| 0001 | Layered core + adapter extensions | 1 (catalog) | foundational |
| 0002 | Git-backed everything | 1 (catalog/git sync) | foundational |
| 0003 | Hierarchical config merge | 1 (catalog) | foundational |
| 0004 | TOML config format | 1 (catalog) | foundational |
| 0005 | Bidirectional adapters | 1 (catalog) | write + import |
| 0006 | Drift detection | 1 (catalog) | **under-promoted** |
| 0007 | Two-phase Zod validation | 1 (catalog) | internal |
| 0008 | Profile-based config subsets | 1 (catalog) | feature |
| 0009 | MCP server mode | 2 (MCP gateway) | foundational |
| 0010 | BunTS single binary | infra | distribution |
| 0011 | Built-in adapters | 1 (catalog) | foundational |
| 0012 | Application-level encryption | 1 (catalog, security) | **under-promoted** |
| 0013 | Git platform adapters | 1 (catalog/git sync) | foundational |
| 0014 | Workspace-to-profile import | 1 (catalog) | brownfield |
| 0015 | Stateless web UI | 6 (three UIs) | foundational |
| 0016 | Session harvest | 5 (LLM-wiki) | **under-promoted** |
| 0017 | Agent communication protocols | 3 (protocol router) | foundational |
| 0018 | TUI framework (Silvery) | 6 (three UIs) | foundational |
| 0019 | Security hardening | cross-cutting | **under-promoted** |
| 0020 | Session knowledge synthesis | 5 (LLM-wiki) | foundational |
| 0021 | MCP tool grouping + gateway | 2 (MCP gateway) | foundational |
| 0022 | Wiki location strategy | 5 (LLM-wiki) | foundational |
| 0023 | Tiered secret detection | 1 (catalog, security) | **under-promoted** |
| 0024 | MCP Registry integration | 1 (catalog) | **promote to sub-pillar** |
| 0025 | Worker multi-backend auth | 6 (three UIs) | foundational |
| 0026 | ACP runtime integration | 3 (protocol router) | foundational |
| 0027 | Community adapter loading | 1 (catalog) | **under-promoted** |
| 0028 | Brownfield import merge | 1 (catalog) | **under-promoted** |
| 0029 | Command grouping | infra | UX polish |
| 0030 | Unified agent registry | 3 (protocol router) | **under-promoted** |
| 0031 | Product scope & pillars | meta | this file's target |

**10 of 31 ADRs are flagged as under-promoted relative to their code
footprint.** All 10 live under pillars 1, 3, or 5 — never under pillar 2
(MCP gateway) or pillar 4 (marketplace), which are already crisp. Pillar 6
(three UIs) has no under-promoted ADRs. Conclusion: the promotion work is
concentrated in **pillar 1 (needs 6 sub-bullets)** and **pillar 5 (needs
3 sub-bullets)**. Pillars 3 needs one sub-bullet (unified agent registry).
