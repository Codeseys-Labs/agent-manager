# Audit: Distribution & Packaging

**Dimension:** distribution-and-packaging
**Date:** 2026-05-31
**Repo:** /mnt/e/CS/github/agent-manager
**Auditor question:** Is the download/install/distribution path production-ready for a "v1.0 downloadable CLI" that a stranger can install, run, and get value from without reading the source?

**Verdict:** The plumbing exists and is unusually thoughtful (checksum verification, dual-binary install, ad-hoc macOS signing, prerelease gating, version-drift CI gate). But the *advertised* install matrix is partly broken or impossible today: `npm install -g agent-manager` installs a **stranger's deprecated package**, `brew tap Codeseys-Labs/am` points at a tap repo that the release pipeline never creates, the checked-in Homebrew formula is missing the second binary it now ships, and the Windows target is explicitly `continue-on-error` in CI (i.e., unverified). The `curl | sh` path is the only channel that is actually safe and complete today.

---

## What was read

- `scripts/build.ts` (5-target `bun build --compile`, dual entry, Silvery patch)
- `install.sh` (curl|sh installer)
- `bin/am.js`, `bin/am-acp-shell.js` (npm launcher shims)
- `.npmignore`, `package.json`
- `.github/workflows/ci.yml`, `.github/workflows/release.yml`
- `Formula/am.rb` (checked-in Homebrew formula)
- `README.md` Install section (lines 106–121, 989–999)
- `CHANGELOG.md`, `src/lib/version.ts`, `src/commands/version.ts`
- Live npm registry check of the `agent-manager` name

---

## CRITICAL findings

### C1 — `npm install -g agent-manager` installs someone else's deprecated package; the release npm-publish step will 403

The README advertises `npm install -g agent-manager` (`README.md:116`) and `release.yml:281-284` runs `bunx npm publish --access public` of `agent-manager@<version>`.

Live registry check:

```
$ npm view agent-manager version          -> 0.3.1
$ npm view agent-manager dist-tags        -> { beta: "0.2.0-beta.1", latest: "0.3.1" }
$ npm view agent-manager deprecated       -> "This package has been renamed to flaio-cli. Install with: npm install -g flaio-cli"
$ npm view agent-manager maintainers      -> glivas <georgelivas9@gmail.com>
$ npm view agent-manager repository.url   -> git+https://github.com/georgelivas/agent-manager.git
```

The npm name **`agent-manager` is owned by an unrelated maintainer** (`glivas`, repo `georgelivas/agent-manager`), is stuck at 0.3.1, and is *already deprecated and renamed to `flaio-cli`*.

Consequences:
- A first user who follows `README.md:116` gets a **stranger's deprecated, unrelated package** — an immediate trust and correctness failure.
- `release.yml`'s `npm publish` (line 282) will fail with **403 Forbidden** the moment `NPM_TOKEN` is set, because this project's account does not own the name. (This is consistent with the user-memory note that npm publish is "intentionally deferred" — but the README still tells users to use it, and the workflow still attempts it.)

This is the single biggest distribution blocker. There is no way `npm install -g agent-manager` works for this project under the current name.

**Recommendation:** Pick an owned, scoped name (e.g. `@codeseys-labs/agent-manager` or a free unscoped name), update `package.json:name`, `README.md:116`, the bin error messages (`bin/am.js:91` references `bunx agent-manager`), and remove or guard the README npm instruction until the name is secured. Verify ownership with `npm owner ls <name>` before re-enabling `release.yml:281`.

### C2 — npm package would ship `src/` with **no prebuilt binary and no bundled runtime**, contradicting its own design

`package.json:12-18` declares `files: ["src/", "bin/", "dist/", "LICENSE", "README.md"]`, but `.npmignore:5` lists `dist/`. `.npmignore` wins for the publish set. Confirmed with `npm pack --dry-run`:

```
total files: 222
top-level breakdown: { LICENSE:1, README.md:1, bin:2, package.json:1, src:217 }
dist present: False
node_modules present: False
```

So the npm tarball ships 217 TypeScript source files and the two `bin/*.js` launchers — **but zero compiled binaries**. The launcher (`bin/am.js:30-47`) first looks for `dist/am-<os>-<arch>` (never present in the tarball), then falls back to `bun run src/cli.ts` (`bin/am.js:76-87`). That fallback requires (a) Bun installed on the user's machine and (b) the dependency tree from `package.json:60-75`. npm *does* install those deps, so the source-fallback can technically run — **but only if the user has Bun**. A pure-Node user (the default npm audience) hits the "No prebuilt binary found" error at `bin/am.js:90-93`.

Net effect: the npm channel is a Bun-source-runner in disguise, not a "single binary" delivery, and the `files`/`.npmignore` contradiction means the stated intent (ship `dist/`) silently doesn't happen. The "single-binary story" (ADR-0010) is **real only for `curl | sh` and Homebrew**, not for npm.

**Recommendation:** Decide the npm strategy explicitly. Either (a) publish a thin package with `optionalDependencies` pointing at per-platform binary packages (the standard esbuild/swc pattern), or (b) build `dist/` in `release.yml` *before* publish and remove `dist/` from `.npmignore` so the binary actually ships, or (c) drop npm from the README until decided. Today the `files` array and `.npmignore` are in direct conflict (`package.json:16` vs `.npmignore:5`).

### C3 — `brew tap Codeseys-Labs/am` cannot work: no `homebrew-am` tap repo is ever created

`README.md:113` tells users `brew tap Codeseys-Labs/am && brew install am`. `brew tap Codeseys-Labs/am` resolves to the GitHub repo **`Codeseys-Labs/homebrew-am`**. But `release.yml:253-260` commits the generated formula to `Formula/am.rb` **on the `main` branch of the `agent-manager` repo itself** (`git add Formula/am.rb`, `git push origin HEAD:main`). It never pushes to a `homebrew-am` tap repo. There is no workflow, no submodule, no `homebrew-tap` job that publishes to the tap location Homebrew expects.

This exact gap is already documented internally: `docs/research/2026-05-03-E-state-audit-b.md:58` ("No for rc6 parity") and `docs/reviews/2026-04-16-multi-agent-deep-analysis/10-build-release-ci.md:401` ("Separate homebrew-tap repo … so `brew tap Codeseys-Labs/am && brew install am` works cleanly"). The fix is known but unbuilt.

**Recommendation:** Create `Codeseys-Labs/homebrew-am` and have `release.yml` push the regenerated formula there (cross-repo commit with a PAT), or change the README to `brew install --formula <raw-url>` against the in-repo formula. The current README instruction is a dead command.

### C4 — Checked-in `Formula/am.rb` installs only `am`, not `am-acp-shell` — Tier-2 shims are dead-on-arrival via Homebrew

`Formula/am.rb:29-32` installs a single binary:

```ruby
def install
  binary_name = stable.url.split("/").last
  bin.install binary_name => "am"
end
```

But `install.sh:216-217` and the *release-time* formula template (`release.yml:198-207`) both install **two** binaries (`am` + `am-acp-shell`), and the project's own docs (`README.md:991`, ADR-0033) state both are required from rc6+ or Tier-2 shims fail with `am-acp-shell: command not found`. The checked-in formula is stale relative to the template that release.yml regenerates. Anyone who installs from the current `Formula/am.rb` (e.g., the committed v0.5.0-rc6 formula) gets a half-installed tool where `am run aider` etc. break at runtime.

Also: `Formula/am.rb:2` carries the **old "chezmoi for AI agent configs" tagline** while `release.yml:155` (and `package.json:4`, CLAUDE.md) use the new "control plane for AI agents" tagline — doc/brand drift in the user-visible `brew info am` description.

**Recommendation:** The release pipeline already generates a correct two-binary formula; the checked-in `Formula/am.rb` should either be deleted (generated-only artifact) or regenerated to match the template so it never ships standalone. Fix the `desc` drift.

---

## HIGH findings

### H1 — Windows target is explicitly unverified (`continue-on-error: true`)

`ci.yml:77-80` marks the Windows build-verify matrix leg `continue_on_error: true` / `continue-on-error`. That means a broken Windows binary **does not fail CI**. The integration job (`ci.yml:114-258`) that actually exercises `init`, `import`, `add`, `status`, etc. against a compiled binary runs **Linux-only** (`bun-linux-x64`, `ci.yml:125`). So the Windows `.exe` is compiled but its behavior is never asserted end-to-end. The README and install.sh both advertise Windows (`install.sh:158-160`, `build.ts:16`), and the npm launcher maps `win32` (`bin/am.js:10`), but nothing proves `am-windows-x64.exe` runs. "Does the Windows target actually work?" — **unknown by construction.** The `am-acp-shell` Tier-2 wrapper on Windows is doubly unproven.

**Recommendation:** Remove `continue-on-error` for Windows or add a Windows leg to the `integration` job that runs at least `am version`, `am init --yes`, `am list`. Until then, label Windows "experimental" in the README rather than listing it as a first-class platform.

### H2 — macOS Gatekeeper UX is a known landmine the installer does not address

`release.yml:40-57` ad-hoc-signs darwin binaries to survive the artifact zip round-trip, and the comment (`release.yml:42-47`) candidly notes macOS 14+ arm64 will **SIGKILL on exec (exit 137)** without a valid signature, and that the user must run `xattr -dr com.apple.quarantine` or download via a tool that doesn't set the quarantine bit. `release.yml:82-92` further admits the signature can be stripped *again* on the release-runner round-trip and there is no re-sign there (TODO at `release.yml:90-92`).

Yet `install.sh` does **nothing** about quarantine: grep for `xattr|quarantine|codesign` in `install.sh` returns nothing. A user who downloads the macOS binary by any means that sets the quarantine bit, or whose ad-hoc signature was stripped, gets a silent `Killed: 9`. For the `curl | sh` path the binary isn't quarantined (curl doesn't set the bit), so the common path likely works — but the Homebrew and manual-download paths are exposed, and there's no diagnostic guidance in the tool or installer.

**Recommendation:** Have `install.sh` run `xattr -dr com.apple.quarantine "$dest"` on darwin after install, and add a `doctor`/`run`-time check that detects exit-137 / missing signature and prints the remediation. Resolve the `release.yml:90-92` TODO (run the release job on macOS to re-sign, or use a notarized Developer-ID identity for real production macOS distribution).

### H3 — `curl | sh` integrity rests on TLS + GitHub TOFU; no signature on the script or checksums file

The install path *does* verify per-binary SHA-256 against `checksums.sha256` (`install.sh:188-205`) — good, and better than many CLIs. But:
- The `checksums.sha256` file itself is fetched over HTTPS and is **unsigned** (`install.sh:153,188`). Integrity reduces to "trust GitHub's TLS + GitHub didn't tamper." There is no GPG/cosign/minisign verification of the manifest.
- `install.sh` warns and **continues with no verification** if neither `sha256sum` nor `shasum` exists (`install.sh:90-92`, `return 0`). On a minimal box this silently disables the only integrity check.
- If an artifact is **absent from the checksums file**, the installer prints a warning and installs it **unverified anyway** (`install.sh:199-201`). A partial/poisoned release that drops one binary from the manifest installs without integrity.
- The install script piped to `sh` is itself unsigned (standard `curl | sh` caveat); fine for a v1 but worth a SECURITY.md note.

This is "reasonable for a v1" but not "checksum-verified, full stop" as `README.md:109` claims — there are explicit silent-skip branches.

**Recommendation:** Sign `checksums.sha256` (cosign keyless or minisign) and verify in `install.sh`; make the "no sha tool" and "artifact missing from manifest" branches **fail closed** (or require an explicit `--insecure`/`--skip-checksum` opt-in) instead of warning-and-continuing.

---

## MEDIUM findings

### M1 — `install.sh` checksum grep is substring-based and fragile (works today by luck)

`install.sh:198` does `grep "${artifact}" checksums.sha256 | cut -d' ' -f1`. The pattern is an unanchored regex (the `.exe` artifacts contain a regex-wildcard `.`). It happens to be collision-free today only because `am-acp-shell-linux-x64` does not contain the literal substring `am-linux-x64` (the `acp-shell-` segment breaks it) — verified empirically. But a future artifact like `am-linux-x64.sig` or `am-linux-x64-debug` would match the same grep, return two lines, and `cut -f1` would yield a multi-line value, breaking verification non-obviously. The Homebrew template correctly uses anchored greps (`release.yml:142` `grep 'am-darwin-arm64$'`); `install.sh` should too.

**Recommendation:** Anchor the grep: `grep " ${artifact}\$"` (and `grep -F`) to match the exact filename field of `sha256sum` output.

### M2 — `.npmignore` ↔ `package.json files` contradiction (mechanics of C2)

Restating for the packaging-mechanics record: `package.json:16` includes `dist/` in `files`; `.npmignore:5` excludes `dist/`. When both exist, `.npmignore` is authoritative for the publish set, so `dist/` is silently dropped. This is a latent bug regardless of the C2 strategy decision — the two files express opposite intent and must be reconciled.

### M3 — npm `engines` and the source-fallback advertise Node but the fallback needs Bun

`package.json:40-43` declares `engines: { node: ">=18", bun: ">=1.1" }`, and `README.md:116` is a plain `npm install -g`. But the launcher's only non-binary path is `bun run src/cli.ts` (`bin/am.js:76-87`). There is **no Node execution path** for the TypeScript source. A Node-only user who npm-installs (and for whom no `dist/` shipped, per C2) gets the failure message at `bin/am.js:90`. The `engines.node` field overpromises Node compatibility that the runtime doesn't deliver.

**Recommendation:** Either ship per-platform binaries on npm (then Node-only users are fine) or document that npm install requires Bun. Don't advertise `node >=18` as sufficient.

### M4 — Release artifact globs are broad-prefix and depend on naming discipline

`release.yml:63` uploads `dist/am-*` and `release.yml:133` releases `./artifacts/*`. `am-*` correctly captures both `am-darwin-arm64` and `am-acp-shell-darwin-arm64` (both start `am-`). This is fine today, but the entire integrity chain (install.sh, Homebrew formula greps) depends on the exact `am-<os>-<arch>` / `am-acp-shell-<os>-<arch>` naming produced by `build.ts:86-95`. There's no test asserting the produced filenames match what install.sh/Formula expect. The CI integration job only ever builds/tests `am-linux-x64`, never `am-acp-shell-*`, so the second binary's existence and naming is unverified in CI.

**Recommendation:** Add a CI assertion that `bun run build -- --all` produces exactly the 10 expected filenames (5 platforms × 2 binaries), and smoke-test `am-acp-shell-linux-x64 --help`.

---

## LOW findings

### L1 — Silvery build patch is a runtime-fragility risk (`build.ts:64-84`)

The build monkey-patches `node_modules/@silvery/create/src/create-app.tsx` to stub a dynamic require that `bun --compile` can't resolve. It backs up to `.bak` and warns if the regex doesn't match (`build.ts:81-83`) — but it does **not restore** the `.bak`, and a Silvery upgrade that changes the source format would silently ship a binary with a stale/unpatched TUI diagnostic. This couples the binary build to a specific upstream source string. Acceptable as a pragmatic hack but it's load-bearing and undocumented outside this file.

### L2 — Version inlining relies on both `--define` and env (`build.ts:124-137`)

`build.ts` passes `--define=process.env.BUILD_VERSION=<json>` *and* sets `BUILD_VERSION` in the spawn env, and `src/lib/version.ts:9` reads `process.env.BUILD_VERSION ?? "0.0.0-dev"`. CI gates this (`ci.yml:127-141`), which is excellent. Minor: the default in `build.ts:3` is `"0.0.0-dev"` while a forgotten `VERSION` env would ship a binary reporting `0.0.0-dev` — the CI gate catches it for the integration build but the `release.yml` per-target loop (`release.yml:33-38`) sets `VERSION` from the tag, so this is well-covered. No action required; noted for completeness.

### L3 — README "Phase 1 only macOS arm64" comment is stale relative to release reality (`build.ts:19-20`)

`build.ts` defaults to `PHASE1_TARGETS` (macOS arm64 only) when run with no args, but `release.yml` and `ci.yml` always pass explicit targets/`--all`, so the default is dev-only. Not user-facing, but a new contributor running `bun run build` gets a single macOS binary, which can confuse cross-platform expectations.

---

## Strengths (credit where due)

- **Checksum verification exists and is per-binary** (`install.sh:188-205`) — ahead of many CLIs.
- **Dual-binary install is handled consistently** in install.sh (`install.sh:216-217`) and the release-time Homebrew template (`release.yml:198-207`), with clear ADR-0033 rationale comments.
- **macOS ad-hoc signing** to survive the artifact-zip xattr strip (`release.yml:40-57`) shows real platform expertise; the exit-137 failure mode is understood and commented.
- **Prerelease gating**: tags with `-rc/-alpha/-beta` are marked GitHub prereleases so they don't become `latest` (`release.yml:121-127`).
- **Version-drift CI gate** asserts the compiled binary's `--version` matches `package.json` (`ci.yml:127-141`).
- **`bin/*.js` launchers are injection-safe** (`execFileSync` with array argv, hardcoded `bun --version`; `bin/am-acp-shell.js:6-11` documents this).
- **Reproducible-ish builds**: `bun install --frozen-lockfile` everywhere (`ci.yml:16`, `release.yml:27,270`), `bun.lock` committed.
- **Real end-to-end binary integration test** on Linux (`ci.yml:143-258`) exercises init/import/add/list/status/completions against the actual compiled artifact — this is genuinely good and rare.

---

## Production-readiness scoring rationale

The `curl | sh` channel is the one path that is **complete and reasonably safe today** (verified checksums, both binaries, PATH guidance, dry-run). That alone gives a working install story for macOS/Linux. But two of the three advertised channels are broken (npm name owned by a stranger + would ship no binary; Homebrew tap repo doesn't exist + checked-in formula installs only one binary), Windows is unverified-by-CI-design, and the README confidently advertises all of them. A stranger following `README.md:106-121` has a ~33% chance of landing on a working command, and the npm path actively installs an unrelated deprecated package — an embarrassment in front of a first user. The engineering underneath is above-average; the *coherence between what's advertised and what works* is the failure.

**Score: 4/10.** Not shippable as a "v1.0 downloadable" today because 2 of 3 documented install methods are non-functional and one platform is unverified — but the gap to 8/10 is small and mostly known internally (rename/secure npm, create the tap repo, regenerate the checked-in formula, un-skip Windows CI).

---

## Re-architect verdict: **refactor-in-place**

The architecture is sound (single-binary via `bun --compile`, thin launchers, checksum-verified curl path, sensible release matrix). Nothing here needs a redesign. What it needs is **finishing and de-drifting**: secure/rename the npm package, create the Homebrew tap repo and wire release.yml to push there, delete-or-regenerate the stale checked-in formula, reconcile `.npmignore`/`files`, and make Windows a verified (not `continue-on-error`) leg. These are bounded fixes, not a re-architecture.

---

## First-run setup-wizard implications

The overarching goal is a downloadable CLI with a first-run wizard. Distribution sits *upstream* of the wizard — the wizard is moot if the binary doesn't install. Concretely:

- **The wizard's reachability is the install path.** `am init` already runs a `@clack/prompts` wizard (`src/commands/init.ts:3,114,130`, "Novice first-run recovery" at line 159) and both `install.sh:234-235` and `Formula caveats` (`Formula/am.rb:38-46`, `release.yml:213-226`) end by telling the user to run `am init`. That handoff is correct — but it only fires for users who got a *working* binary, i.e., the `curl | sh` path today.
- **The wizard must not assume the second binary is present.** Because the checked-in Homebrew formula installs only `am` (C4), a Homebrew user reaches `am init` but Tier-2 features silently break later. The wizard / `doctor` should verify `am-acp-shell` co-installation and surface `checkShimPreflight` guidance proactively, not on first failed `am run`.
- **A macOS Gatekeeper pre-check belongs in the wizard or `doctor`** (H2): detect exit-137/missing-signature and print the `xattr` remediation, so the wizard never dead-ends on a `Killed: 9`.
- **Until npm/Homebrew are fixed, the wizard should not advertise them.** Any "share install command" or onboarding copy the wizard prints must point only at the working `curl | sh` channel, or it propagates C1/C3 to every new user.

In short: the wizard itself is in decent shape, but it is gated behind a distribution layer that only delivers it reliably through one of three advertised doors. Fix the doors (C1–C4, H1) before leaning on the wizard as the onboarding centerpiece.
