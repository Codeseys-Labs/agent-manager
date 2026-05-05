# Parallel-Critique Synthesis — agent-manager

Date: 2026-05-05
Inputs: four reviewer reports (Vision, Security, Architecture, Integration-with-Hermes) in this directory.
Codebase: `am` — Bun/TypeScript CLI, 2662 tests green at time of review.

---

## Executive summary

**Overall grade: B- / shipping-shaped with a fraying perimeter.** The core spine
(`core/controller.ts` with `withConfig` + `applyResolved`, 13-adapter pattern,
two-phase Zod, ADR discipline, git-backed config) is genuinely elegant and
earns its keep. Concurrency work and security hygiene on the central write
path are real, not theater. But the product has over-extended: two of the six
ADR-0031 pillars (Marketplace, Three-UIs) are paperware or partial, two
load-bearing ADRs (0007 Phase 2, 0031 pillar 6) don't match the code,
single-file megaliths have accumulated (`mcp/server.ts` 3,245 LOC,
`commands/wiki.ts` 1,361 LOC, `commands/run.ts` 958 LOC), and there is at
least one concrete RCE-class supply-chain hole in the marketplace installer.

**Top 3 things to do first** (detailed in "Next 3 moves" below):
1. **Close the marketplace command-execution hole + propagate `sandboxEnv()` to the community adapter proxy.** Security P0.
2. **Resolve ADR-0007 Phase 2: wire it or delete it.** It is 500 LOC of dead schema infrastructure that two independent lenses flagged.
3. **Pick one of {deepen pillar 5 (wiki), harden pillar 2 (MCP gateway)} as the "next bet" and formally defer pillar 4 (Marketplace v1).** The vision and integration lenses disagree about marketplace; that disagreement needs a maintainer decision, not more ADRs.

---

## Convergent findings (P0 / P1)

Items where **two or more lenses independently pointed at the same class of issue**. Cross-lens convergence on different concerns (e.g. vision + architecture) is treated as stronger signal than cross-lens convergence within a single concern.

### C1 — Single-file megaliths across the codebase  [P1]
**Lenses:** Vision, Architecture.
**Evidence:**
- `src/mcp/server.ts` — 3,245 LOC, `defineTools()` registers 33+ tools inline from line 786
- `src/commands/wiki.ts` — 1,361 LOC, 17 CLI subcommands (larger than `src/wiki/` itself at 780 LOC)
- `src/commands/run.ts` — 958 LOC, ~500 LOC of agent resolution logic pre-spawn
- `src/protocols/a2a/server.ts` — 966 LOC
Four files ≈ 15% of `src/` LOC. iter4 flagged this; no mitigation has landed.
**Action:** Split `mcp/server.ts` to one file per tool; split `commands/wiki.ts` per subcommand; extract `resolveRunTarget(agentName, opts): RunPlan` into `core/agent-registry.ts`.
**Severity:** P1 maintainability. Effort: L for MCP, M for wiki, M for run.

### C2 — ADR-0007 Phase 2 validation is dead code  [P1]
**Lenses:** Vision (mentioned implicitly via "two-phase Zod" as strength but no usage check), **Architecture (direct, HIGH)**; the security lens also implicitly relies on this existing (see C3 below re: marketplace server schema). The architecture lens is the primary voice; listing here because it interacts with C3.
**Evidence:** `rg '\.schema\.(parse|safeParse)'` in `src/` returns **zero hits**. All 13 adapters populate a `schema` field that nothing reads. Community proxy fetches adapter JSON-Schema but never validates against it. `adapters.<name>` subtable is preserved as `z.unknown()` and never revalidated.
**Action:** Either (a) wire `adapter.schema.server?.safeParse(server.adapters[name])` at config load for built-ins, and validate community-proxy responses against their declared JSON-Schema, **or** (b) delete the `schema` field from the adapter interface and amend ADR-0007 with "Phase 2 deferred indefinitely."
**Severity:** P1 architecture / correctness. Effort: S to delete, M to wire.

### C3 — Marketplace: biggest liability **and** biggest integration win (decision required)  [P0]
**Lenses:** Vision ("cut or defer — circular ADR-0034/0035, 72% paperware"), **Security (HIGH — RCE via `serverDef.command`/`args` copied verbatim in `src/marketplace/installer.ts:126-148`, validated only as `z.string().min(1)`, triggered on `am apply`)**, Integration (flagged as #1 concrete win — "Hermes-as-am-marketplace").
**Evidence:** Installer applies plugin servers with no sanitization, no command allowlist, no prompt on novel executables. SHA pin proves same-code-as-TOFU, not benign. Path-traversal scrub applied to `skills[]` and `agents[].prompt_file` but NOT server `command`/`args`. ADR-0034 and ADR-0035 reference each other without code.
**Action:** (1) Security fix first: prompt-on-install showing full `command + argv`; allowlist for novel executables; warn on shell-invoking commands (`sh -c`, `bash -c`). (2) Decision ADR: either commit to marketplace v1 (with security fix + Hermes as validation customer) or mark v0 internal-only and retire ADRs 0034/0035 in favor of MCP Registry. Do **not** leave in 72%-done limbo.
**Severity:** P0 security (exploit today), P0 product (blocks roadmap).

### C4 — Controller / "three UIs over one core" claim is overstated  [P1]
**Lenses:** Vision, Architecture.
**Evidence:** TUI and local web DO route writes through `withConfig` + `applyResolved`. **CF Worker imports nothing from `src/core/*`** — it speaks git-over-HTTP only. This is correct per ADR-0015 (independently deployable), but directly contradicts ADR-0031 pillar 6's literal wording. Controller covers RMW+apply only; `run`, `agents`, `flow`, `wiki`, `session`, `import`, `secret` have significant logic outside the mutex.
**Action:** Amend ADR-0031 pillar 6 to read "all local write paths route through controller; CF Worker is an independently-deployed git client, not a controller client" (per ADR-0015). Update AGENTS.md pillar 6 text identically. Add missing ADR: "Controller scope & concurrency model (withConfig + AsyncMutex)."
**Severity:** P1 spec hygiene (not code). Effort: S.

### C5 — Terminology / counts drift & badge-inflation  [P1]
**Lenses:** Vision (primary), Architecture (secondary, via "ADR-0032 exists but isn't enforced").
**Evidence:** AGENTS.md says "33+ tools"; ROADMAP says "33 tools, 31 commands"; `src/commands/` has 34 files. AGENTS.md leads with "13 IDE adapters", "33+ tools", "38 ADRs" — counts-as-value framing. ADR-0032 (glossary) was written specifically to stop this drift.
**Action:** Single-source-of-truth all counts. Generate AGENTS.md's "13 adapters / 34 commands / 33 tools" block from code at doc-build time, or drop the numbers entirely.
**Severity:** P2, but easy.

### C6 — Flows (`acp/flows.ts` 591 LOC) contradicts ADR-0031's explicit non-goal  [P1]
**Lenses:** Vision (primary), Integration (secondary — "am is NOT a workflow orchestrator; Hermes deep-work-loop should stay separate").
**Evidence:** ADR-0031 lines 94, 129-132 say "NOT a general-purpose workflow orchestrator; flows serve pillar 3 composition only." Flows engine is 591 LOC and growing. iter2 already recommended cutting it.
**Action:** Either (a) scope flows down to "ACP multi-agent composition only; no loops/branches" and enforce in schema, or (b) amend ADR-0031 to admit flows are a workflow primitive. Current state is spec drift.
**Severity:** P1 vision coherence.

### C7 — 13× duplicated write-loop in adapter exports  [P2]
**Lenses:** Architecture (primary; adjacent to Vision's praise of the 6-file adapter pattern).
**Evidence:** Each adapter has `for (const file of files) { mkdirSync; atomicWriteFileSync }` with inline `require("node:fs")`.
**Action:** Extract `src/adapters/shared/write-files.ts`. Removes ~150 LOC. Effort S.

---

## Union findings (individual-reviewer backlog)

Worth tracking; no cross-lens convergence.

**Security-only:**
- Community adapter proxy (`src/adapters/community/proxy.ts:60-66`) inherits full parent env into spawned subprocess — AM_ENCRYPTION_KEY, AWS_*, GITHUB_TOKEN, etc. Fix from REV-2 HIGH-3 was applied to `protocols/acp/client.ts` but NOT propagated here. Route through `sandboxEnv()`. **HIGH.**
- Decrypted plaintext secrets land in ≥13 native IDE config files on `am apply`. SECURITY.md says "AES-256-GCM" — true for `config.toml`, misleading for downstream. Add explicit ADR + SECURITY.md note.
- Wiki path traversal via `GET /api/wiki/pages/:slug` (`src/web/server.ts:731-738`) — slug passed to `readPage` unvalidated. Post-auth, but bearer-token-to-arbitrary-file-read. Fix: `^[a-z0-9][a-z0-9._-]*$`.
- Secret detection advertises "24 providers" but mechanism is key-name substring matching; value-shape regexes exist in `src/lib/redact.ts` but aren't wired into scan. Add tier-1.5.
- `Bun.serve` default host binds all interfaces; should default loopback, `--public` flag for wider.
- CF Worker HKDF salt is a fixed string constant; should be per-session random.
- Missing tests: `marketplace/installer.security`, `adapters/community/proxy.env`, `web/wiki.path-traversal`, `core/secret-detection.values`, `web/server.hostname`, `marketplace/installer.provenance`.

**Architecture-only:**
- ADR-0027 community loader under-wired: `getDetectedAdapters()` iterates `listAdapters()` (built-in only), not `listAllAdapters()`. Community adapters never auto-run under `am apply`.
- ADRs 0034-0038 all Proposed — five in a row unpromoted. Promote or close.
- Missing ADRs worth writing: Controller scope/concurrency, Adapter shared utilities boundary, Command file-size policy.

**Vision-only:**
- Pillar 5 (LLM-wiki) has the lowest test ratio of any pillar: 148 tests for 2,781 + 1,361 LOC. Only 2 of 13 adapters have `SessionReader` implementations — pillar 5's cross-tool promise is unmet.
- Pillar 6 (UIs): TUI punts add/edit to CLI; CF Worker is read-only. "Three UIs over one core" is aspirational.

**Integration-only:**
- `am wiki distill --as-skill` — emit wiki rules in Claude-Code SKILL.md format; reimplements Hermes's `session-to-skill` with strictly more power.
- Hermes-as-MCP-client: point Hermes Claude-Code / Codex / OpenCode skills at `am mcp-serve`, collapsing three wrapper skills to one `am-delegate`.
- Add `[skills.<name>.activation]` block to reconcile am's catalog-item ontology with Hermes's trigger-on-keyword ontology. Parallel to the `instructions` activation block that already exists.

---

## Disagreements & tensions

**D1 — Marketplace: cut vs. lean in.**
Vision says cut/defer (circular ADRs, paperware, MCP Registry already does install-from-URL). Integration says this is the #1 external integration win (Hermes has a 20+ skill library as ready validation corpus). Security says it is currently exploitable; fix before doing anything else.
**Reconciliation:** All three are compatible if sequenced: (1) fix C3 security hole unconditionally; (2) a new ADR makes the cut/lean-in call explicit — either one "Marketplace v1" ADR superseding 0034/0035 with Hermes as first customer, or retire both as `Rejected` and point at MCP Registry. Do not leave as paperware.

**D2 — Flows: cut vs. keep.**
Vision + Integration lean "cut / don't expand"; Architecture silent; Security didn't examine. Low-disagreement — direction is "scope down + enforce in schema."

**D3 — "Controller as single chokepoint."**
Vision treats it as a strength ("quiet hero"). Architecture calls it "narrower than ADR-0031 claims." Both right: design is good for local write paths; claim overstates coverage. Fix is documentation (see C4).

---

## Recommended next 3 moves

Ranked by value × (1 / effort). Each item is sized to a concrete pull-request-shaped task.

### Move 1 — Marketplace security fix + decision ADR  [1-2 days code + decision]
**Why:** C3 is the only P0-security in the pile and simultaneously unblocks the biggest roadmap ambiguity (D1).
**Tasks:**
- Patch `src/marketplace/installer.ts:126-148`: prompt-on-install showing full `command + argv`, allowlist for novel executables, warn on shell-invoking commands.
- Add regression tests: `test/marketplace/installer.security.test.ts` (malicious command in manifest), `test/marketplace/installer.provenance.test.ts`.
- Propagate `sandboxEnv()` to `src/adapters/community/proxy.ts:60-66` + test.
- Write ADR-0039: "Marketplace v1 scope decision" — either commits to Hermes-as-first-customer path (per integration lens) or retires ADR-0034/0035 in favor of MCP Registry (per vision lens). Maintainer call.

### Move 2 — ADR-0007 Phase 2 resolution + controller scope ADR  [2-3 days]
**Why:** C2 is 500 LOC of dead infrastructure across 13 adapters; leaving it there poisons every future adapter refactor. C4 is a free spec cleanup that aligns ADRs with shipped code.
**Tasks:**
- Decide: wire or delete. Default recommendation: **wire** for built-in adapters at config load (low risk, catches typos in `adapters.<name>` subtables), and **wire** for community-proxy responses (non-trivial security win — validates untrusted adapter output).
- If deleted instead: remove `schema` field from adapter interface, drop 13 schema declarations, amend ADR-0007 "Phase 2 deferred."
- Write ADR for controller scope / concurrency (withConfig + AsyncMutex).
- Amend ADR-0031 pillar 6 per C4.
- Amend AGENTS.md pillar 6 text.

### Move 3 — Megafile split: `mcp/server.ts` first, then `commands/wiki.ts`  [1 week]
**Why:** C1 is the single largest maintainability risk flagged by two lenses. Splitting `mcp/server.ts` also reduces surface for C3-class bugs (easier to audit per-tool) and sets up pillar-5 depth work (move 4 candidate) by taming `commands/wiki.ts`.
**Tasks:**
- `src/mcp/server.ts` → `src/mcp/tools/<name>.ts` (one per tool) with `defineTools()` becoming a registry-of-imports. Per-tool tests become colocatable.
- `src/commands/wiki.ts` → one file per subcommand under `src/commands/wiki/`; trim the 17-subcommand CLI down to 5 verbs (list/show/search/sync/ingest) per vision lens's pillar-5 recommendation.
- Extract `resolveRunTarget(agentName, opts): RunPlan` from `src/commands/run.ts` into `src/core/agent-registry.ts`.
- Extract `src/adapters/shared/write-files.ts` (C7) — do opportunistically in the same PR series.

**Deferred / anti-recommendations** (from vision lens, endorsed by this synthesis): do NOT add a 14th IDE adapter; do NOT build CF Worker into a full-featured UI; do NOT expand flows beyond ACP composition without amending ADR-0031 first.

---

## Review-process caveats

All four reviewers were intended to be different model families (Gemini, GPT-5.5, DeepSeek, Kimi) via OpenRouter, but a provider-routing misconfiguration routed all four to **Claude Opus 4.7 via Bedrock**. Diversity came from **prompt lenses**, not model families. Weight convergence accordingly: strong signal is a finding flagged across different concerns (C1, C3, C4 meet this bar — vision + architecture on megafiles; vision + security + integration on marketplace). Weaker signal is convergence inside a single concern (same pattern-match tendency of one model). Single-lens findings are no stronger than a single Opus pass — treat as leads, not conclusions. Recommend re-running once provider routing is fixed, before committing engineering time to Move 3.
