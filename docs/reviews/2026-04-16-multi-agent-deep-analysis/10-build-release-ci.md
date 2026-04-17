# Build, Release, and CI Review — agent-manager @ v0.4.0

**Facet:** Build reproducibility, release quality, CI robustness, distribution correctness
**Date:** 2026-04-16
**Scope:** `.github/workflows/*.yml`, `scripts/build.ts`, `scripts/bump-version.sh`, `install.sh`, `bin/am.js`, `package.json`, `Formula/am.rb`

---

## Summary

The pipeline is **functionally complete for a v0.4.0 pre-1.0 release**, covering the
happy path end-to-end: tag push triggers a matrix build across five Bun targets,
artifacts are aggregated, SHA256 checksums generated, a GitHub Release is cut with
release notes auto-extracted from `CHANGELOG.md`, the Homebrew formula is
regenerated and pushed back to `main`, and the npm package is published with a
version taken from the tag. The `install.sh` client verifies checksums before
execution. This puts agent-manager in the top quartile of single-maintainer OSS
projects for release ergonomics.

However, the pipeline has **significant gaps for a tool that writes to users' home
directories**:

1. **No binary signing or notarization.** On macOS, Gatekeeper will quarantine the
   downloaded binary; on first run the user gets a "cannot be opened" dialog or a
   silent `exit 137` (SIGKILL by the kernel after Gatekeeper denies exec). There
   is no `codesign`, no `xattr -d com.apple.quarantine` guidance in `install.sh`,
   no notarization ticket, and no Apple Developer ID configured.
2. **No supply-chain attestation.** No SLSA provenance, no in-toto attestation, no
   sigstore/cosign signature on the release artifacts. A compromised runner or a
   malicious PR merged to `main` could ship a trojaned `am` binary with no way
   for users to detect tampering beyond the sha256 digest (which the same
   attacker could also publish).
3. **No scheduled security scanning.** No CodeQL, no `bun audit` (or
   `npm audit`) gate, no dependabot config, no Snyk, no OSV-Scanner. With 11
   runtime deps (including `hono`, `isomorphic-git`, `react`, `citty`,
   `@iarna/toml`), a transitive vulnerability will ship silently.
4. **Version reporting bug.** `src/commands/version.ts:11` and `src/cli.ts:8` both
   default to the hardcoded literal `"0.1.0"` when `BUILD_VERSION` is unset. If a
   developer or a future workflow ever builds without `VERSION=` prefix (e.g. the
   npm package served via the `bin/am.js` shim to a user with `bun` available
   runs `bun src/cli.ts` with no env var), the tool reports `0.1.0`. The binary
   in `dist/` built at tag time is correct; the fallback path is not.
5. **`continue-on-error: true` on Windows build-verify** silently masks failures.
   Windows is tested but never gated.

---

## CI Job Inventory

| Job | Workflow | Trigger | Runner | Gates | Artifacts |
|---|---|---|---|---|---|
| `test` | `ci.yml:9` | push/PR to `main` | `blacksmith-2vcpu-ubuntu-2404` | typecheck (src/ only), lint (biome), `bun test --coverage`, `bun run build -- --all` smoke | none (build artifacts discarded) |
| `build-verify` (matrix) | `ci.yml:46` | push/PR to `main` | linux-2vcpu, macos-6vcpu, **windows-2vcpu (soft-fail)** | `bun install`, `bun test` | none |
| `integration` | `ci.yml:76` | push/PR to `main` (`needs: test`) | `blacksmith-2vcpu-ubuntu-2404` | builds linux-x64 binary with `VERSION=ci-test`, seeds `$HOME` fixtures, asserts `version`, `--help`, `init`, `doctor`, `import claude-code` (≥3 servers), project `.mcp.json` import, `list servers`, `add server`, `add instruction`, `status`, `completion bash/zsh/fish` all contain `init` | none |
| `build` (matrix) | `release.yml:10` | push tag `v*.*.*` | linux-2vcpu (linux-x64 + linux-arm64), macos-6vcpu (darwin-arm64 + darwin-x64), windows-2vcpu (windows-x64) | `bun install`, then `bun run build -- --target $target` per target | upload-artifact@v4, 1-day retention, `if-no-files-found: error` |
| `release` | `release.yml:48` | `needs: build` | `blacksmith-2vcpu-ubuntu-2404` | download all artifacts, `sha256sum`, extract CHANGELOG `[Unreleased]` section, `gh release create`, regenerate `Formula/am.rb`, stamp CHANGELOG date, push formula+changelog to `main`, set npm version from tag, `bunx npm publish --access public` | GitHub Release with 5 binaries + `checksums.sha256`, npm package, Homebrew formula commit |

**No additional workflows exist.** No `security.yml`, `docs.yml`, `nightly.yml`,
`scorecard.yml`, or `dependabot.yml`. The only two files in
`.github/workflows/` are `ci.yml` and `release.yml`.

### Script scripts (`package.json:43-58`)

| Script | Runs | CI-safe? |
|---|---|---|
| `dev` | `bun run src/cli.ts` | dev-only |
| `build` | `bun run scripts/build.ts` | ✅ |
| `test` | `bun test` | ✅ |
| `test:coverage` | `bun test --coverage` | ✅ |
| `test:watch` | `bun test --watch` | dev-only |
| `test:unit` | `bun test test/core test/adapters` | ✅ |
| `test:integration` | `bun test test/integration` | ✅ |
| `lint` | `bunx @biomejs/biome check ./src ./test` | ✅ |
| `lint:fix` / `lint:fix:unsafe` | biome with `--write` | dev-only |
| `typecheck` | `bun x tsc --noEmit` | ✅ (but CI uses a custom `grep '^src/'` filter, not this script) |
| `dev:web` / `deploy:web` / `web:kv:create` | wrangler | **broken in CI**: wrangler requires CF credentials and a `.dev.vars` file — no CI guardrails, but also not invoked |

**Dev-only scripts that could silently no-op if invoked in CI without auth:**
`deploy:web` and `web:kv:create` would hang waiting for Cloudflare OAuth. They
are not wired into any workflow, so the risk is latent.

---

## Release Pipeline (reproducibility assessment)

`release.yml` is the most production-critical workflow. Step-by-step:

1. **Checkout + Bun install** (lines 22-27) — uses `bun-version: latest`. This is
   **not reproducible across time**; a Bun release between tags could change
   compilation output. Pin to a specific Bun version (e.g. `1.2.x`) to guarantee
   byte-identical rebuilds from the same source.
2. **Matrix build** (lines 30-38) — `VERSION="${GITHUB_REF_NAME#v}"` is derived
   from the tag. Each matrix leg builds its native targets. Reasonable, but the
   `scripts/build.ts:52-70` step mutates `node_modules/@silvery/create/src/create-app.tsx`
   in-place to patch a `require()` call. This patch is applied **per
   runner**, and if it ever fails to match (e.g. after a dependency upgrade), the
   build script emits a warning but **continues** (`build.ts:66-69`: "WARNING:
   Silvery patch regex did not match — build may fail at runtime"). This is a
   build-reproducibility landmine: the warning is not fatal, so a future Silvery
   release could silently break prod builds.
3. **Artifact upload** (lines 40-46) — 1-day retention. Fine for the release
   window but makes forensic analysis after the fact (e.g., reviewing what
   binary was cut for v0.3.0) impossible. Consider 90-day retention for release
   artifacts or mirror them to S3.
4. **Checksum generation** (lines 63-68) — `sha256sum am-* > checksums.sha256`.
   Correct. Attached to the release. `install.sh:82-101` verifies it client-side.
5. **Release notes extraction** (lines 70-84) — `sed`-based extraction from
   `CHANGELOG.md` between `## [Unreleased]` and next `## [`. Works for the
   current format; fragile if a contributor changes heading style.
6. **`gh release create`** (lines 86-94) — attaches `./artifacts/*`, including the
   `checksums.sha256`. Good.
7. **Formula regeneration** (lines 96-166) — cleanly rewritten from scratch per
   release, avoiding sed-on-previous-values drift. Values are substituted via
   `sed` after the heredoc. Solid.
8. **CHANGELOG stamp** (lines 168-175) — replaces `[Unreleased]` with
   `[VERSION] - DATE`, inserts a fresh `[Unreleased]` section. This committed
   change goes to `main` without a PR (direct push, lines 177-184), which is a
   **workflow that bypasses branch protection** if enabled. If a reviewer has
   required-approval rules on `main`, the release will fail.
9. **npm publish** (lines 186-208) — sets version via a `bun -e` inline script,
   then `bunx npm publish --access public` with `NODE_AUTH_TOKEN`. Works, but:
   - The published npm tarball ships `src/` and `bin/am.js` but **not** `dist/`
     binaries (they are gitignored, see `.gitignore:6`, and not produced in this
     job — the release job runs on a separate `blacksmith-2vcpu-ubuntu-2404`
     runner that never invoked `bun run build`). The `bin/am.js` shim will
     therefore always fall back to `bun run src/cli.ts` for `npm install -g
     agent-manager`. That is by design (per `bin/am.js:58-87`), but it
     means: **npm users require Bun installed**. This is not documented in
     `package.json` — only in README, which CI does not verify.
   - No `npm provenance` flag (`--provenance`) despite GitHub Actions supporting
     it out of the box since 2023.
   - `publishConfig: { access: "public" }` in `package.json:18-20` is correct.

### Reproducibility score: 6/10
- ✅ Deterministic source (tag-triggered, version from ref)
- ✅ Binaries embed tag version via `--define BUILD_VERSION`
- ✅ SHA256 checksums published
- ❌ Bun version not pinned (`latest`)
- ❌ `node_modules` patch with silent-fail fallback
- ❌ No lockfile hash verification beyond `--frozen-lockfile`
- ❌ No build attestation / provenance

---

## Missing CI Gates

Compared to a typical mature TypeScript CLI release pipeline:

| Gate | Present? | Notes |
|---|---|---|
| Typecheck | Partial | Only `src/` errors fail (ci.yml:22-29). Test files are excluded — real errors hide |
| Lint | ✅ | `bun run lint` (ci.yml:31) |
| Unit tests | ✅ | With coverage (ci.yml:32-42) |
| Integration tests | ✅ | Dedicated job (ci.yml:76-204) |
| Build verification | ✅ | Cross-platform matrix (ci.yml:46-74) |
| **Security scan (CodeQL / Semgrep)** | ❌ | No static analysis |
| **Dependency audit (`bun pm audit` / `npm audit`)** | ❌ | Never run |
| **Dependabot / Renovate** | ❌ | No `.github/dependabot.yml` |
| **SBOM generation (CycloneDX / SPDX)** | ❌ | Missing |
| **Secret scanning** | ❌ | Only relies on GitHub's default push protection |
| **License compliance check** | ❌ | No `license-checker` gate |
| **Binary smoke test on each platform** | Partial | Only linux-x64 gets the deep `integration` job; darwin/windows never run `am init/doctor/import` |
| **`npm publish --provenance`** | ❌ | Would give sigstore attestation for free |
| **Coverage threshold enforcement** | ❌ | `--coverage` is collected but never compared to a floor; a PR dropping coverage from 80% to 20% passes |
| **Bundle size regression check** | ❌ | Binary size not tracked across releases |
| **Release PR preview / dry-run** | ❌ | Can only test the release flow by cutting a real tag |
| **Rollback procedure** | ❌ | No documented revert path (npm `unpublish` has a 72h window; GH release can be deleted; Homebrew needs a reverting commit) |

---

## Distribution & Signing

Four distribution channels are wired:

### 1. GitHub Releases (compiled binaries)
- 5 targets: `am-darwin-arm64`, `am-darwin-x64`, `am-linux-x64`, `am-linux-arm64`, `am-windows-x64.exe`
- `checksums.sha256` attached
- Retention: indefinite (GH Release assets)
- **Unsigned on all platforms.**

### 2. `install.sh` (curl | sh)
- `install.sh:82-101` verifies sha256 via `sha256sum` or `shasum`
- Gracefully warns and continues if neither is available (line 91) — **a MITM
  attacker could strip sha256 tooling from the environment and the verification
  silently no-ops**. This should be a hard fail.
- No GPG signature on the install script itself

### 3. Homebrew (`Formula/am.rb`)
- Auto-regenerated on every release (release.yml:96-166)
- SHA256 embedded for each platform variant
- Currently lives in the same repo (not a tap) — users must use
  `brew install --cask Codeseys-Labs/agent-manager/am` or similar. No
  `homebrew-tap` repo exists that I can see.

### 4. npm (`agent-manager` package)
- Shim-only: `bin/am.js` delegates to compiled binary if present, else `bun run src/cli.ts`
- Users without Bun get a helpful error (`bin/am.js:90-93`) but cannot run the tool
- No npm provenance

### macOS Gatekeeper / Exit 137

The user-reported `exit 137` on macOS is consistent with **Gatekeeper killing the
unsigned binary** after the kernel's translocation check. On macOS 15+:

1. The binary has the `com.apple.quarantine` xattr after download
2. First exec triggers Gatekeeper; for an unsigned binary from an unidentified
   developer, the kernel issues `SIGKILL` (exit 137 = 128 + 9)
3. Users can work around it with `xattr -d com.apple.quarantine /path/to/am` or
   Right-click → Open in Finder, but **neither is documented** in `install.sh`,
   README, or release notes

**Fix options (in ascending cost/effort):**
- **Zero-cost:** Add `xattr -d com.apple.quarantine "$DEST" 2>/dev/null || true`
  at the end of `install.sh` for the `darwin` case. Solves the install-script
  path entirely.
- **Low-cost ($99/yr):** Apple Developer ID certificate; sign binaries in the
  macOS runner with `codesign --options=runtime --sign $TEAM_ID ./am-darwin-*`
  and notarize via `xcrun notarytool submit`. Gatekeeper accepts without prompt.
- **High-value:** Sigstore / cosign for cross-platform artifact signing
  (`cosign sign-blob` over each binary, attestation alongside the release).

### Platform attestation matrix

| Platform | Signed? | Notarized? | Gatekeeper-friendly? | Windows SmartScreen-friendly? |
|---|---|---|---|---|
| darwin-arm64 | ❌ | ❌ | ❌ | N/A |
| darwin-x64 | ❌ | ❌ | ❌ | N/A |
| linux-x64 | N/A | N/A | N/A | N/A |
| linux-arm64 | N/A | N/A | N/A | N/A |
| windows-x64 | ❌ | N/A | N/A | ❌ (SmartScreen warning) |

---

## Platform Coverage Matrix

| Target | Built in CI (`ci.yml test`)? | Built in Release? | Unit tests run on this platform? | Integration tests run on this platform? | Distribution |
|---|---|---|---|---|---|
| linux-x64 | ✅ (smoke via `--all`) | ✅ | ✅ | ✅ | GH Release, npm, install.sh, Homebrew |
| linux-arm64 | ✅ (smoke) | ✅ | ❌ | ❌ | GH Release, install.sh, Homebrew |
| darwin-arm64 | ✅ (smoke) | ✅ | ✅ (build-verify) | ❌ | GH Release, install.sh, Homebrew |
| darwin-x64 | ✅ (smoke) | ✅ | ❌ | ❌ | GH Release, install.sh, Homebrew |
| windows-x64 | ✅ (smoke) | ✅ | ⚠️ soft-fail (ci.yml:54) | ❌ | GH Release, install.sh |

**Gap:** Only linux-x64 runs the full `integration` job. On darwin-arm64 (most
Mac users) and windows-x64, we have **no end-to-end verification** that `am
init`, `am import claude-code`, or `am apply` actually works with real
filesystem operations. `test/integration` tests run in `bun test` but use
`mktemp` and mocks — they test the TypeScript source, not the compiled Bun
binary on that OS.

**Windows soft-fail risk:** `continue_on_error: true` on Windows build-verify
(ci.yml:54) means a broken Windows test is invisible. If the maintainer ships a
Windows-breaking change, CI is green, users hit it at runtime.

---

## Version Consistency

| Source | Value | Where set |
|---|---|---|
| `package.json` version | `0.4.0` | committed, updated by `scripts/bump-version.sh` |
| Git tag | `v0.4.0` | created by bump-version.sh |
| Binary `am version` output | `0.4.0` (if built at tag with `VERSION=` env) or `"0.1.0"` (fallback) | `src/commands/version.ts:11`, `src/cli.ts:8` |
| Homebrew formula | `0.4.0` | `Formula/am.rb:4` |
| npm published | `0.4.0` | overwritten from tag in `release.yml:196-203` |

**Issues:**

1. **Fallback version is `0.1.0`** — not `0.0.0-dev` or `"dev"` or the
   `package.json` version. If `BUILD_VERSION` isn't injected, the tool lies
   about its version. At minimum the fallback should read
   `require("../../package.json").version` or match `scripts/build.ts:3`'s
   `0.0.0-dev`.
2. **No version-consistency check.** Nothing in CI asserts that
   `package.json.version === git tag - "v" === binary output`. A human
   error in `bump-version.sh` (e.g. tagging `v0.4.1` while package.json stays
   `0.4.0`) would ship mismatched artifacts.
3. **`release.yml:196-203` rewrites `package.json`** in the release job without
   committing it to git. The npm package is published with the correct version,
   but the commit history on `main` will still show `0.4.0` after `v0.4.1` is
   released unless `bump-version.sh` is run first. **This is the expected flow**
   (bump → tag → push → workflow runs), but a release from the GitHub UI
   "Create tag from commit" path would skip the bump and ship a version-drifted
   npm package.

---

## Caching

- `actions/cache` is **not used** anywhere.
- `useblacksmith/setup-bun@v1` may cache Bun itself but not `node_modules`.
- `bun install --frozen-lockfile` runs on every job, every step, every run.
  Across 3 jobs in `ci.yml` + 6 jobs in `release.yml`, this is 9 installs per
  release pipeline.
- No TypeScript incremental build cache (`*.tsbuildinfo` is in `dist/` but not
  persisted across runs).
- Blacksmith runners may have ephemeral disk caching but this is not configured
  explicitly.

**Impact:** CI wall time is ~2-3x what it could be with bun install cache, but
the tradeoff is simplicity and avoiding poisoned-cache bugs.

---

## Blacksmith Runner Security

- Runner labels: `blacksmith-2vcpu-ubuntu-2404`, `blacksmith-6vcpu-macos-latest`,
  `blacksmith-2vcpu-windows-2025`
- `useblacksmith/setup-bun@v1` — version pinned to major `v1`, not a specific
  commit SHA. A compromised `v1` tag could run arbitrary code in the runner
  with access to `NPM_TOKEN` and `GITHUB_TOKEN`.
- `actions/checkout@v4`, `actions/upload-artifact@v4`, `actions/download-artifact@v4`,
  `actions/setup-node@v4` — all pinned to major only, not SHA. This is
  conventional for GitHub Actions but not SLSA-compliant.
- **`NPM_TOKEN` is exposed to the `release` job** which runs user-controlled
  build output (the compiled `am` binary could theoretically be executed in that
  job, though it isn't today). Consider a scoped publish token with
  "publish-only" permission and a different token per release if feasible.
- `GITHUB_TOKEN` has `contents: write` (release.yml:7) — needed for the
  CHANGELOG push, but broad.

---

## Recommendations

Prioritized by ratio of risk reduction to implementation cost.

### P0 — Do before 1.0

1. **Fix version fallback.** Change `src/commands/version.ts:11` and
   `src/cli.ts:8` fallback from `"0.1.0"` to read `package.json` version or use
   `"0.0.0-dev"`. Add a CI assertion that binary `version` output matches
   `package.json.version` (run in `integration` job).

2. **Quarantine fix for macOS install.** Append to `install.sh:208-210`:
   ```sh
   if [ "$OS" = "darwin" ]; then
     xattr -d com.apple.quarantine "$DEST" 2>/dev/null || true
   fi
   ```
   Document `sudo xattr` workaround for manual downloads in README.

3. **Fail-closed sha256 verification.** Change `install.sh:91-93` to exit 1
   if neither `sha256sum` nor `shasum` is found, not warn-and-continue.

4. **Add `bun pm audit` gate to `ci.yml`.** Fail CI on HIGH severity advisories.

5. **Add `dependabot.yml`** for `github-actions`, `npm`, and (if Bun supports
   it) `bun`.

6. **Drop `continue-on-error: true` on Windows build-verify** or move it to a
   separate warning-only job so it stops masking real breakage.

### P1 — Next milestone

7. **Pin Bun version** in both workflows. Replace `bun-version: latest` with
   `bun-version: 1.2.x` (or whatever is current at tag time). Document the
   upgrade procedure.

8. **Pin GitHub Actions to SHA.** `actions/checkout@<sha>` for all third-party
   actions. Dependabot can auto-update these.

9. **`npm publish --provenance`** — free sigstore attestation. Add
   `--provenance` flag and `id-token: write` permission.

10. **Expand integration tests to darwin-arm64 and windows-x64.** Copy the
    `integration` job logic into the release workflow so every released binary
    is smoke-tested on its native OS before publication.

11. **Make the Silvery patch fatal.** `scripts/build.ts:66-69` currently warns
    and continues. The patch was added to work around a `require()` that Bun
    compile cannot resolve; if the regex ever misses, the binary will
    segfault at runtime. Exit non-zero if the patch doesn't apply.

### P2 — Hardening

12. **macOS code signing + notarization.** Apple Developer ID cert stored in
    GH secrets, `codesign` + `notarytool` steps in the release matrix macOS
    leg. Removes the quarantine issue permanently.

13. **SLSA provenance / sigstore signatures.** Use
    `slsa-framework/slsa-github-generator` for Level 3 provenance on release
    artifacts. `cosign sign-blob` each binary with keyless OIDC.

14. **SBOM generation.** `@anchore/syft` GitHub Action emits CycloneDX SBOM;
    attach to each release.

15. **CodeQL** workflow for TypeScript — scheduled weekly + on PR.

16. **Release artifact retention ≥90 days.** Currently 1 day on CI build
    artifacts (fine), but the GH Release assets are indefinite (good). Mirror
    to a second location (S3, R2) for forensic preservation.

17. **Coverage threshold.** Set a floor (e.g. 70%) and fail CI if coverage
    drops below.

18. **Document rollback procedure.** CONTRIBUTING.md or RELEASING.md: how to
    revert a bad release (gh release delete, npm deprecate, Homebrew formula
    revert commit).

19. **Separate homebrew-tap repo.** `Codeseys-Labs/homebrew-am` with the
    formula, so `brew tap Codeseys-Labs/am && brew install am` works cleanly.

20. **`package.json` engines / platforms.** Add `os` and `cpu` fields or a
    `postinstall` script that downloads the correct binary, eliminating the
    Bun-required fallback for npm users.

---

## References (file:line)

- `.github/workflows/ci.yml:9-44` — test job
- `.github/workflows/ci.yml:46-74` — build-verify matrix (Windows soft-fail at :54)
- `.github/workflows/ci.yml:76-204` — integration job
- `.github/workflows/release.yml:10-46` — build matrix
- `.github/workflows/release.yml:48-208` — release job
- `.github/workflows/release.yml:63-68` — checksum generation
- `.github/workflows/release.yml:96-166` — Homebrew formula regeneration
- `.github/workflows/release.yml:177-184` — direct push to main (branch-protection risk)
- `.github/workflows/release.yml:196-208` — npm publish
- `scripts/build.ts:3` — `VERSION` env fallback `"0.0.0-dev"`
- `scripts/build.ts:52-70` — Silvery in-place node_modules patch
- `scripts/bump-version.sh:42-56` — version validation
- `src/cli.ts:8` — `BUILD_VERSION` fallback `"0.1.0"` (inconsistent with build.ts)
- `src/commands/version.ts:11` — same fallback
- `install.sh:82-101` — sha256 verification (warn-and-continue failure mode)
- `install.sh:208-209` — install without quarantine removal
- `bin/am.js:58-93` — Bun-required fallback path for npm users
- `Formula/am.rb` — Homebrew formula with current 0.4.0 checksums
- `package.json:11-17` — files included in npm tarball (no `dist/`)
- `package.json:43-58` — scripts
- `.npmignore` — excludes test, docs, dist, scripts, CI config
