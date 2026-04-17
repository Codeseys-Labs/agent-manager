# Vision Coherence Audit — agent-manager 0.4.0

**Date:** 2026-04-16
**Scope:** Does shipped code still embody the stated vision? Has feature accretion broken coherence?
**Reviewer:** Vision audit agent (iteration 2)
**Inputs:** `README.md`, `ROADMAP.md`, `ADRs/0001-layered-core-plus-adapter-extensions.md`, `ADRs/0026-acpx-acp-runtime-integration.md`, `ADRs/0030-unified-agent-registry.md`, `src/commands/*.ts`, `src/mcp/server.ts`, `src/protocols/**`, `src/marketplace/**`, `src/tui/**`, `src/web/**`.

---

## Summary

agent-manager still has a crisp, defensible core — "chezmoi for AI agent configs" is honest for roughly 60% of the shipped surface area. The TOML → Zod → 13 adapter export pipeline, drift detection, secret detection, profiles, git sync, and MCP Registry integration form a coherent whole that a new user can grasp in 10 minutes.

The other 40% is scope that was added *because* agent-manager had the config graph, not because users asked a config tool for it: ACP runtime client (`src/protocols/acp/` 1,434 LOC), A2A server (`src/protocols/a2a/` 1,768 LOC), A2A-ACP bridge, Flows engine (587 LOC), Marketplace (1,285 LOC), Knowledge Wiki (2,183 LOC), TUI, and two web UIs (local Hono + CF Workers worker). The MCP server exposes all of it (33 tools across 6 groups, 2,269 LOC in a single file).

The tagline (`README.md:3`, `package.json` description in `src/cli.ts:11`) still says "define once in TOML, sync via git, generate native configs for every tool." That sentence no longer describes what `am` does — it describes what `am` *started as*. The shipped 0.4.0 is closer to "configuration + runtime + marketplace + wiki platform for agents."

This is not categorically bad — the ACP runtime addition is directly motivated by a real user story (Claude Code migration v11 wipe, `ADR-0026` Context section) and genuinely extends the "single source of truth" thesis into runtime orchestration. But **three things drifted**: (1) the README keeps the old tagline, (2) no ADR decides whether runtime-ness is the new vision or a bolt-on, and (3) the CLI command tree reflects "everything that got built," not "everything the tagline promises." The 1.0 gap is mostly about picking a tagline and shaping the surface to match it.

**Vision coherence score: 6.5/10.** The core is a 9. The surface is a 5. The gap is framing, not code.

---

## Stated Vision (extracted)

### What agent-manager IS (from `README.md:3-6`, `ROADMAP.md:10-26`, `ADR-0001`):

- **Universal translation layer for AI tool configs.** One TOML catalog of servers, instructions, skills, agents, profiles → 13 adapters write native config files for Claude Code, Cursor, Copilot, Windsurf, Codex, ForgeCode, Kilo, Kiro, Gemini, Cline, Roo, Amazon Q, Continue (`README.md:32-65`).
- **Git as the sync protocol.** Every durable config change is an auto-commit. Push/pull gives machine parity. No proprietary cloud (`README.md:250-258`, `ADR-0002`, `ROADMAP.md:24-27`).
- **Local-first, agent-native, zero-friction security.** Offline by default, MCP server exposes config management to agents, secrets auto-detected and AES-256-GCM encrypted at import (`ROADMAP.md:21-26`, `ADR-0012`, `ADR-0023`).

### What agent-manager IS NOT (from same sources, read by negative space):

- **Not a coding agent runtime** — `ADR-0026` alternative #2: "am is not a coding agent. ACP servers are agents that receive prompts and edit code. am is a coordinator." ADR-0017 originally said "am does not implement ACP."
- **Not a plugin ecosystem competing with Claude Code** — `ADR-0001` lists Servers, Instructions, Skills, Agent Profiles, Profiles as the 5 core entities. Plugins, Permissions, Models "remain adapter-only until normalizable across 3+ tools."
- **Not an IDE / not a UI platform** — `ROADMAP.md` groups TUI + Web under "Interfaces" for the same underlying core, not as first-class products.

The first "NOT" is the one that 0.4.0 most visibly violates (`ADR-0026` explicitly overrides it as of 2026-04-16, but the README still hasn't absorbed the change).

---

## Surface-area alignment

| Surface | LOC (src) | Core vision / Adjacent / Orthogonal | Keeping? |
|---|---:|---|---|
| `src/core/` (schema, merge, secrets, git) | 2,838 | Core | Yes — this IS the product |
| `src/adapters/` × 13 + shared | ~unknown (detect/import/export × 13) | Core | Yes — this IS the product |
| `src/commands/` init/add/list/use/apply/status/import | ~1,400 | Core | Yes |
| `src/commands/` push/pull/undo/log/secret/doctor/config/profile | ~1,700 | Core | Yes |
| `src/commands/` install/uninstall/update/search (MCP Registry) | 608 | Core (ADR-0024) | Yes |
| `src/commands/` completion | 243 | Core-supporting | Yes |
| `src/mcp/server.ts` (am-as-MCP-server, core 14 tools) | ~1,000 of 2,269 | Core (ADR-0009) | Yes |
| `src/mcp/server.ts` (wiki/a2a/acp/session tool groups, 19 tools) | ~1,270 of 2,269 | Adjacent | Yes but gate by default |
| `src/wiki/` + `src/commands/wiki.ts` (13 subcommands, 981 LOC) | 3,164 | Adjacent | Keep; question value-per-LOC |
| `src/protocols/a2a/` (client + server + discovery) | 1,768 | Adjacent (ADR-0017) | Yes, splittable |
| `src/protocols/acp/client.ts + flows.ts + registry.ts` | 1,434 | Orthogonal originally (ADR-0017), re-scoped (ADR-0026) | Keep runtime; **cut Flows** |
| `src/protocols/bridge.ts` + unified-agent-registry | 515 | Adjacent (ADR-0030) | Yes — but wire the dead config |
| `src/marketplace/` (client/installer/scanner/security) | 1,285 | Orthogonal | **Cut or defer to v2** |
| `src/tui/` (Silvery/React) | ~1,000 est. | Orthogonal | Defer; it's a thin shell |
| `src/web/server.ts` (local Hono) | 680 | Orthogonal | Keep local, demote wiki UI |
| `src/web/worker.ts` (CF Workers stateless) | 609 | Orthogonal | **Cut or spin out** |
| `src/commands/flow.ts` + `acp/flows.ts` | 801 | Orthogonal | **Cut or defer to v2** |
| `src/commands/marketplace.ts` (7 subcommands) | 350 | Orthogonal | Cut with marketplace |
| `src/commands/adapter.ts` (community adapters, 571 LOC) | 571 | Adjacent (ADR-0027) | Mark experimental |

**Reading of the table.** Of ~15,000 LOC in `src/` feature code, roughly 7,000 directly serve the stated vision and 8,000 are adjacent-or-orthogonal. That's a 47/53 split against the tagline. A user reading `README.md` sees 31 commands and expects each to serve the thesis; instead 11 commands (marketplace ×7, flow ×3, adapter verify/update, run, agent ×5 = 16 subcommand paths) are orchestration/ecosystem features that a config manager doesn't need.

---

## Feature drift

### Code ships, README doesn't mention (or mentions at wrong prominence)

- **Dual agent namespace** (`src/cli.ts:51-52`): both `am agent` and `am agents` are registered as aliases for the same A2A+ACP roster command. README only documents `am agents` (`README.md:318`). Minor but tells you nobody pruned the alias.
- **Knowledge Wiki has 13 subcommands** — 981 LOC in `src/commands/wiki.ts`, but gets a single column in `README.md:548-564` sandwiched between Git Sync and A2A. A neutral reader would not guess this is a full BM25+NER+graph search engine.
- **Two web UIs**: `am serve` (local Hono with Bearer auth, `src/web/server.ts:680`) and a Cloudflare Workers deployment (`src/web/worker.ts:609`, `wrangler.toml`). README (`README.md:648-671`) mentions both, but the Workers one is a *separately deployed product* that shares no binary with `am`. It is not a surface of the CLI at all.
- **Two independent session stores**: `core/session.ts` harvests Claude Code / Codex transcripts (read-only); `protocols/acp/client.ts` manages ACP sessions (runtime, live). `am session list` and `am run session list` are *different things*. Docs do not disambiguate.
- **Shell completions** (`src/commands/completion.ts`, 243 LOC) are in code (`ROADMAP.md:231`) and briefly in the CLI reference (`README.md:635`) but aren't mentioned in the "Why" section or install instructions.

### README says / code half-ships

- `am add skill <name>` and `am add agent <name>` — `src/commands/add.ts:93-95, 271-280` routes these to `addStub` which prints "Adding <entity>s is coming soon. Use config.toml to add '<name>' manually." README lists agents as a first-class core entity (`README.md:206-216`). **Half-built for 2 of 5 core entity types.**
- `am marketplace --yes` flag exists but is ignored (from multi-agent-deep-analysis report 05, Theme A). README shows the CLI surface but implies full semantics.
- Bridge `permissionPolicy` / `allowedPaths` (`src/protocols/bridge.ts`) — declared config; not passed through to ACP client (deep-analysis 04 HIGH/CRITICAL). `README.md:300-310` advertises the bridge; readers assume permissions work.
- Adapter checksum field read but never written (deep-analysis 05, 02). Community adapter install goes through an unused verifier.
- `ROADMAP.md:172-236` "Planned — Next Sessions" lists 4 ADR statuses as "Complete" (A2A-ACP Bridge, Community Adapter Loading, Brownfield Import, Marketplace). Those ADRs in `ADRs/` are still labeled `status: proposed` in frontmatter (deep-analysis 09 HIGH-1). README implies stable; frontmatter implies proposed.
- Flows: ROADMAP entry is terse ("`am flow run <file>`") — the TypeScript-defined DSL in `ADR-0026 Phase 3` is a significant DX that is essentially undocumented outside the ADR. 214 LOC of CLI + 587 LOC of engine for a surface readers barely know exists.

### Shipped, nowhere in README

- Unified Agent Registry (`src/core/agent-registry.ts`, `ADR-0030`) — README only describes it in prose as "merges config agents > ACP built-in > A2A roster" (`README.md:309`), no mention that it replaced a duplicate registry or changed resolution order.
- `am agent cancel <name> <taskId>` — exists in `src/commands/agents.ts:11` docstring, absent from `README.md:568-574`.
- A2A discovery_sources auto-discovery (`README.md:331`) mentioned once; the discovery subcommand and TOML schema not documented.

---

## Sprawl indicators

These are symptoms of "every feature ships and then we figure out where it lives." Each one is individually minor; together they are the coherence tax.

1. **Three ways to list agents.**
   - `am list agents` → config `[agents.*]` entries (`src/commands/list.ts:82,188`).
   - `am agent list` / `am agents list` → unified registry incl. ACP built-ins + A2A roster (`src/commands/agents.ts:33`).
   - `am run agents` → ACP-viewable agents (`src/commands/run.ts:211`).
   All three return overlapping-but-different sets. A new user cannot guess which to run.

2. **Three session concepts.**
   - `am session list` → cross-tool transcript harvest (`src/commands/session.ts`, read-only, disk).
   - `am run session list` → live ACP sessions via JSON-RPC to agent subprocess (`src/commands/run.ts:244`).
   - MCP tools `am_session_list` (transcripts) vs `am_acp_session_list` (live) mirror the same split.
   Confusingly, both are called "sessions." No shared vocabulary.

3. **Two agent registries historically; now one but two files with near-duplicate names.**
   - `src/core/agent-registry.ts` (unified, 244 LOC, per ADR-0030).
   - `src/protocols/acp/registry.ts` (150 LOC, imports `BUILT_IN_ACP_AGENTS` from core). The file still exists with its own `resolveAgent`, a thin wrapper. Not wrong, just vestigial; the comment at `src/protocols/acp/registry.ts:14-16` explicitly acknowledges it.

4. **Two installation paths for "stuff from the internet."**
   - MCP Registry (`am install`, `am search`, `am update`) — `src/registry/` 2 files.
   - Marketplace (`am marketplace install`) — `src/marketplace/` 5 files, 1,285 LOC, adds plugin/skill/hook bundles.
   They share no code, no trust model, no lockfile. README describes them as different things but their UX overlaps (both "install a thing by name from a remote").

5. **Two adapter namespaces.**
   - Built-in adapters (13, in `src/adapters/<tool>/`).
   - Community adapters (JSON-RPC subprocesses, `src/adapters/community/`, `src/commands/adapter.ts` 571 LOC, ADR-0027). The CLI `am adapter list` mixes them. OK in theory; the subprocess protocol is undocumented (deep-analysis 09 HIGH-2).

6. **Two MCP tool groups that overlap.**
   - `session` group: list/export/search (transcript harvest).
   - `acp` group: `am_acp_session_list`, `am_acp_session_cancel` (live ACP).
   Both named "session," same shape of tool, different semantics.

7. **Two UIs, plus a third "interface".**
   - `am tui` (Silvery + React, 7 files, ~1,000 LOC).
   - `am serve` (Hono local web).
   - Cloudflare Workers stateless web (`src/web/worker.ts`) — not reachable via `am` binary at all.
   Each has to track config/wiki changes separately. No shared rendering layer.

8. **31 commands, 33 MCP tools, 13 adapters, 30 ADRs.** The README leads with this count (`README.md:9-12` badge row). Counts-as-value is a telltale of scope inflation.

---

## The 1.0 gap

Given the user's stated posture ("no 1.0 until beta proves"), the gap is not test coverage (1,864 passing), not typing (`as any` = 0), and not packaging (5 platforms, Homebrew, npm, install.sh). The gap is **coherence and honesty**:

### Must tighten before 1.0

1. **Pick a tagline and shape the surface to match.** Either:
   - (a) Keep "chezmoi for configs" → move ACP runtime, Flows, Marketplace, A2A server behind `am-runtime` / opt-in subcommand / separate binary. Ship `am` as the config layer.
   - (b) Rebrand: "the control plane for AI agents — configs, runtime, knowledge, discovery." Acknowledge scope. Update README, CLAUDE.md, `ADR-0001`, `package.json` description.
   Doing neither (current state) is the problem, not the scope itself.

2. **Finish or cut the half-built entities.** `am add skill` / `am add agent` stubs (`src/commands/add.ts:271-280`) must work in 1.0 since `README.md` lists both as core entity types. If wiring them is expensive, delete the CLI path and say "edit TOML directly." Half is worst.

3. **Fix the declared-not-enforced config knobs.** Bridge `permissionPolicy`, adapter `sha256` checksum, marketplace `--yes`, MCP `inputSchema`. These are the same pattern: documentation that lies about behavior. Either make them work or remove them. The prior deep-analysis report (Theme A) covers these; the vision lens just underlines why: a config tool that doesn't honor its own config is a credibility fault.

4. **Flip the 4 "proposed" ADRs to "accepted"** (0026, 0027, 0028, 0030). Otherwise the project is shipping features on unapproved designs. Minor doc debt, big signaling value.

5. **De-conflict the three "session" and "agent list" surfaces.** Either rename (`am runtime session list`, `am transcript list`), or collapse to one list with a filter. Today a user cannot predict behavior.

### Should defer to v2 (or cut)

1. **Cloudflare Workers stateless web UI** (`src/web/worker.ts`, 609 LOC). It is a separate deployable product. Spin it out into `agent-manager-web` repo. It shouldn't block the CLI's 1.0 story, and having it in `src/` of the CLI repo signals "we also ship a SaaS" which the README says we don't.
2. **Flows engine** (801 LOC across `src/commands/flow.ts` + `src/protocols/acp/flows.ts`). It is agent-manager attempting to be a workflow orchestrator. There are dedicated projects for this (LangGraph, Mastra, ACPX itself). `ADR-0026 Phase 3` is the only design doc, and Flows are barely in the README. Defer to v0.5+ or cut.
3. **Marketplace** (1,285 LOC). The supply-chain threat surface is large (deep-analysis Theme B) and the use case ("community plugin ecosystem on top of `am`") is aspirational. MCP Registry already solves server install. Defer marketplace to v2 — or scope it down to "install a config bundle from a git URL" without the plugin / skill / hook abstraction.
4. **TUI** (Silvery + React). 7 files. It is a read-mostly dashboard over the same core. It's nice-to-have, not a first-1.0 necessity. Move behind `am tui --experimental` or cut.
5. **A2A as a *server*** — keep the A2A *client* (discover, delegate, ping) because that IS the agent-native consumption story. The 773-LOC A2A server in `src/protocols/a2a/server.ts` plus bridge is "be an A2A endpoint for other agents." This is ACP-server-like scope that `ADR-0026` rejected for ACP. Either accept this symmetry (and write an ADR that revises ADR-0017 accordingly), or defer the server to v2.

---

## Recommendations

### Concrete steps, ordered

1. **Draft ADR-0031: "What agent-manager IS (v1.0 scope lock)."** One page. Lock the tagline, enumerate in/out-of-scope surfaces. Reference this when deciding whether new iteration features get merged. Today there is no gate.

2. **Write a 5-bullet `README.md` opening that matches reality.** The current opening (`README.md:3-6`) is from a prior iteration. If the team keeps runtime/marketplace/flows, say so. Move the badge row down.

3. **Create `docs/architecture-1.0.md` with the Mermaid that's already in `README.md:678-700`** but annotated with "vision core" vs "adjacent" vs "experimental/opt-in" color bands. Users will see the shape and the team will have a backstop for future feature requests.

4. **Gate opt-in surfaces at the CLI level**. A single env / flag `AM_EXPERIMENTAL=1` (or a settings section) hides `am flow`, `am marketplace`, `am adapter`, `am tui` from `am --help` unless enabled. Forces the default surface to match the default vision.

5. **Cut these 3 with PRs labeled `cut-scope-v1`**:
   - `src/web/worker.ts` + `wrangler.toml` → new repo.
   - `src/protocols/acp/flows.ts` + `src/commands/flow.ts` + tests → new repo or feature branch.
   - The second web UI served from `am serve` gets scoped down to a read-only drift/status viewer.

6. **Reconcile the three "list" surfaces.** One command: `am list agents [--runtime | --roster | --config]`. Delete `am run agents`. Keep `am agent list` as an alias.

7. **Pass the MCP tool group count from 33 → 20 by default.** The README's `settings.mcp_serve.tools` defaults to `["core"]` (14 tools) — good. But the 19 non-core tools (wiki, a2a, acp, session groups) should require an explicit settings change with a pointer to their respective ADR. "Enable this tool group" is a coherence boundary.

8. **Rewrite the Project Stats block** (`README.md:753-766`). Replace counts (13 adapters, 31 commands, etc.) with capability claims ("Import/export MCP servers across every major AI coding tool," "Detect drift without overwriting"). Counts are scope-inflation signals.

9. **Add a 5-minute "what is agent-manager" video-or-text walkthrough** that exercises only `init → add → apply → status → push`. If a new user can't reproduce in 5 minutes, the vision is lost regardless of what code says.

### Acceptance test for "1.0 coherence"

A fresh reader of the README, given only `am init` and 5 minutes, should be able to:

- State the product in one sentence, matching the README tagline.
- Identify the 3–5 core commands.
- Not be surprised by anything in `am --help`.
- Know where the line is between "core" and "opt-in / experimental."

0.4.0 fails on the last two. The fix is mostly prose + flag-gating + a handful of cuts, not new code.

---

## Appendix: Evidence index

- Vision statements: `README.md:3-6`, `README.md:28-43`, `ROADMAP.md:10-27`, `ADR-0001:1-54`, `ADR-0026:34-41`.
- Stub-implemented `am add skill/agent`: `src/commands/add.ts:93-95, 271-280`.
- Duplicate listings: `src/commands/list.ts:82,188`, `src/commands/agents.ts:33`, `src/commands/run.ts:211`.
- Duplicate session concept: `src/commands/session.ts:1`, `src/commands/run.ts:244`.
- Two MCP tool session groupings: `src/mcp/server.ts:198-220`, see tool registry for `am_session_*` and `am_acp_session_*`.
- Unified registry (ADR-0030) + vestigial file: `src/core/agent-registry.ts:1-38`, `src/protocols/acp/registry.ts:11-17`.
- Marketplace: `src/marketplace/*.ts` 1,285 LOC, `src/commands/marketplace.ts:1-350`.
- Flows: `src/protocols/acp/flows.ts:1-587`, `src/commands/flow.ts:1-214`.
- CF Workers: `src/web/worker.ts:1-609`, `wrangler.toml`.
- TUI: `src/tui/` 7 files.
- ACP runtime role revision: `ADR-0026:42-53` (explicitly overrides `ADR-0017`).
- ADR frontmatter-vs-shipped status: `ADRs/0026-*.md`, `0027-*.md`, `0028-*.md`, `0030-*.md` still `proposed`; `ROADMAP.md:174-222` marks them Complete.
- Declared-but-dead configs: bridge `permissionPolicy` in `src/protocols/bridge.ts` (see deep-analysis report 04); adapter checksum in `src/adapters/community/loader.ts` (deep-analysis 05, 02).
- Tagline in code: `src/cli.ts:10-12`.
