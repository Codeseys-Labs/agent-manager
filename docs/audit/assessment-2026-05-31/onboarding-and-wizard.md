# Audit: Onboarding & First-Run Wizard

**Dimension:** onboarding-and-wizard
**Date:** 2026-05-31
**Auditor question:** *Is this project architected to become a production-ready, downloadable CLI with a first-run setup wizard that helps a new user configure everything needed to get value from the tool?*

**Verdict:** The building blocks exist, but there is **no wizard** — and `am init` today is a thin 3-step stub that diverges sharply from what the README promises. A stranger who installs `am` and runs `am init` does not reach "value" without reading source or docs. The honest answer to the overarching question is: **the core engine is wizard-ready; the onboarding surface is not built.** Recommend `refactor-in-place` (the pieces a wizard would orchestrate already exist as callable functions; what's missing is the orchestration + a TTY-driven flow).

---

## 1. The intended happy path vs. what actually ships

The brief asks to map: install → init → detect tools → import existing configs → set up secrets/encryption → configure git remote → add MCP servers → create profiles → apply.

Here is each stage, graded against the real code.

| Stage | Intended | What `am` actually does | Grade |
|-------|----------|--------------------------|-------|
| **install** | `curl …/install.sh \| sh` | **`install.sh` does not exist.** README:110 + README:998 publish a live one-liner pointing at a missing file. | **Broken** |
| **init** | guided setup | `am init` = mkdir + git init + write 5-line config.toml + 2 yes/no prompts. `src/commands/init.ts:55-181` | **Stub** |
| **detect tools** | list + offer import | Detects (`getDetectedAdapters`, init.ts:108) and *prints names*. Does **not** offer to import. init.ts:155-157 | **Partial** |
| **import existing** | "Import all? [Y/n]" (README:133) | **Not wired into init at all.** User must separately run `am import auto`. init.ts only prints a hint. | **Missing** |
| **secrets/encryption** | choose backend, set up | Offers legacy AES key only (init.ts:113-125). Knows nothing about the age backend / recipients / `am pair`. | **Stale** |
| **git remote** | configure | One free-text `clack.text` prompt (init.ts:130-151). No platform auth, no validation, no test for a new-machine *clone*. | **Thin** |
| **add MCP servers** | add first server | Not part of init. Separate `am add` / `am install`. | N/A in init |
| **create profiles** | "Created profile default" | Hard-codes a single `default` profile (init.ts:84-88). No prompt, no multi-profile help. | **Stub** |
| **apply** | generate native configs | Separate `am apply`. init never calls it or suggests a complete next sequence. | N/A in init |

### What `am init` literally does (src/commands/init.ts)

1. `--project` short-circuit → delegates to `initProject` (init.ts:36-41).
2. `mkdir` config dir, `withConfig` lock, bail if already initialized (init.ts:53-105).
3. `initRepo` + write a fixed minimal `Config` (init.ts:79-101).
4. **Prompt 1** (TTY only): "Generate an encryption key for secrets?" → `generateKey`/`saveKey` (init.ts:113-125).
5. **Prompt 2** (TTY only): "Git remote URL for sync (leave empty to skip):" → `addRemote` (init.ts:129-152).
6. Print detected tool names + a static hint to run `am import auto` (init.ts:154-166).

That is the **entire** first-run experience. Two confirm/text prompts. It is not a wizard; it is `git init` with two questions bolted on.

---

## 2. README promises a wizard that does not exist (doc drift, embarrassing to a first user)

README "Quick Start → First-Time Setup" (README.md:127-138):

```
am init
#   Detected: Claude Code (15 servers), Cursor (8 servers), Kiro (5 servers)
#   Import all? [Y/n] y
#   Merged 22 unique servers (6 duplicates resolved)
#   3 potential secrets detected -- run `am secret scan` to review
#   Created profile "default"
```

**None of this happens.** The real `am init`:
- never prints per-tool server counts (init.ts:108-109 only collects `displayName`s),
- never prompts "Import all?" — there is no import call in init.ts,
- never merges servers, never reports duplicates,
- never scans for secrets during init.

A first-time user who copies the README expects a brownfield-import wizard and gets a bare repo plus a hint. This is the single most damaging onboarding defect: **the marketing surface describes a product that the code does not implement.**

The "New Machine" flow is also wrong (README.md:153-157):

```
am init     # setup + pull from remote
am apply    # instant parity
```

`am init` does **not** pull from a remote. On a machine that already has a config dir it bails with "Already initialized" (init.ts:58-66). There is **no clone-from-remote path** anywhere — `am pull` requires an already-initialized repo with a remote (`src/commands/pull.ts:18-37`). The advertised "instant parity on a new machine" requires the user to manually `git clone` into `~/.config/agent-manager` first, which is documented nowhere in the Quick Start.

---

## 3. The secrets onboarding is two generations behind the architecture

This is the most consequential design gap. The repo has **four ADRs** describing a modern secrets story:

- ADR-0042: age envelope + Argon2id passphrase + OS keychain cache (`accepted`, amended_by 0047/0050/0051).
- ADR-0046: reject `team_passphrase`; force per-recipient identities.
- ADR-0047: `am pair` cross-device key handoff.
- ADR-0051: rotation + grace period (`am secrets rotate/rewrap/revoke`).

The implementation exists: `src/core/secrets-age.ts` (a full `age` backend, multi-recipient, secrets-age.ts:376-1173), `src/commands/secrets.ts` (`migrate/rewrap/rotate/revoke`), `src/commands/pair.ts` (`am pair add`).

**But `am init` is wired to the legacy ADR-0012 scheme only.** init.ts:10 imports `generateKey, saveKey` from the AES path; init.ts:119 calls `generateKey()` (AES-256-GCM, `enc:v1:`, secrets.ts:116-185). The default backend resolver returns `aes-gcm-legacy` whenever nothing is configured (`selectBackendName`, secrets.ts:415-426). So **every new user gets the legacy single-key backend by default**, with no prompt offering the age backend, no recipient setup, no `am pair` handoff suggestion, no mention that a team setup needs per-recipient identities (the entire point of ADR-0046).

Consequences for a wizard:
- A first-run wizard *must* ask "solo machine, multi-machine (you), or team?" and branch: solo→legacy or age-single-recipient; multi-machine→age + `am pair`; team→age + add-recipient. None of that decision tree exists.
- `doctor.ts:275-301` will actively *fail* a config that uses the `team_passphrase` anti-pattern and tell the user to run `am secrets add-recipient` / `am secrets rewrap` — i.e., doctor knows about the new world that init refuses to set up. The two commands disagree about which decade we're in.

---

## 4. Help output omits the secrets/pairing surface entirely (discovery dead end)

`am --help` renders `COMMAND_GROUPS` from `src/help.ts`. Cross-referencing the registered subcommands in `src/cli.ts:24-61` against the groups:

**Registered but absent from `am --help`:** `pair`, `secrets`, `mcp-superset` (plus intentional aliases `acp`, `agents`).

So a new user who runs `am --help` to discover how to set up secrets-for-a-team or move a key to a second machine sees **only** `secret` (singular, legacy) and never learns `am secrets` or `am pair` exist. ADR-0029:67-69 claims a test "validates that every registered subcommand … appears in exactly one group, catching omissions." That test is either not asserting this or is stale — three real commands slipped through. This is doc/code drift inside the help system itself.

---

## 5. Where the cliffs and dead ends are (concrete)

1. **Dead install link.** README:110 curl one-liner → 404. CHANGELOG.md:264 and ROADMAP.md:157 both claim `install.sh` is "Done." It is not in `scripts/` (only `build.ts`, `bump-version.sh`). First contact with the project is a broken command. **Critical.**

2. **`am init` non-TTY non-JSON limbo.** Both prompts are gated on `!args.json && !args.quiet && process.stdin.isTTY` (init.ts:113, 129). In a non-TTY without `--json` (CI, piped, Docker `RUN`), `am init` silently creates a repo with **no key and no remote** and prints nothing structured. There is no `--yes`/`--remote`/`--no-key` flag to drive init non-interactively (contrast `am install`'s `--yes`). A scripted onboarding can't configure anything.

3. **Init → value gap.** After `am init` the user is told to run `am import auto` (init.ts:157) *or*, if nothing detected, three other commands (init.ts:162-165). But there is no single "here's your next command" or a `--apply` step. The user must independently know the sequence init→import→(secret)→apply→push. Nothing chains it.

4. **No clone/new-machine path.** §2 above. The advertised cross-machine value proposition has no first-run command.

5. **`am init --project` is silent on next steps when something is found.** initProject prints what it imported and the file path (init-project.ts:107-112) but never tells the user to `am apply` or that this project config layers under the global one. Compare `am add skill`, which does say "Run `am apply`" (add.ts:494).

6. **Encryption-key prompt offers no key escrow guidance.** init.ts:122 saves the key and prints its path, but unlike the encryption-lifecycle doc (cli-lifecycle.md:349-351 "Save this key: AGx8f2…"), the real flow never *shows* the base64 key for the user to stash in a password manager. On the legacy backend, losing `key.txt` = losing all secrets, and init does nothing to prevent that.

---

## 6. `doctor` is the one bright spot — and a wizard's natural backbone

`src/commands/doctor.ts` is genuinely good first-run diagnostics: 11 grouped checks (config dir, git repo, config validity with Zod issue rendering, per-adapter detection, remote + ahead/behind, key present, **legacy key-in-git-dir warning** doctor.ts:174-186, project config, managed/enterprise configs, `team_passphrase` anti-pattern doctor.ts:219-301, unencrypted-secret audit, betterleaks, apply backups). It emits `--json` and sets exit code on failure (doctor.ts:387-405).

This is exactly the inventory a wizard needs. **A best-in-class `am setup` would essentially run `doctor`'s checks, then for each `warn`/`fail` offer the remediation interactively** — which is the gh-CLI / `aws configure` pattern. Doctor already *names* the fix in each message (e.g., "run `am secret install-scanner`", "run `am secrets add-recipient`"). The remediation prompts simply aren't wired.

**Weakness:** doctor is read-only and the remediations are strings, not callable actions. There's no shared `Check { fix?: () => Promise<void> }` shape, so a wizard can't iterate checks and apply fixes generically.

---

## 7. Building blocks a wizard could call (good news)

The orchestration is missing, but nearly every *step* exists as a function:

| Wizard step | Existing building block |
|-------------|--------------------------|
| Detect tools | `getDetectedAdapters()` — adapters/registry, used at init.ts:108 |
| Brownfield import w/ dedup + secret auto-encrypt | `am import auto` engine in `src/commands/import.ts:104-378` (runMergePipeline, scanConfigForSecrets, auto-encrypt) |
| Project scan | `initProject()` — init-project.ts:29-131 |
| Legacy key gen | `generateKey/saveKey/importKey/loadKey` — core/secrets |
| Age backend setup | `secrets-age.ts` backend + `am secrets` verbs + `am pair add` |
| Remote setup | `addRemote(configDir, url)` — core/git, init.ts:142 |
| Health inventory | `doctor` checks — doctor.ts:55-380 |
| Apply | `applyResolved()` — core/controller, apply.ts:69 |
| Interactive env-var collection (the best wizard prototype in the repo) | `am install` — install.ts:91-147: TTY-guarded `clack.confirm`/`clack.text`, per-var validation, auto-encrypt, `--yes` non-interactive fallback |
| Profile creation | `am profile` (clack.select usage at profile.ts) |

`am install` (install.ts:108-147) is the **only** place in the codebase that resembles a multi-step interactive flow done right: it guards on `process.stdin.isTTY`, validates input, encrypts captured values, and degrades to placeholders + a `--yes` flag for non-interactive use. A wizard should be modeled on this, not on init's two ad-hoc prompts.

**Reality check on @clack usage:** only **10** interactive primitive calls exist across the *entire* codebase (init ×2, install ×2, update ×1, uninstall ×1, wiki ×1, marketplace/security ×3). The dependency is in the stack table (CLAUDE.md "interactive wizards") but the project barely uses it. There is no `clack.intro/outro/group/spinner/note` usage anywhere — i.e., none of clack's actual *wizard* affordances are used. The "interactive wizards" framing in CLAUDE.md is aspirational.

---

## 8. Test coverage of the onboarding flow is near-zero

- `test/commands/init.test.ts` has **3** tests, and none of them invoke `initCommand.run()`. They re-implement init by calling `initRepo` + `writeConfig` directly (init.test.ts:19-31) — so the actual command handler, the two clack prompts, the detect-and-hint logic, and the `withConfig`/`noCommit` interaction are **untested**.
- The interactive prompts (key gen, remote) have **no** coverage (no TTY mock, no clack mock anywhere in `test/commands/init*`).
- `test/commands/init-project.test.ts` has 8 tests (better, exercises scan/dedup), but still doesn't drive the CLI's `--project` arg path through `initCommand`.

For a flow that is the literal front door of the product, this is the thinnest-tested surface in the audit.

---

## 9. What a best-in-class `am setup` wizard must orchestrate

Given the engine that exists, the missing piece is a single guided command (call it `am setup` or fold into `am init` with a `--wizard`/interactive default). It must:

1. **Detect environment**: TTY vs not; existing config dir; existing remote; OS keychain availability.
2. **Branch on intent** (clack.select): *new solo*, *new + I have a remote to clone*, *join a team*, *adopt existing tool configs (brownfield)*.
3. **Clone-from-remote path** (the missing command): if user has a remote, `git clone` into the config dir, then jump to key bootstrap + `am apply`. This is the single biggest functional hole.
4. **Tool detection + brownfield import**: show per-tool server counts (the README already promises this), call the `am import auto` engine, surface dedup + conflicts, run the secret auto-encrypt path. All functions exist; wire them.
5. **Secrets backend choice** (the architecture-aligned step): solo→legacy or age-single; multi-machine→age + emit `am pair` instructions / QR; team→age + collect recipient pubkeys. Persist `settings.secrets.backend`. Today init hard-codes legacy.
6. **Key escrow nudge**: print the base64 key once (legacy) or the recovery phrase (age), with "save this in your password manager" — explicitly, because key loss is unrecoverable.
7. **Remote + platform auth**: validate URL, detect platform (`src/platforms/`), offer to store the key in GitHub Secrets / GitLab Variables (the platform adapters already model `storeKey`, per cli-lifecycle.md:373-375).
8. **Profile bootstrap**: offer at least work/personal beyond the hard-coded `default`.
9. **Apply + verify**: run `am apply` (or `--dry-run` first per ADR-0038) and then `am doctor`, ending on a green health check — the natural "you're done" signal.
10. **Idempotent re-entry**: re-running `setup` should resume/repair (lean on doctor's check list), not bail with "Already initialized" the way init does today (init.ts:58-66).

ADR-0038's dry-run envelope is the right preview substrate for step 9 (`am apply --dry-run` already emits `DryRunEnvelope`, apply.ts:201-226). A wizard "here's what I'll write" screen is essentially that envelope rendered.

---

## 10. Severity-ranked weaknesses

1. **CRITICAL — broken install + fictional Quick Start.** README:110 install one-liner targets a non-existent `install.sh`; README:127-157 describes an init/new-machine wizard that the code does not implement. First-run user is stranded at step 0.
2. **HIGH — no wizard; init is a 2-prompt stub.** init.ts:113-152. No brownfield import, no backend choice, no profile help, no apply chain, no clone path.
3. **HIGH — secrets onboarding stuck on legacy backend.** init.ts:10/119 use AES legacy; age backend + `am pair` + recipients (ADR-0042/0046/0047/0051) are never offered at first run; default resolves to `aes-gcm-legacy` (secrets.ts:425).
4. **HIGH — no new-machine clone path.** README advertises it; neither `am init` nor `am pull` provides it (init.ts:58-66, pull.ts:18-37).
5. **MEDIUM — help.ts omits `pair`, `secrets`, `mcp-superset`.** help.ts COMMAND_GROUPS vs cli.ts:24-61; the ADR-0029 coverage test isn't catching it.
6. **MEDIUM — init undriveable non-interactively without `--json`.** No `--yes/--remote/--no-key` flags; silent in piped/CI contexts (init.ts:113,129).
7. **MEDIUM — onboarding flow effectively untested.** init.test.ts:8-71 never calls the command handler; prompts uncovered.
8. **LOW — `am init --project` gives no "next step".** init-project.ts:107-112.
9. **LOW — clack is in the stack table but barely used (10 calls, no wizard primitives).** CLAUDE.md "interactive wizards" is aspirational.

---

## 11. Production-readiness call

For the specific bar — *a stranger installs it, runs it, gets value without reading source* — onboarding **fails today**, primarily on (1) the broken install link, (2) the README/init mismatch, and (3) no chained init→import→apply path. The encouraging finding is that this is a **wiring problem, not an architecture problem**: every step the wizard needs already exists as a tested-ish function (`getDetectedAdapters`, the `import` engine, `doctor`'s checks, `applyResolved`, the age backend, `addRemote`, `am install`'s interactive pattern). A focused `am setup` that orchestrates these, plus fixing the install script and reconciling the README, would move this dimension from "stub" to "shippable." Hence **refactor-in-place**, not rearchitect.
