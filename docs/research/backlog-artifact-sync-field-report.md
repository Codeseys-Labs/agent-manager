# Field report: an ad-hoc upload server, and why it is exactly the problem `am` exists to solve

**Status:** research / field report → requirements
**Date:** 2026-06-13
**Scope:** A real cross-machine transfer of Claude Code artifacts (skills, agents,
commands, settings) was done *without* agent-manager, using a hand-built HTTP
upload server. Every failure mode that detour hit is a capability `am` already
claims (Pillar 1 catalog + git sync, Pillar 4 git-vendored bundles, the
path-independent apply layer). This document records what was built, what broke,
and turns each break into a concrete requirement so the workaround is never the
path of least resistance again.

This is the inverse of a design doc: it is a **negative result**. It documents the
cost of *not* using the product, captured while the bruises were fresh.

---

## 1. What was built (the workaround)

On a Windows/WSL2 box, to receive Claude Code artifacts from another machine, a
single-file Python HTTP server was stood up:

- **v1** — bound `127.0.0.1:8765`, accepted a `.zip`, auto-installed any
  `SKILL.md` folder into `~/.claude/skills/`. Localhost only.
- **LAN exposure** — rebound to `0.0.0.0:8765`, then required a Windows-side
  `netsh interface portproxy` rule (`0.0.0.0:8765 → <wsl2-ip>:8765`) **plus** a
  `New-NetFirewallRule` inbound allow, because the WSL2 VM sits behind Windows
  NAT and binding `0.0.0.0` inside the VM is not sufficient for LAN reach.
- **v2 (the telling pivot)** — rewritten from an *auto-installer* into a thin
  *stager*: it only unpacks the zip into a timestamped staging dir and writes a
  manifest. A human/agent then reads each file and places it by judgment. A
  `GET /api` JSON endpoint documented the contract; zip-slip and absolute-path
  entries were rejected at extraction.

The pivot from "auto-install" to "stage, then a judgment layer installs" is the
whole story: **the moment the transfer had to be correct, it stopped being a file
copy and became a classification + placement + reconciliation problem.** That
problem is `am`'s entire job.

---

## 2. What broke — and the `am` capability each break maps to

| # | What went wrong in the workaround | Root cause | The `am` capability that prevents it |
|---|---|---|---|
| 1 | A `hyperresearch` agent bundle packaged on macOS hardcoded `/Users/baladita/.local/share/uv/tools/hyperresearch/bin/…` in 9 agent prompts. Installing it on the Linux box would have pointed every tool call at a path that does not exist. | **Absolute host paths baked into artifact content.** The artifact is not portable across machines or even across users. | **Catalog defines once; `apply` renders per-machine.** A path/binary location belongs in resolved-at-apply config, not frozen into the artifact body. `am`'s whole "define once in TOML, generate native config per tool/host" premise is the fix. |
| 2 | The June-12 `hyperresearch` bundle shipped **17 skills but 0 agents**. The skills' `Task(...)` calls reference subagents (`hyperresearch-fetcher`, `-loci-analyst`, …) that were absent — so the bundle was **non-functional on a fresh box**. The fix-up bundle later added the 14 agents. | **No dependency closure.** A "bundle" was an arbitrary zip with no notion of "this skill requires these agents." | **Entity-typed catalog + bundle vendoring (Pillar 4).** Skills, agents, instructions are first-class entity types; a vendored bundle should carry its dependency set, and `am status` should flag a skill whose referenced agent is missing. |
| 3 | Telling **agent vs command** from a lone `.md` required a brittle heuristic (folder name? `tools:` key? `argument-hint:`?). The workaround punted entirely — it staged files and made a human classify each. | **No schema / type identity for artifacts.** A `.md` is structurally ambiguous between two entity types. | **Discriminated entity schemas.** `am` already models entity types explicitly (cf. ADR-0057 `ServerSchema` discriminated union) — type is declared, not guessed. |
| 4 | Installing a settings fragment meant **merging JSON into a live `~/.claude/settings.json` that held real credentials, 30 plugin toggles, and model routing.** A blind deep-merge could corrupt the whole config. The workaround refused to auto-merge and made a human review a diff. | **No safe, idempotent, reversible apply.** Hand-merging live config is the exact hazard. | **`am apply` + drift detection + import/merge.** Catalog→native rendering is idempotent and reviewable; `am status` shows divergence; secrets are enveloped at rest, not pasted as plaintext into config. |
| 5 | "Did this upload actually change anything?" took manual `md5`/`diff` across three zips, and the first answer was **wrong** (compared against the wrong baseline — installed-now vs last-backup). | **No content-addressed source of truth or version identity.** The diff baseline was ambiguous because there was no canonical "current". | **Git-backed catalog is the baseline.** Versioned history (the tiered skill literally carried `version: 1.6.0`) makes "what changed since" a `git diff`, not a forensic `md5` hunt. |
| 6 | LAN exposure required two out-of-band, machine-specific, **non-version-controlled** steps (`netsh portproxy` + firewall rule), and the WSL2 IP rotates on reboot, silently breaking the forward. | **Transport was bespoke and stateful**, living outside any catalog. | **Git as the transport.** `am`'s sync model moves artifacts over a git backend the user already trusts — no ad-hoc listening socket, no NAT/firewall choreography, no reboot-fragile forward. |
| 7 | Secret exposure risk: the live `settings.json` inspected mid-transfer contained a **plaintext Bedrock bearer token**. Any "just zip up my config and send it" flow would have shipped that credential in the clear. | **Secrets co-mingled with config, unprotected.** | **Secret hygiene (Pillar 1):** AES-256-GCM / age envelopes at rest, 40+ provider-pattern detection on import, fail-closed when a value can't be obfuscated. A credential never travels as plaintext in the catalog. |

---

## 3. The distilled lesson

**A cross-machine artifact transfer is not a file copy. It is five problems
wearing a trench coat:**

1. **Identity** — what *type* is each artifact? (skill / agent / command / settings)
2. **Dependency closure** — what else must travel with it to function?
3. **Portability** — strip host-absolute paths; resolve them per-machine at apply.
4. **Safe apply** — idempotent, reviewable, reversible; never blind-merge live config.
5. **Provenance** — a canonical, versioned baseline so "what changed" is answerable.

The workaround solved #1 and #4 by **inserting a human judgment step** (stage,
then a person reads and places each file). That is a fine fallback for a one-off,
but it does not scale, is not reproducible, and is precisely the manual toil
agent-manager is meant to retire. `am` solves all five structurally: typed
catalog (#1), entity-typed bundles (#2), define-once/apply-per-host (#3),
`apply`+drift+envelopes (#4), git-backed history (#5).

---

## 4. Concrete requirements this surfaces for `am`

Ordered by how directly the field report justifies them. None of these assert the
feature is missing — several may already exist; the report is the *evidence* that
they are load-bearing, and the acceptance test each one must pass.

1. **Portability lint on import/vendor (maps to break #1).**
   When `am import`/vendor ingests a skill or agent, detect host-absolute paths
   (`/Users/<name>/…`, `/home/<name>/…`, `C:\Users\…`) embedded in artifact bodies
   and flag/parameterize them. *Acceptance:* importing the macOS hyperresearch
   bundle on Linux raises a portability finding instead of silently vendoring a
   broken `/Users/baladita/` path.

2. **Bundle dependency closure (maps to break #2).**
   A vendored skill bundle should declare/validate the agents (and other entities)
   it references. `am status` flags a skill whose referenced subagent is absent.
   *Acceptance:* vendoring the 17-skill/0-agent June-12 bundle reports "skill X
   references missing agent hyperresearch-fetcher" rather than installing a
   non-functional set.

3. **Artifact type identity, never guessed (maps to break #3).**
   Lean on the discriminated-schema approach (ADR-0057) so a vendored `.md`'s
   entity type is declared, not inferred from folder name or frontmatter keys.
   *Acceptance:* an agent and a command with identical frontmatter shape are
   classified deterministically.

4. **A documented "receive artifacts from another machine" path (maps to breaks
   #5, #6).** The user's mental model was "I need a server to upload to." The
   product answer is "push to the git backend on machine A, pull/apply on machine
   B." This needs to be discoverable enough that an upload server never looks
   easier. *Acceptance:* the README/onboarding answers "how do I move my skills to
   another box?" in one obvious place.

5. **Reinforce: never transport plaintext secrets (maps to break #7).**
   Already covered by Pillar 1 envelopes + fail-closed ingest; this report is
   additional field evidence for keeping that gate strict. *Acceptance:* no flow,
   including bundle vendoring, ever serializes a decrypted credential into a
   shipped artifact.

---

## 4b. Audit verdict — do the acceptance tests pass today? (2026-06-13)

Each requirement above was checked against the **current code**, by running the
acceptance test in a sandbox (real CLI, `AM_CONFIG_DIR` redirected) and by
tracing the code path. Every FAIL/PARTIAL was then adversarially re-checked by
a second reviewer instructed to *refute* it. **None were refuted.**

| Req | Capability | Verdict | One-line reality |
|---|---|---|---|
| 1 | Portability lint on import/vendor | **FAIL** | No code scans artifact *bodies* for host-absolute paths; macOS bundle vendors silently broken on Linux. (seed `98d1`) |
| 2 | Bundle dependency closure | **FAIL** | Nothing parses skill `Task(subagent_type=…)` refs; `SkillSchema` has no deps field; `am status` never flags a skill whose agent is absent. (seed `7b65`) |
| 3 | Type identity, never guessed | **PARTIAL** | `z.discriminatedUnion` exists but is **server-only** (ADR-0057); `command` is not a modeled entity; `am add` takes the kind as a positional arg, not a declared in-file discriminant. (seed `cc7d`, ADR-0058 proposed) |
| 4 | Documented working cross-machine path | **PARTIAL** | `am setup --from [--ssh]` works end-to-end, but README twice claims `am pull` auto-applies (lines 382, 762) when `pull.ts:40` only prints a hint; `git+` skill source is an unconditional stub. (seed `484e`; overlaps `9497`/`e5c8`) |
| 5 | Never transport plaintext secrets | **FAIL** | Reproduced end-to-end: `FOO_KEY` / `AWS_BEARER_TOKEN_BEDROCK` stored as plaintext, **committed to git**, and `am secret scan` reports clean even with betterleaks active. Detection is key-NAME-only; no generic `*_KEY`/`*_TOKEN` suffix or entropy fallback. (open High bug `257c`) |

**Bottom line:** the field report's thesis holds. `am`'s *architecture* maps to
all five problems, but three capabilities (portability lint, dependency
closure, generic-secret detection) are **absent in code**, and two
(discriminated artifact identity, cross-machine docs) are partial. The
workaround was easier precisely because these gaps are real today.

Audit method + full evidence: 5 parallel investigators + adversarial
verification pass, 2026-06-13. R5 is the most urgent (security: plaintext
credential committed to git with a false "clean" scan).

## 5. Disposition of the workaround

The upload server, its `claude-uploader` skill, and the Windows port-forward
scripts live outside this repo (on the operator's machine) and were torn down
after use (server stopped, `netsh portproxy` + firewall rule removed). They are
**not** proposed for inclusion here — they are the anti-pattern this document
exists to retire. If a transient "receive on a fresh box that has no git backend
configured yet" bootstrap is ever wanted, it belongs behind `am` as a deliberate
feature with the five problems above solved, not as a standalone socket that
hand-copies files into `~/.claude/`.

---

## 6. Provenance

- Real transfer, 2026-06-13: three bundles (`deep-work-loop`,
  `deep-work-loop-tiered` v1.6.0, `hyperresearch-family`) moved WSL2 ↔ another
  machine via the ad-hoc server described in §1.
- Break #1 evidence: 9 of 14 `hyperresearch` agents differed from the installed
  copies *only* by `/Users/baladita/` vs `/home/<user>/` in a hardcoded binary
  path (verified by normalizing the home path and re-diffing to an empty delta).
- Break #2 evidence: the prior bundle carried 17 `SKILL.md` files and zero agent
  files; the corrected bundle added the 14 pipeline subagents the skills invoke.
- Related prior art in this repo: `docs/research/2026-05-03-config-backup-patterns.md`,
  `docs/research/windows-xplat-hardening-plan.md` (WSL2/Windows path + xplat
  concerns), ADR-0057 (discriminated entity schema), ADR-0055 (runtime access
  scoping).
