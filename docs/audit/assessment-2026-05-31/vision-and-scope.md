# Vision & Scope Audit — agent-manager (`am`)

**Date:** 2026-05-31
**Dimension:** vision-and-scope
**Auditor bar:** Is this architected to become a production-ready, downloadable CLI with a first-run setup wizard that lets a stranger install it, run it, and get value without reading the source?

---

## Executive summary

The product has a genuinely coherent *core* thesis — "define your AI-tool catalog once in TOML, generate native configs for every tool, sync via git, detect drift" — and that core (pillar 1) is mature, well-tested, and the only part a first-run wizard actually needs. On top of that core, the project has accreted into a self-described "control plane for AI agents" with six pillars plus several *new* subsystems (universal secrets/`am pair`, hosted-UI auth, CodeMirror editor, `am mcp superset`) that the six-pillar model does not even account for. The scope is not controlled by the pillars; the pillars are a retroactive rationalization that has itself been overrun by the next wave of features (ADR-0042–0052, all dated *after* the pillar ADR).

There is a real, unresolved framing war on disk: README + CLAUDE.md say "**control plane for AI agents… not chezmoi**," while ROADMAP.md still leads with "**chezmoi for AI agent configs**" and its entire Vision section never mentions a single pillar. Both framings ship in the repo today. For a v1.0 that a stranger can adopt, the chezmoi framing is the honest, defensible, shippable one; the control-plane framing writes checks (ACP/A2A delegation, flows, hosted UI, agent variants) that are aspirational-to-half-built and that no first-run wizard can deliver value from.

The most damaging concrete finding for the "stranger installs it" bar: **the README's install instructions are broken.** `npm install -g agent-manager` installs a *different, unrelated* package (npm `latest` is `0.3.1` by another author), and `brew tap Codeseys-Labs/am` points at an unpublished tap. A stranger following the README's first code block does not get this project.

---

## What the vision actually is (as built)

Two incompatible taglines coexist:

- **README.md:1-7 / :29-32** — "The control plane for your AI agents… agent-manager is not 'chezmoi for configs' — it outgrew that framing. It is a control plane for AI agents, built on six composing pillars."
- **CLAUDE.md:3** — "The control plane for AI agents."
- **ROADMAP.md:3** — "agent-manager (`am`) — chezmoi for AI agent configs. Single source of truth for MCP servers, instructions, skills, and agent profiles across every AI tool."
- **ROADMAP.md:10-27 (Vision section)** — frames the product purely as config-fragmentation solver ("agent-manager exists to solve one problem: AI tool configurations are fragmented"). Six pillars are never named. Pillars 2/3/4/6 (gateway, protocol router, marketplace, three UIs) are absent from the stated vision entirely.

ADR-0031 (`ADRs/0031-product-scope-and-pillars.md:18-42`) explicitly narrates this transition and *rejects* the chezmoi framing as "the wrong tagline." But ADR-0031 was an act of retroactive rationalization of already-shipped sprawl — its own Context section admits an iter2 audit scored vision coherence 6.5/10 and recommended cutting ~40% of LOC, and the ADR's response was to redefine the yardstick rather than cut (`:32-42`). That is the inverse of scope control.

---

## Pillar maturity assessment

| Pillar | Maturity | Verdict | Evidence |
|---|---|---|---|
| **1. Catalog + git sync** | Mature | **Load-bearing — the product** | `src/core/{config,resolver,schema,git,secrets}.ts`; 13 adapters all implement detect/import/export/diff (README:84-102). This is what a wizard configures. |
| **2. MCP gateway** (`am mcp-serve`) | Mature | Load-bearing | `src/mcp/server.ts` — verified 38 tool entries (`grep -c tier:` = 38). Concurrency mutex, bearer auth shipped. |
| **3. Protocol router** (ACP/A2A/bridge/flows/variants) | Mixed: ACP+A2A real, flows + variants aspirational-ish | **Partially dead weight for v1** | `src/protocols/acp/flows.ts` (591 LOC) + `src/commands/flow.ts` (240 LOC) ship a node-graph workflow engine ADR-0031:138-141 itself says is "NOT a generic orchestrator." Agent variants (ADR-0036) add a multi-backend routing surface no first-run user needs. |
| **4. Marketplace → "MCP Registry + git bundles"** | Retired, code still present | **Dead weight, scheduled for deletion** | ADR-0039 retired it; ADR-0052 commits to deleting `src/marketplace/*` (1,875 LOC, `wc -l`) in 0.6.0. README still ships a "Marketplace (deprecated)" section (README:764-779). This is a pillar that became a non-pillar that became a deletion target — across 3 ADRs. |
| **5. LLM-wiki** | Foundation shipped, read-side expanding | Aspirational depth | Storage/BM25/NER/graph real (`src/wiki/`). Docs (CLAUDE.md, ADR-0031:120-124) claim "only claude-code + codex read." Reality: **8 SessionReaders** now exist (claude-code, codex-cli, cline, copilot, cursor, gemini-cli, roo-code, windsurf). Pillar grew; docs didn't follow. |
| **6. Three UIs over one core** | TUI+local web real; CF Worker separate | Over-claimed, already amended | ADR-0031's "all three are skins over one core" was factually wrong and required companion ADR-0031a to walk back (`ADRs/0031a-pillar-6-amendment.md:24-42`): the CF Worker imports nothing from `src/core/*`. A pillar that needed an amendment to be *true* one month after it was written. |

**Not in any pillar at all (post-pillar scope creep):** an entire universal-secrets/key-handoff subsystem — `am secrets`, `am pair`, `am pair-accept`, `am pair-finalize`, `secrets-{migrate,rewrap,rotate,revoke}.ts` (2,469 LOC across `src/commands/pair*.ts` + `secrets*.ts`), backed by ADR-0042/0046/0047/0050/0051 — plus hosted-UI auth (ADR-0043/0048), a CodeMirror editor (ADR-0045/0049), and `am mcp superset` (`src/commands/mcp-superset.ts`). None of these map to the six pillars the README claims define scope. The pillar model, meant to be the scope gate ("which pillar does this serve?" — CLAUDE.md:7), is already obsolete: the project shipped ten ADRs of new surface *after* declaring the pillars closed.

---

## Doc drift inventory (every number is wrong somewhere)

Pervasive, embarrassing-in-front-of-a-first-user stat drift:

| Metric | README | ROADMAP | CLAUDE.md | Actual |
|---|---|---|---|---|
| Tests | **2906** (badge :10), **1864** (:885, :913), **1,859** (:937) — three values in one file | 1,916 (:319) | 2906 (:60, :340) | **3064** (`bun test`: "Ran 3064 tests across 232 files") — *no doc matches* |
| Test files | — | 152 (:318) | 222 (:168) | **232** (verified by `bun test`) |
| Source files | 182 (:935) | 176 (:317) | 199 (header) | **215** (`find src -name '*.ts*'`) |
| ADRs | **30** (:877, :943) | 47 (:272, :325) | 52 | **52 numbered files** (0001–0052) |
| CLI commands | 31 (:941, :854) | 31 (:75) | 31 | **36** subcommands in `src/cli.ts` |
| MCP tools | 38 (:13, :541) | 33 (:88, :324) | 38 | **38** (verified) |

The README disagrees with itself on the test count three times. ROADMAP is a full release-cycle stale (says 33 MCP tools, 47 ADRs, 31 commands). No single document tells a stranger the truth about the product's size.

**Framing drift (the load-bearing one):** ROADMAP.md:3 + :10-27 still sells chezmoi-config-sync while README/CLAUDE sell control-plane. A new contributor or user reading ROADMAP first builds the wrong mental model of the entire product.

**Behavioral drift in the install/onboarding path:**
- README Quick-Start (`README:129-138`) shows `am init` interactively detecting tools and prompting "Import all? [Y/n]" then "Merged 22 unique servers." **The real `src/commands/init.ts` does none of this** — it generates a key, optionally sets a remote, and then merely *prints* "Run `am import auto` to import existing configs" (`init.ts:155-157`). The advertised one-command onboarding does not exist; import is a separate manual step. This is the exact gap a "first-run setup wizard" is supposed to close, and the README pretends it's already closed.
- Install block (`README:106-121`): `npm install -g agent-manager` resolves to npm `latest = 0.3.1`, a **different package by another author** (its keywords are `ink`, `node-pty` — not this codebase). `brew tap Codeseys-Labs/am && brew install am` points at an unpublished tap. The memory note `project_npm_publish_deferred.md` confirms npm publish is *intentionally deferred* and the published artifact is "knowingly out-of-date" — yet the README presents these as working install paths with no caveat. A stranger's very first action fails or installs the wrong thing.

---

## Scope-control assessment

**Is scope controlled? No.** The evidence is the ADR timeline itself:

- ADR-0031 (2026-04-16) declares six pillars + explicit non-goals as the scope gate.
- ADR-0031a (2026-05-05) amends pillar 6 because it was factually false.
- ADR-0039 (2026-05-05) retires pillar 4.
- ADR-0042–0051 (2026-05-02 → 2026-05-17) add an entire secrets/pairing/hosted-auth/editor product line that no pillar covers.
- ADR-0052 (2026-05-17) schedules deletion of the retired pillar's code.

In the six weeks after the scope-defining ADR, the project amended one pillar, retired another, scheduled code deletion for it, and bolted on a 2,400-LOC secrets subsystem outside the model. The "which pillar does this serve?" gate (CLAUDE.md:7, ADR-0031:199-201) did not actually gate anything. This is a research/deep-work-loop project optimizing for ADR throughput, not a product converging on a shippable v1.

**Are all six pillars load-bearing?** No. Pillars 1+2 (catalog/sync + MCP gateway) are the product. Pillar 3's ACP/A2A core is real but flows + variants are speculative. Pillar 4 is being deleted. Pillar 5 is a half-stocked shelf (the read-side that feeds it is the bottleneck, by ADR-0031's own admission at :120-124). Pillar 6 needed an amendment to be true. A disciplined v1 is pillars 1, 2, and the catalog-read half of 5 — roughly the *chezmoi-plus-MCP-gateway* product the ROADMAP still (accidentally) describes.

---

## Which framing should win for v1.0

**"chezmoi for AI configs, with an MCP gateway."** Reasons:

1. It is true today. A stranger can `am init` (once install works), import existing configs, switch profiles, `am apply`, and `am status` — and get value. That is pillars 1+2, fully shipped.
2. The control-plane framing front-loads the weakest surfaces (ACP/A2A delegation, flows, hosted UI) into the pitch. A first user cannot get value from "delegate via A2A to a remote agent" on day one; they can get value from "all my MCP servers in one TOML, synced across machines."
3. The non-goals in ADR-0031:136-148 are already the chezmoi framing wearing a disclaimer ("not a workflow orchestrator… not a hosted inference product… complementary to native IDE UX"). The product keeps insisting on what it is *not*, which is the tell that the "control plane" name oversells.

The control-plane vision is a fine *north star for v2*. For the v1.0 download-and-get-value bar, lead with the config-sync story, keep the MCP gateway as the headline differentiator, and demote pillars 3–6 to "also included / experimental."

---

## Implications for a first-run setup wizard

A wizard must do the following, and the current code mostly *doesn't*:

1. **Verify a working install first.** Today the documented install paths are broken/misleading (npm hijack, unpublished brew tap). A wizard is pointless if the binary the user has isn't this project. Fix install honesty before any wizard work.
2. **Actually run import, not print a hint.** `am init` (`init.ts:108-166`) detects tools then tells the user to run a *second* command (`am import auto`). The wizard must fold detect → preview → import → secret-scan → apply into one guided flow — the very flow the README *fictionally* describes at :129-138. The building blocks exist (`getDetectedAdapters`, `import.ts` with `auto` source, secret auto-encrypt at `import.ts:317-352`); they are just not sequenced.
3. **Scope the wizard to pillars 1–2 only.** Do not surface ACP/A2A/flows/variants/marketplace/pair/hosted-UI in first-run. A wizard that asks a new user about "agent variants" or "A2A discovery sources" will lose them. The six-pillar surface is the enemy of a clean onboarding.
4. **Pick one secrets story for onboarding.** The product now has *two* — the original AES-256-GCM `am secret` (ADR-0012) and the new age-envelope `am secrets`/`am pair` universal-secrets (ADR-0042). A wizard must choose one; today a new user faces `am secret` vs `am secrets` (singular vs plural commands, both registered in `cli.ts`) with no guidance on which is canonical.
5. **Stop the marketplace from appearing.** The deprecated `am marketplace` group is still registered (`cli.ts`) and documented (README:764-779). A wizard / help surface that shows a deprecated-and-being-deleted command group to a first user is pure confusion. ADR-0052 deletes it in 0.6.0 — pull it from docs and the command list now.

**What's missing today:** there is no wizard. `am init` is a thin scaffolder (key + remote + a printed hint). The gap between "what `am init` does" and "what the README claims `am init` does" *is* the unbuilt wizard. The good news: the underlying primitives (adapter detection, brownfield import with conflict resolution per ADR-0028, secret detection/encryption) are all real and tested — the wizard is an orchestration/UX layer, not net-new capability.

---

## Recommendation for this dimension

**refactor-in-place.** The core vision (pillars 1+2) is sound and well-built; the problem is scope sprawl and doc drift, not a wrong architecture. Concretely:

1. **Reconcile the framing.** Rewrite ROADMAP.md's Vision to match README, or (better) demote README to the chezmoi+gateway framing for v1 and move "control plane" to a "Vision / v2" section. One framing, repo-wide.
2. **Fix install honesty immediately** (highest user-facing severity). Either publish under a name you own or replace the npm/brew blocks with the from-source/GitHub-Releases path and a clear "npm/brew coming at v1.0" note.
3. **Make `am init` match its own README** (build the wizard around existing primitives), or fix the README to describe the real two-step flow until the wizard lands.
4. **Execute ADR-0052 now**, not in 0.6.0 — delete marketplace code + docs so the v1 surface is honest.
5. **Add the post-pillar subsystems to the pillar model or cut them from v1 scope.** Secrets/pair/hosted-UI/superset either get a pillar home (and a place in the docs) or get flagged experimental and hidden from first-run.
6. **Single source of truth for stats.** Generate the badges/tables from a script so README/ROADMAP/CLAUDE can't disagree on test counts again.
