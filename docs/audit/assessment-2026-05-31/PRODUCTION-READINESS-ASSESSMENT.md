# agent-manager — Production-Readiness Assessment

**Date:** 2026-05-31
**Repo:** `/mnt/e/CS/github/agent-manager`
**Version under review:** `0.5.0-rc6`
**Author:** Lead architect (consolidated from 8 subsystem audits + 3 cross-cutting critique lenses)

This is the authoritative, decisive assessment. It reasons across — and where they
disagree, resolves — the eight dimension reports in this directory and the three
cross-cutting lenses (scope/architecture fitness, ship-it GO/NO-GO, competitive/wizard DevEx).

Source dimension reports cited throughout:

| # | Dimension | Report |
|---|-----------|--------|
| 1 | Vision & scope | [`vision-and-scope.md`](vision-and-scope.md) |
| 2 | Core engine | [`core-engine.md`](core-engine.md) |
| 3 | Adapter layer | [`adapter-layer.md`](adapter-layer.md) |
| 4 | MCP & protocols | [`mcp-and-protocols.md`](mcp-and-protocols.md) |
| 5 | Onboarding & wizard | [`onboarding-and-wizard.md`](onboarding-and-wizard.md) |
| 6 | Distribution & packaging | [`distribution-and-packaging.md`](distribution-and-packaging.md) |
| 7 | Secrets & security | [`secrets-and-security.md`](secrets-and-security.md) |
| 8 | Quality & maintenance | [`quality-and-maintenance.md`](quality-and-maintenance.md) |

---

## 1. Executive Verdict

**Architected right? — YES. Rearchitect? — NO. Verdict: `narrow-then-ship`.**

agent-manager is a genuinely well-engineered kernel wearing a marketing skin three
sizes too big. The architecture is coherent, layered, tested, and concurrency-safe;
**all eight dimension auditors and all three critique lenses independently arrived at
`refactor-in-place` — not one called for a rearchitect.** The product, not the
architecture, is the problem: an uncontrolled six-pillar vision, a fictional onboarding
wizard, two of three install channels broken, and a documented secrets path that
silently corrupts user configs.

The decision is therefore **not "rebuild" — it is "narrow and finish."** Ship pillars
1 (catalog + git-sync + adapters) and 2 (MCP gateway) as v1.0 over the one working
install channel; build the orchestration wizard the README already dramatizes (every
primitive exists); fence off everything else (ACP/A2A/flows/variants/marketplace/
pair/age-secrets/hosted-UI) as experimental and out of the first-run surface; and
reconcile the docs to the code. This is roughly **one to two focused weeks**, not a
quarter-long rebuild.

**Release manager call for a v1.0 downloadable CLI today: NO-GO.** Four blockers (broken
install honesty, fictional wizard, data-corrupting age-secrets path, pervasive doc
drift) each independently fail the bar "a stranger installs it and gets value in ten
minutes without reading source." All four are cheap and bounded. None require touching
the core engine.

---

## 2. What agent-manager Is (Vision vs. As-Built Reality)

### The vision (as marketed)

"**The control plane for AI agents.**" Define your catalog once in TOML, sync via git,
generate native configs for every AI coding tool, route any agent through a unified MCP
gateway, delegate via ACP (local) or A2A (remote), subscribe to marketplaces, remember
sessions in an LLM-wiki, edit from terminal / local web / cloud. Codified as **six
pillars** in ADR-0031.

### The reality (as built and verified)

A **sharp, shippable two-pillar product** hiding inside a six-pillar marketing frame.

| Pillar | Marketed as | Verified reality | Status for v1 |
|--------|-------------|------------------|---------------|
| 1. Catalog + git sync | Core | **Mature, production-grade.** ~1,210 LOC kernel, 13 adapters on a clean `detect/import/export/diff` interface, drift detection, AES secret hygiene | **SHIP** |
| 2. MCP gateway | Core | **Most production-grade subsystem.** 38 tools, 3 permission tiers, bearer auth, Zod validation, concurrency mutex, 605 passing tests | **SHIP** |
| 3. Protocol router (ACP/A2A) | Core | Wired end-to-end, secure-by-default, but narrow runnable roster (4 tier-1, 2 npx-dependent), binary-hostile Flows engine | **FENCE (experimental)** |
| 4. Marketplace | Core | **Dead pillar still walking.** Formally retired (ADR-0039), scheduled for deletion (ADR-0052), 1,875 LOC, yet still in `cli.ts:59` AND in the live root tagline (`cli.ts:11`) | **DELETE** |
| 5. LLM-wiki | Core | Functional; BM25 search; harvest-dependent (empty without session harvest) | **FENCE (experimental)** |
| 6. Three UIs over one core | Core | **Was factually false at write-time** — required companion ADR-0031a one month later to walk back the "no parallel implementations" claim; the CF Worker imports nothing from `src/core/*` | **FENCE / re-frame** |

**The discrepancy between vision and reality is itself the central finding.** Two
incompatible taglines ship simultaneously: README/CLAUDE say "control plane, not
chezmoi" while ROADMAP leads with "chezmoi for AI configs." The README dramatizes an
`am init` that auto-detects per-tool server counts, prompts "Import all? [Y/n]", merges
22 servers, and scans secrets — **none of which the real `am init` does** (verified:
`src/commands/init.ts:157` only prints `Run \`am import auto\``). The advertised
one-command onboarding is fiction.

**Scope is not controlled.** Verified on disk: **55 ADRs** exist (docs variously claim
30/47/52). Thirteen ADRs (0039–0052) shipped *after* the scope-defining ADR-0031,
adding a ~2,469-LOC secrets/pair/hosted-auth/CodeMirror-editor product line that maps to
no pillar. The "which pillar does this serve?" gate gated nothing.

**Pervasive stat drift** (every documented number is wrong somewhere): tests are
**3,064** (badge says 2,906; ROADMAP 1,916; AGENTS 1,772); commands are **36** (docs say
31); ADRs are **55**; source files ~215. **39 external meta-tooling files**
(`.seeds`/`.mulch`/`.canopy`/`.overstory`) are committed in violation of the user's
standing rule.

**Net:** The thing that is real and excellent (pillars 1+2) is buried under a vision the
project keeps expanding faster than it can control, and the front door describes
software that does not exist.

---

## 3. Architecture Assessment (Per-Dimension Scorecard)

Scores 0–10. The split between **engine quality** and **first-contact readiness** is the
recurring theme: the code is strong, the surface a stranger sees is not.

| # | Dimension | Score | Verdict | One-line rationale |
|---|-----------|:-----:|---------|--------------------|
| 1 | **Vision & scope** | **4** | narrow-then-ship | Coherent pillar-1/2 core wrapped in an uncontrolled 6-pillar frame; 13 post-scope ADRs; broken install + fictional `am init` |
| 2 | **Core engine** | **7** | refactor-in-place | Tested, pure, concurrency-safe (ADR-0040/0041 verified implemented); localized defects — core↔adapters type cycle, raw ZodError UX, union-only merge, default-passthrough |
| 3 | **Adapter layer** | **7** | refactor-in-place | Clean serializable interface, 13 adapters, hardened community subprocess model; half-wired shared layer (dead+duplicated generators), inconsistent diff coverage, wrong authoring docs |
| 4 | **MCP & protocols** | **6** | refactor-in-place | MCP server is ship-quality; held back by absent wizard, binary-hostile Flows, thin npx-dependent roster, ADR drift |
| 5 | **Onboarding & wizard** | **3** | refactor-in-place | No wizard exists; `am init` is a stub; README promises a flow the code lacks; no clone-from-remote path. Primitives all exist — wiring gap, not architecture |
| 6 | **Distribution & packaging** | **4** | refactor-in-place | `curl\|sh` channel is real and checksum-verified; npm name owned by an unrelated deprecated stranger, brew tap never created, Windows unverified by design |
| 7 | **Secrets & security** | **4** | refactor-in-place | Legacy AES path is production-grade (~7 alone); coexisting age path is mid-migration and **silently corrupts native configs on the documented happy path** |
| 8 | **Quality & maintenance** | **5** | refactor-in-place | Strong engine (3,064 tests green, clean lint, ~0 debt) gated by broken bookkeeping — wrong badge, contradictory stats, committed meta-tooling, untrustworthy ADR index |

**Aggregate production-readiness: 4.5 / 10.** Engine substance averages ~7; first-contact
surface averages ~3.5. The gap *is* the assessment.

### Contradiction resolved: does `scripts/install.sh` 404?

The onboarding auditor flagged the README install one-liner as a 404 (no
`scripts/install.sh`). **This is wrong and is hereby corrected.** Verified: the README
`curl` points at `.../main/install.sh`, and `install.sh` **exists at the repo root**
(6,376 bytes, executable). The ship-it lens is correct: the `curl|sh` channel works and
is checksum-verified. The real install blockers are npm (wrong/foreign package) and brew
(tap never created), **not** the curl path. This correction matters: the curl channel is
the one working door and the wizard's only safe install instruction.

---

## 4. The Setup Wizard — Gap & Design

### 4.1 Current `am init` reality

`src/commands/init.ts` (~182 LOC) is a thin stub. It:

1. `mkdir` the config dir + `initRepo` (git init)
2. Writes a fixed 5-line `config.toml` with a single hard-coded `default` profile
3. TTY-only `clack.confirm` to generate a **legacy AES** key (`generateKey`/`saveKey`)
4. TTY-only `clack.text` to set a git remote
5. Calls `getDetectedAdapters()` — then **only prints** `Run \`am import auto\`` (line 157)

It does **not** import, merge, dedupe, scan secrets, create a real profile, chain into
`apply`, or pull from a remote on a new machine. It hard-exits `code 1` on re-run
("Already initialized") — hostile to resumption. It offers no secrets-backend choice and
is undriveable non-interactively (both prompts gate on `process.stdin.isTTY`; no
`--yes`/`--remote`/`--no-key` flags).

**The delta between what the README claims `am init` does and what `init.ts` actually
does IS the unbuilt wizard.** This is the single most damaging trust defect: the
marketing surface describes a product the code is not.

### 4.2 The good news: every primitive already exists

This is a **wiring/orchestration problem, not a capability or architecture problem.** All
building blocks are present, tested, and independently callable:

| Wizard need | Existing primitive | Location |
|-------------|--------------------|----------|
| Detect installed tools | `getDetectedAdapters()` | `src/adapters/registry.ts` |
| Brownfield import + dedup + secret auto-encrypt | `am import auto` engine (ADR-0028) | `src/commands/import.ts` |
| Per-target preview before write | `apply --dry-run` + ADR-0038 `DryRunEnvelope` | `src/commands/apply.ts` |
| Concurrency-safe config writes | `withConfig` + `AsyncMutex` (ADR-0040) | `src/core/controller.ts` |
| Live apply | `applyResolved` | `src/core/controller.ts` |
| Legacy AES key | `generateKey`/`saveKey` | `src/core/secrets.ts` |
| Git remote | `addRemote` | `src/core/git.ts` |
| Health "done" signal | `am doctor` 11-check inventory (`--json`, exit codes) | `src/commands/doctor.ts` |
| Reference UX pattern | `am install` — TTY-guarded clack, per-var validation, `--yes` fallback | `src/commands/install.ts` |

### 4.3 Proposed `am setup` wizard (step-by-step)

A single resumable, idempotent, `--json`/`--non-interactive`-capable command. Modeled on
chezmoi (`promptOnce` idempotency), gcloud (progressive disclosure), firebase (feature
checklist), aws (`[default]` echoing), and clack (`group()`/`spinner`). **It must default
to legacy AES and treat the age path as not-yet-shipped (see §5 P0-3).**

| Step | Action | Built on | Notes / safety |
|------|--------|----------|----------------|
| **0. Preamble + plan + idempotency probe** | `clack.intro`; one-line telemetry-free / "secrets encrypted locally, never committed" trust note; probe `config.toml` / key / remote / profiles and mark each step new/skip/re-run | new orchestration | In `--dry-run`/`--json`, emit full plan via ADR-0038 envelope and exit without writing. **Fixes the hostile `exit 1` on re-run.** |
| **1. Initialize catalog (idempotent)** | If no `config.toml`: `initRepo` + write default `Config`. If exists: skip with note | `init.ts` logic via `withConfig{noCommit}` | Shared core that both `am init` and `am setup` call. Must write a **schema-valid** config so the user never hits the raw-ZodError path (core P1-A) |
| **2. Detect + multi-select tools** | `getDetectedAdapters()` → `clack.multiselect` pre-checked with all detected; auto-select if exactly one; if zero, branch to Registry-search / manual-add | `getDetectedAdapters` | **Per-target opt-in fixes the global-write blast radius** (adapter W: `apply` fans out to every detected tool with no confirmation). Detection is pure file-presence and over-reports — let the user correct it |
| **3. Brownfield import (RUN it)** | "Import existing configs?" (default yes) → run `am import auto`; report N servers / M instructions / K dedups | `import.ts` (ADR-0028) | **This is the step `am init` punts on.** Executing it is the difference between a wizard and a hint |
| **4. Encryption key (legacy AES only)** | If no key: confirm → `generateKey`/`saveKey`; print exact path + "lives outside git-tracked dir, gitignored"; offer to encrypt imported plaintext secrets | `secrets.ts` (ADR-0012) | **Do NOT offer age / `am secrets migrate --to age` / multi-device / team** — those break the next `apply` (§5 P0-3). Turn AES into a visible trust signal |
| **5. Profile creation** | `clack.text` defaulted to repo/dir basename (aws-style); optionally assign servers to profile; skip if a non-`default` profile exists | resolver + config | **Defuses the default-passthrough surprise** (core W4): an absent/empty default profile exports the ENTIRE catalog to every tool. Create an explicit narrowing profile and explain additive-only layering |
| **6. Optional Registry search** | Default-no confirm → query → `searchCommand` → multiselect → `install --yes` | registry client | Greenfield value + showcases a differentiator union-sync scripts lack |
| **7. Optional git remote (TTY/CI-aware)** | `clack.text` remote, `[skip]` default; non-TTY auto-skip + print manual command. `am setup --from <url>` CLONES an existing catalog → pull → apply | `addRemote`, `pull` | **Build the clone-from-remote path — the biggest functional hole** (the "New Machine" value prop has no command today). Do NOT wire `am pair` key-handoff into v1 (age path fenced) |
| **8. Apply with dry-run + drift safety** | `clack.spinner`; dry-run preview per-adapter; on confirm, live `applyResolved`; refuse drifted overwrite without `--force` (already enforced); rely on existing backup infra. End on green `am doctor` | `applyResolved`, ADR-0038, doctor | The destructive step — preview-then-confirm + drift refusal + backups make first-run safe |
| **Cross-cutting** | `--yes` / `--non-interactive` / `--json` / `--steps include/exclude` parity | global `--json`, `install --yes`, `apply --dry-run` | CI/dotfile/scripted onboarding parity. Cheap — primitives exist |

**Prerequisites before the wizard can feel trustworthy:** fix the raw-ZodError UX (core
P1-A, ~20 LOC), the default-passthrough warning (core W4), and the install honesty (§5
P0-1) — otherwise the wizard prints commands that install the wrong software or
dead-ends a first-time user on a JSON blob.

---

## 5. Production-Readiness Blockers

Effort key: **S** ≤1 day · **M** 2–4 days · **L** ~1 week · **XL** >1 week.

### P0 — Hard blockers (must fix before any v1.0 download)

| ID | Blocker | Evidence | Fix | Effort |
|----|---------|----------|-----|--------|
| **P0-1** | **Install dishonesty.** `npm install -g agent-manager` installs an unrelated **deprecated** stranger package (owned by `glivas`, renamed to `flaio-cli`); publish would 403. `brew tap Codeseys-Labs/am` targets a `homebrew-am` repo the pipeline never creates. (`curl\|sh` DOES work — corrected, §3.) | dist report; `cli.ts:11` tagline; live `npm view` | Pull npm+brew from README install section; replace with `curl\|sh` + from-source + "npm/brew coming at v1.0" caveat. Until owned name published, **`curl\|sh` is the ONLY install command docs/wizard may print** | **S** |
| **P0-2** | **First-run wizard is fiction.** README dramatizes detect→import→merge→secret-scan; real `am init` prints `Run am import auto` (`init.ts:157`). No clone-from-remote path. | onboarding + vision + ship-it lenses | Build `am setup` (§4.3) OR rewrite Quick Start to the real two-step flow. All primitives exist — orchestration, not new capability | **L** |
| **P0-3** | **Age-secrets path silently corrupts data.** `am secrets migrate --to age` then `am apply` writes `enc:v2:age:` ciphertext verbatim into `~/.claude.json`, reports success, breaks every MCP server. **Verified:** `controller.ts:228` → `interpolateEnvAsync` decrypt walk (`secrets.ts:305`) gates on `isEncrypted` (v1-only); `isAnyEnvelope` (matches v2, `secrets.ts:529`) exists but is unused here. | secrets report; source reproduction | **Fence for v1:** default wizard/docs to legacy AES; gate `am secrets`/`am pair`/`migrate --to age` as experimental (or refuse with explicit "not yet supported in apply"); downgrade ADR-0042/0047/0050/0051 age-runtime claims to proposed. (Proper fix — route apply through `getDefaultBackend` + `isAnyEnvelope`, add encrypt→apply→decrypt integration test — is post-v1) | **M** |
| **P0-4** | **Doc surface contradicts the code.** Wrong test badge (2,906 vs true **3,064**); 4 contradictory stat tables; CLAUDE.md still lists Marketplace as a live core pillar (tells session agents to build a dead feature); two competing taglines. | quality + vision lenses | Remove fictional README transcript; generate stats from a CI script; fix badge to 3,064; pick ONE tagline; set CLAUDE.md pillar 4 to retired | **M** |

### P1 — Strong (fix before v1.0 or ship with explicit caveats)

| ID | Issue | Evidence | Fix | Effort |
|----|-------|----------|-----|--------|
| **P1-A** | Malformed config dumps a raw ZodError JSON issue-array to a first-time user | `config.ts:47`; `errors.ts` no ZodError branch | Add ZodError branch to `formatError` → human path like `servers.foo.command: Required` | **S** |
| **P1-B** | `am apply` mutates global home-dir configs for every detected tool with no per-target confirmation; detection over-reports (pure file-presence) | adapter report (cursor/windsurf export) | Wizard per-target opt-in (§4.3 step 2); distinguish "dir exists" from "tool present" | **M** |
| **P1-C** | Committed meta-tooling: 39 `.seeds`/`.mulch`/`.canopy`/`.overstory` files (verified) violate standing rule; repo reads as a scratchpad | `git ls-files` = 39 | `git rm -r --cached`; add to `.gitignore` + `.npmignore`; remove `TMP-PROMPT.md` | **S** |
| **P1-D** | Marketplace dead pillar still registered (`cli.ts:59`) + in root tagline (`cli.ts:11`) + docs, despite ADR-0039/0052 | vision + quality | Execute ADR-0052 deletion (1,875 LOC); drop from `cli.ts`/`help.ts`/tagline | **M** |
| **P1-E** | Windows binary built but `continue-on-error` in CI; never exercised end-to-end | dist report (ci.yml) | Add Windows smoke leg (`version`/`init --yes`/`list`) OR label experimental in README | **M** |
| **P1-F** | `curl\|sh` integrity fail-open branches (unsigned manifest, skip-if-no-sha-tool, missing-artifact installs unverified) vs README "checksums verified" claim | dist report (install.sh) | Sign `checksums.sha256` (cosign/minisign); make no-tool/missing-artifact branches fail-closed or require `--insecure` | **M** |
| **P1-G** | `am --help` omits real commands (`pair`, `secrets`, `mcp-superset`); ADR-0029 coverage test does not catch it | onboarding (help.ts vs cli.ts) | Add to `COMMAND_GROUPS`; fix coverage test to assert every non-alias subcommand appears. (For fenced commands, hide rather than list) | **S** |
| **P1-H** | Default-profile passthrough: absent/empty `default` profile exports the ENTIRE catalog to every tool, unsignposted | `controller.ts:221`; `config.ts:289` | Wizard creates explicit default profile (§4.3 step 5); warn on apply "applying all N servers to M tools" | **S** |

### P2 — Maintainability / trust on close inspection (post-v1 acceptable)

| ID | Issue | Fix | Effort |
|----|-------|-----|--------|
| **P2-A** | Core↔adapters bidirectional type cycle (`config.ts:6-12` imports `ResolvedConfig` from downstream adapters) | Move `ResolvedConfig`/`Resolved*` into `src/core`; ~6 import edits | **S** |
| **P2-B** | Half-wired shared instruction generators (4 exported, unit-tested, called by nobody; cursor/windsurf/copilot/kiro reimplement inline) | Wire adapters to shared generators OR delete dead exports | **M** |
| **P2-C** | Every adapter rolls its own `generateMcp*` + identical file-write loop | Add `shared/export-utils.ts` (`buildMcpServersJson`, `writeExportFiles`) | **M** |
| **P2-D** | Instruction-drift diff wired in only 3 of 13 adapters → `apply --diff` falsely reports in-sync after hand-edit | Finish drift diff across all adapters OR downgrade the drift-gate promise | **M** |
| **P2-E** | Adapter authoring docs (CLAUDE.md:288, adapter-development-guide) reference a `schema.ts` deleted per ADR-0041 (exists in zero adapters) | Rewrite to the real 5-file shape; delete every `schema.ts` mention | **S** |
| **P2-F** | ADR index untrustworthy: plan-only ADRs (0045/0048/0049/0050) marked `accepted` with zero code (no codemirror/monaco in src) | Re-status to `proposed`; separate decision-ADRs from plan-ADRs in the index | **S** |
| **P2-G** | Binary-hostile Flows engine (`flow.ts:50` runtime TS import); `am_flow_run` MCP tool absent | Move flows to declarative TOML/JSON OR mark experimental + gate | **M** |
| **P2-H** | `betterleaks` binary downloaded + chmod+exec with no checksum/signature | Ship pinned per-platform SHA-256; verify before exec | **S** |
| **P2-I** | `__resetControllerLocksForTests` is a no-op; `SettingsSchema.passthrough()` silently preserves typos (contradicts ADR-0007 warn) | Implement or delete the hook; make SettingsSchema strict or add warn pass | **S** |
| **P2-J** | 5 deprecated MCP tool aliases target removal at `v0.4` (already shipped); nag every run | Bump removal target to v0.6/v1.0 or delete now | **S** |
| **P2-K** | Surface too large for a small team (6 wire roles, 38 tools, variants, metadata); in-memory session tracking lost on restart despite ADR-0026 claims | Declare a tight supported core; quarantine bridge/A2A-server/flows as experimental; persist or downscope session claim | **M** |

---

## 6. Recommended Roadmap to v1.0 (Sequenced Waves)

**Total to v1.0 GO: ~1–2 weeks of focused work.** No architectural change.

### Wave 0 — Honesty & hygiene (1–2 days) — *unblocks trust*

- **P0-1** Fix install honesty: README install section → `curl\|sh` + from-source only; "npm/brew at v1.0" caveat. (Decide owned scoped name `@codeseys-labs/agent-manager` in parallel for later.)
- **P0-4** + **P1-C** + **P1-D**: remove fictional README transcript; CI-generated stat table (badge → 3,064); pick ONE tagline repo-wide; set CLAUDE.md pillar 4 retired; `git rm --cached` the 39 meta-tooling files + `.gitignore`; execute ADR-0052 (delete marketplace) and drop it from `cli.ts`/`help.ts`/tagline.
- **P2-F** re-status plan-ADRs to `proposed`.

*Exit:* a freshly cloned repo reads as a product; every documented number is true; no dead pillar in the CLI surface.

### Wave 1 — Fence the dangerous & out-of-scope (2–4 days) — *unblocks safety*

- **P0-3** Fence age secrets: default everything to legacy AES; gate `am secrets`/`am pair`/`migrate --to age` as experimental (hidden from help + wizard); downgrade ADR-0042/0047/0050/0051 age-runtime to proposed.
- **P1-G** Reconcile `am --help` with `cli.ts` (list real commands, hide fenced ones; fix coverage test).
- **P2-K** Declare the tight v1 supported core (pillars 1+2); fence ACP/A2A/flows/variants/wiki/hosted-UI as experimental; **P2-G** mark Flows experimental.

*Exit:* the v1 supported surface is exactly pillars 1+2; no documented path corrupts data.

### Wave 2 — Make first-contact trustworthy (1–2 days) — *wizard prerequisites*

- **P1-A** ZodError → human error branch.
- **P1-H** + **P1-B** default-passthrough warning + per-target apply opt-in foundation.
- **P2-E** fix adapter authoring docs (so wizard copy isn't derived from wrong docs).

### Wave 3 — Build `am setup` (~1 week) — *the v1 centerpiece (P0-2)*

- Implement the §4.3 wizard end-to-end on existing primitives: idempotency probe →
  init → detect+multiselect → **run** import-auto → AES key → profile → optional
  registry → optional remote / `--from` clone → dry-run-then-apply → green `am doctor`.
- Full `--yes`/`--non-interactive`/`--json`/`--dry-run` parity.
- Build the **clone-from-remote** path (biggest functional hole).
- Command-level tests driving `setupCommand.run()` with clack mocked (current onboarding is effectively untested).

### Wave 4 — Distribution hardening (parallel with Wave 3, 2–4 days)

- **P1-E** Windows smoke leg or experimental label.
- **P1-F** sign checksums; fail-closed integrity branches; anchored grep in `install.sh`.
- Reconcile `package.json` `files`/`.npmignore`; decide npm strategy (per-platform binary packages vs build dist before publish) — gate behind owned package name.

### Wave 5 — v1.0 GO gate

Ship when: install commands install *this* software; `am setup` delivers detect→import→apply
in one guided flow ending on green doctor; no documented path corrupts data; docs match code.

### Post-v1 backlog (P2 maintainability)

P2-A (type cycle), P2-B/C (shared adapter layer), P2-D (drift diff), proper age-runtime
wiring + integration test, P2-H/I/J cleanups, then revisit pillars 3/5/6 as deliberate,
pillar-gated v1.x features.

---

## 7. What to KEEP, what to CUT/DEFER, what to FIX

### KEEP (the architecture is right — do not touch)

- **The layered core kernel** — `config`/`resolver`/`controller`/`locks` (~1,210 LOC), pure, tested, concurrency-safe (ADR-0040 `withConfig`+`AsyncMutex` and ADR-0041 schema-field deletion both verified implemented, code matches ADRs).
- **The adapter model** — clean serializable `detect/import/export/diff` interface, 13 IDE + 3 platform adapters, lazy factory registry, hardened community subprocess (checksum TOFU, tamper detection, `--ignore-scripts`).
- **The MCP gateway (pillar 2)** — 38 tools, 3 tiers, bearer auth, Zod validation, secret redaction; the most production-grade subsystem.
- **The legacy AES-256-GCM secrets path** — correct crypto, good key hygiene, working `apply` round-trip.
- **The `curl\|sh` installer + single-binary build** — checksum-verified, dual-binary, macOS ad-hoc signing, CI version-drift gate, real Linux e2e test.
- **The wizard primitives** — `getDetectedAdapters`, `import auto`, `applyResolved`, ADR-0038 dry-run envelope, `am doctor`, `am install`'s clack pattern. They just need composing.

### CUT / DEFER (keep the code, fence the surface — out of v1 supported scope)

- **CUT now:** Marketplace (execute ADR-0052 deletion, 1,875 LOC) — drop from CLI, help, tagline.
- **DEFER (fence as experimental, hide from help + wizard):** ACP/A2A protocol router (pillar 3), Flows engine, agent variants, LLM-wiki (pillar 5), hosted-UI auth + CodeMirror editor, **and the entire age secrets / `am pair` / `am secrets` product line** until its apply-path runtime is wired and integration-tested.
- **DEFER framing:** "control plane for AI agents" → move to a Vision/v2 section. For v1.0 lead with what is true today: **"one catalog, every AI tool, git-synced — plus a hardened MCP gateway."**

### FIX (bounded, no rearchitecture)

- **P0:** install honesty, the fictional wizard (build `am setup`), the age-secrets footgun (fence), doc/stat drift.
- **P1:** ZodError UX, per-target apply opt-in, committed meta-tooling, marketplace deletion, Windows posture, installer integrity, help-coverage, default-passthrough warning.
- **P2 (post-v1):** core↔adapters type cycle, half-wired shared adapter layer, partial drift diff, ADR-index re-statusing, betterleaks checksum, schema-strictness, dead test hook, stale aliases, Flows runtime, proper age-runtime wiring.

---

### Bottom line

agent-manager does not need to be rearchitected. It needs to **stop expanding, finish the
front door, and tell the truth about itself.** The excellent two-pillar product already
exists in the repository — the work to v1.0 is narrowing the advertised surface to it,
building the orchestration wizard the README already promises (every primitive is in
place), fencing the data-corrupting and out-of-scope subsystems, and reconciling the docs.
One to two focused weeks. **`narrow-then-ship`.**
