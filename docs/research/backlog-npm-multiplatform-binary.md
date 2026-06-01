# Shipping `am` on npm via per-platform binary packages

**Research date:** 2026-05-31
**Topic:** Distributing the Bun-compiled `agent-manager` CLI on npm using the
`optionalDependencies` + per-platform-package pattern (esbuild / @swc/core /
turbo / biome model), scoped under `@codeseys-labs`.

**Audience:** maintainers wiring up the npm release pipeline for `am`.

---

## TL;DR

1. **Adopt the optionalDependencies pattern.** Publish one thin scoped
   "launcher" package (`@codeseys-labs/agent-manager`) plus N tiny per-platform
   packages (`@codeseys-labs/cli-<os>-<arch>`), each carrying a single Bun-
   compiled binary and declaring `os`/`cpu`. npm only downloads the matching
   one. This is exactly what esbuild, @swc/core, turbo, and biome do.
2. **The launcher in `bin/` resolves the right binary via `require.resolve`**
   against a static `PLATFORMS` map keyed by `process.platform`/`process.arch`,
   then `spawnSync`s it with `stdio: "inherit"` and mirrors the exit code/signal.
   Your existing `bin/am.js` is 90% there — it just needs to resolve from the
   optional packages, not from a bundled `dist/`.
3. **CI publishes platform packages FIRST, the launcher LAST,** at one shared
   exact version, with `files` pruned so no TS source ships. Use npm Trusted
   Publishing (OIDC) instead of a long-lived `NPM_TOKEN`. Mind npm bug #4828 —
   commit a complete lockfile.

---

## 1. Why this pattern (and the trap you're currently in)

`agent-manager` already compiles 5 standalone executables via `bun build
--compile` (`scripts/build.ts`), and `bin/am.js` is a Node shim that looks for
`dist/am-<os>-<arch>`. The problem: if `dist/` is in the published `files`, a
single npm tarball would carry **all five** ~50–100 MB Bun binaries (each
embeds the full Bun runtime — Bun docs confirm "~50-100 MB ... they include the
Bun runtime" [B1]). Every user downloads ~300 MB to use one binary. That is the
exact anti-pattern the optionalDependencies model exists to kill.

The Mux CLI faced the identical situation (a Bun `--compile` CLI shipping to
npm) and wrote up the canonical migration plan [M1]:

> "The goal is to make `npm install -g @mux/cli` ... work on any system with
> Node.js — no Bun required — by shipping platform-specific binaries as
> separate npm packages and using the `optionalDependencies` pattern that
> Biome, esbuild, Turbo, and Bun itself all use."

**How npm makes this cheap:** A package's `os`/`cpu` arrays whitelist platforms;
npm v7+ evaluates these against `process.platform`/`process.arch` and **skips
fetching/unpacking** any optionalDependency whose constraints don't match [N1].
A failed or skipped optional dependency never fails `npm install` [N2]. So the
launcher package can list all N platform packages as `optionalDependencies`,
and a given machine only ever downloads the one binary it can run.

---

## 2. Package topology for `@codeseys-labs`

The unscoped name `agent-manager` is taken on npm by another author, so scope
everything under your org. Scoping is the standard practice — `@esbuild/*`,
`@swc/core`, `@biomejs/*` all publish multiple platform packages inside one
namespace [T-tavily §6]. Two viable layouts:

### Recommended naming

| Package | Role | Size |
|---|---|---|
| `@codeseys-labs/agent-manager` | launcher (the one users install), `bin: am, agent-manager, am-acp-shell` | tiny (~10 KB) |
| `@codeseys-labs/cli-darwin-arm64` | binary only | ~60–90 MB |
| `@codeseys-labs/cli-darwin-x64` | binary only | ~60–90 MB |
| `@codeseys-labs/cli-linux-x64` | binary only | ~60–90 MB |
| `@codeseys-labs/cli-linux-arm64` | binary only | ~60–90 MB |
| `@codeseys-labs/cli-win32-x64` | binary only | ~60–90 MB |

Use the **Node** names `win32` and `x64`/`arm64` in package names (biome uses
`@biomejs/cli-win32-x64`, `@biomejs/cli-darwin-arm64` [D-biome]). Your
*existing* artifact names use `windows` (`am-windows-x64.exe`) — that's fine for
GitHub-release artifacts but the npm package suffix should match the value the
launcher derives from `process.platform`, so either:
- name packages with `win32` and translate in the launcher (recommended,
  matches biome/turbo), **or**
- keep `windows` and translate `win32 → windows` in the launcher (what your
  current `bin/am.js` PLATFORM_MAP already does).

Pick one and keep the launcher map and package names in lockstep.

> **`am-acp-shell` secondary binary (ADR-0033).** You ship two binaries per
> platform (`am` and `am-acp-shell`). Two clean options:
> 1. **Bundle both into each platform package** (recommended). Each
>    `@codeseys-labs/cli-<os>-<arch>` contains `am` and `am-acp-shell`; the
>    launcher package exposes both `bin` entries via two shims that resolve from
>    the *same* platform package. One optional dep per platform, simplest CI.
> 2. Separate platform packages per binary — doubles package count, not worth it.

---

## 3. Concrete `package.json` files

### 3a. Launcher — `@codeseys-labs/agent-manager`

```jsonc
{
  "name": "@codeseys-labs/agent-manager",
  "version": "0.5.0",
  "description": "the control plane for AI agents",
  "bin": {
    "am": "bin/am.js",
    "agent-manager": "bin/am.js",
    "am-acp-shell": "bin/am-acp-shell.js"
  },
  // Ship ONLY the shims + docs. No src/, no dist/, no node_modules of binaries.
  "files": ["bin", "README.md", "LICENSE"],
  "optionalDependencies": {
    "@codeseys-labs/cli-darwin-arm64": "0.5.0",
    "@codeseys-labs/cli-darwin-x64":   "0.5.0",
    "@codeseys-labs/cli-linux-x64":    "0.5.0",
    "@codeseys-labs/cli-linux-arm64":  "0.5.0",
    "@codeseys-labs/cli-win32-x64":    "0.5.0"
  },
  "publishConfig": { "access": "public" },
  "engines": { "node": ">=18" },
  "license": "MIT",
  "repository": { "type": "git", "url": "https://github.com/Codeseys-Labs/agent-manager.git" }
}
```

Key choices:
- **`files: ["bin", ...]`** — this is the whitelist. Anything not listed (your
  `src/` TypeScript, `dist/`, tests, ADRs) is excluded from the tarball
  regardless of `.npmignore`. `files` is authoritative; prefer it over
  `.npmignore` for "ship only these" semantics. Verify with `npm pack
  --dry-run` (see §7).
- **Exact versions in `optionalDependencies`** (no `^`). The launcher and every
  platform package must publish at the *same* exact version each release —
  esbuild and the Mux plan both pin exactly [M1][T-tavily §2]. A caret range
  risks resolving a platform binary that's a different build than the launcher.
- The launcher has **no `dependencies`** and no runtime deps — it's pure Node
  built-ins (`child_process`, `path`, `fs`).

> **Note on the existing `agent-manager` package.json:** your current root
> `package.json` has `main: src/cli.ts`, `dependencies`, `devDependencies`,
> etc. — that's the *development* manifest. The **published launcher** manifest
> is a different, minimal file generated/maintained for release (biome and swc
> generate platform `package.json`s from a template at publish time
> [D-biome]). Do not publish the dev manifest as-is — it would drag `react`,
> `hono`, `isomorphic-git` etc. as real deps the binary doesn't need.

### 3b. Platform package — `@codeseys-labs/cli-darwin-arm64`

```jsonc
{
  "name": "@codeseys-labs/cli-darwin-arm64",
  "version": "0.5.0",
  "description": "macOS arm64 binary for agent-manager",
  "os": ["darwin"],
  "cpu": ["arm64"],
  "files": ["am", "am-acp-shell"],
  "publishConfig": { "access": "public" },
  "license": "MIT"
}
```

- **`os`/`cpu` are the install filter.** npm/pnpm skip non-matching packages
  [N1]; the binary darwin-arm64 build is never downloaded on a linux-x64 box.
- **No `bin` field here** — the binary is just a file inside the package;
  the *launcher* package owns the `bin` entries and resolves into this package.
  (biome platform packages contain only the binary + package.json [D-biome].)
- **`files` lists the binary names.** On Windows the package
  `@codeseys-labs/cli-win32-x64` lists `["am.exe", "am-acp-shell.exe"]`.
- Binaries are **injected by CI at publish time**, not committed (Mux: "Binaries
  are not checked in — they're injected by CI at publish time." [M1]).

#### Optional: Linux musl

esbuild/biome split Linux into glibc and musl. biome platform packages add a
`libc` field and the launcher branches on `isMusl()` [D-biome]. Bun's compiled
binaries currently target glibc-flavored Linux; **defer musl** unless you have
Alpine/musl users — it doubles your Linux package count. If you add it later:
`@codeseys-labs/cli-linux-x64-musl` with `"libc": ["musl"]`.

---

## 4. The launcher (`bin/am.js`) — resolve from optional packages

Your current launcher resolves from `dist/`/sibling dirs. Rewrite it to resolve
the binary out of the installed optional package via `require.resolve`. This is
the biome/turbo/Mux pattern verbatim.

### Reference: how the real ones do it

**biome** `bin/biome` [D-biome]:
```js
const PLATFORMS = {
  win32:  { x64: "@biomejs/cli-win32-x64/biome.exe",  arm64: "@biomejs/cli-win32-arm64/biome.exe" },
  darwin: { x64: "@biomejs/cli-darwin-x64/biome",     arm64: "@biomejs/cli-darwin-arm64/biome" },
  linux:  { x64: "@biomejs/cli-linux-x64/biome",      arm64: "@biomejs/cli-linux-arm64/biome" },
  "linux-musl": { x64: "@biomejs/cli-linux-x64-musl/biome", arm64: "@biomejs/cli-linux-arm64-musl/biome" },
};
const binPath = env.BIOME_BINARY ||
  (platform === "linux" && isMusl()
    ? PLATFORMS?.["linux-musl"]?.[arch]
    : PLATFORMS?.[platform]?.[arch]);
const result = require("child_process").spawnSync(
  require.resolve(binPath),         // <-- resolves into the optional package
  process.argv.slice(2),
  { shell: false, stdio: "inherit", env: { ...env } }
);
if (result.error) throw result.error;
process.exitCode = result.status;
```

**turbo** `bin/turbo` [T-turbo] adds: env override first (`TURBO_BINARY_PATH`),
a scoped-then-legacy name fallback, signal forwarding (`SIGTERM` → child;
re-raise on signal exit so the wrapper's exit faithfully mirrors the child),
and rich diagnostics that parse `package-lock.json` to detect the npm #4828
lockfile bug.

### Proposed `bin/am.js` for `@codeseys-labs/agent-manager`

```js
#!/usr/bin/env node
"use strict";
const { spawnSync } = require("node:child_process");

// Map process.platform/arch -> the optional package + binary file inside it.
const PLATFORMS = {
  darwin: { x64: "@codeseys-labs/cli-darwin-x64/am",   arm64: "@codeseys-labs/cli-darwin-arm64/am" },
  linux:  { x64: "@codeseys-labs/cli-linux-x64/am",    arm64: "@codeseys-labs/cli-linux-arm64/am" },
  win32:  { x64: "@codeseys-labs/cli-win32-x64/am.exe" },
};

function resolveBinary() {
  // Escape hatch for dev / CI / vendored binary.
  if (process.env.AM_BINARY) return process.env.AM_BINARY;
  const spec = PLATFORMS?.[process.platform]?.[process.arch];
  if (!spec) return null;
  try {
    return require.resolve(spec);     // finds it inside the optional dep
  } catch {
    return null;                      // optional dep was skipped/missing
  }
}

function main() {
  const bin = resolveBinary();
  if (!bin) {
    console.error(
      `agent-manager: no prebuilt binary for ${process.platform}-${process.arch}.\n` +
      `This usually means the matching @codeseys-labs/cli-${process.platform}-${process.arch} ` +
      `optional dependency was not installed.\n` +
      `Fixes:\n` +
      `  - Reinstall without a stale lockfile: rm -rf node_modules package-lock.json && npm install\n` +
      `    (see npm bug https://github.com/npm/cli/issues/4828)\n` +
      `  - If you installed with --no-optional / --omit=optional, reinstall with optionals enabled.\n` +
      `  - Or set AM_BINARY=/path/to/am to point at a local build.`
    );
    process.exit(1);
  }
  const res = spawnSync(bin, process.argv.slice(2), { stdio: "inherit", shell: false, env: process.env });
  if (res.error) {
    if (res.error.code === "ENOENT") {
      console.error(`agent-manager: binary not found at ${bin}`);
    } else {
      console.error(`agent-manager: ${res.error.message}`);
    }
    process.exit(1);
  }
  // Mirror signal-based exits like turbo does.
  if (res.signal) {
    process.kill(process.pid, res.signal);
    return;
  }
  process.exit(res.status == null ? 1 : res.status);
}
main();
```

`bin/am-acp-shell.js` is the same file with `am` → `am-acp-shell` in the
`PLATFORMS` values (and `am-acp-shell.exe` on win32), resolving the same
platform package.

**Why `require.resolve` and not a hardcoded `node_modules` path:** it follows
Node module resolution, so it works through pnpm's symlinked store, npm
hoisting, monorepo workspaces, and `npx` temp installs without hardcoding
layout. The Sentry guide and esbuild both rely on `require.resolve(...)` first,
with a `path.join(__dirname, ...)` fallback only for the bundled-binary case
[S1].

**Optional perf note (esbuild's trick):** esbuild's postinstall replaces the JS
shim's `.bin` symlink target with a hardlink to the real binary so invocations
skip a Node process [D-esbuild]. This is an optimization, not required — biome,
turbo, and Mux all just `spawnSync` through Node and it's fine for a control-
plane CLI. **Skip it** unless startup latency becomes a complaint; it adds a
postinstall script (supply-chain surface, often disabled in CI).

**Keep your Bun fallback for `bun run dev`, but NOT in the published shim.** The
current `hasBun()` → `bun run src/cli.ts` fallback is great for local
development from a git checkout, but the *published* launcher ships no `src/`,
so that branch can never fire for end users. Gate it behind "does
`../src/cli.ts` exist" or drop it from the published shim. Keep dev ergonomics
in `bun run dev` (already in your scripts) instead.

---

## 5. CI: build + publish all platform packages

### Build (you already have this)

`scripts/build.ts --all` cross-compiles all 5 targets via `bun build --compile
--target=bun-<os>-<arch>` (Bun supports cross-compilation, no Docker/QEMU
needed [B1][B2]). Run it on a single Linux runner — Bun cross-compiles all
targets from one host. That's simpler than biome/swc's per-OS build matrix
(they need it because Rust/native toolchains don't cross-compile as freely).

### Publish order: platform packages FIRST, launcher LAST

This ordering is load-bearing: the launcher's `optionalDependencies` must
resolve to *already-published* platform packages [T-tavily §4][M1]. esbuild's
workflow builds everything, then `make publish-all` publishes platform packages
before the main package and pushes the git tag only after npm publish succeeds
[D-esbuild].

### GitHub Actions skeleton (single runner, Bun cross-compile, OIDC publish)

```yaml
name: publish-npm
on:
  push:
    tags: ["v*"]

permissions:
  id-token: write   # npm Trusted Publishing (OIDC) — no NPM_TOKEN needed
  contents: read

jobs:
  publish:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
      - uses: actions/setup-node@v4
        with:
          node-version: "24"                       # >=22.14 for OIDC publish
          registry-url: "https://registry.npmjs.org"
      - run: npm install -g npm@latest              # >=11.5.1 for trusted publishing

      - name: Cross-compile all targets
        run: VERSION="${GITHUB_REF_NAME#v}" bun run build -- --all

      - name: Sync versions + assemble platform packages
        run: bun run scripts/npm-pack.ts "${GITHUB_REF_NAME#v}"

      # ---- platform packages FIRST ----
      - name: Publish platform packages
        run: |
          for d in npm/@codeseys-labs/cli-*; do
            ( cd "$d" && npm publish --access public --provenance )
          done

      # ---- launcher LAST ----
      - name: Publish launcher
        run: ( cd npm/@codeseys-labs/agent-manager && npm publish --access public --provenance )
```

A small `scripts/npm-pack.ts` should, for each target:
1. write the platform `package.json` from a template (name, exact version,
   `os`, `cpu`, `files`),
2. copy `dist/am-<os>-<arch>` → `npm/@codeseys-labs/cli-<os>-<arch>/am`
   (and the acp-shell binary), `chmod +x`,
3. write the launcher `package.json` with matching exact `optionalDependencies`
   and copy `bin/*.js` in.

biome does exactly this with `generate-packages.mjs` — reads root metadata,
writes each platform `package.json` with `name/version/os/cpu/libc`, copies the
binary in, then loops `npm publish` [D-biome].

### Auth: prefer Trusted Publishing (OIDC) over `NPM_TOKEN`

npm Trusted Publishing uses GitHub OIDC so "each publish uses short-lived,
cryptographically-signed tokens ... that cannot be extracted or reused" — no
long-lived secret in repo settings [N3]. Requirements [N3]:
- `permissions: id-token: write` in the workflow,
- npm CLI ≥ 11.5.1, Node ≥ 22.14.0,
- configure the trusted publisher on npmjs.com (org/repo + workflow filename),
- bonus: provenance attestations are auto-generated for public repo + public
  package (the `--provenance` flag is then optional).

If you must use a token instead (e.g. publishing from a non-GitHub runner): set
`NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}` on the publish steps and use a
**granular automation token** scoped to the `@codeseys-labs` packages. esbuild
and swc historically used `NODE_AUTH_TOKEN`; esbuild has since moved to OIDC
trusted publishing [D-esbuild][T-tavily §4].

---

## 6. The npm lockfile bug (#4828) — the #1 thing that bites this pattern

This is the single most common failure mode and worth a CI guard.

**The bug** [N4][L1]: When you regenerate `package-lock.json` while
`node_modules` already exists, npm writes a lockfile containing **only the
current machine's** platform optional dependency, omitting the others. If that
truncated lockfile is committed and a teammate / CI / Docker on a *different*
arch runs `npm ci`, npm silently skips installing their platform binary → the
launcher finds nothing → runtime error. The original report is literally about
`@swc/core`'s platform packages [N4]. Still open / recurring (see follow-up
#8320 in 2025 [N5]).

**Mitigations (apply all):**
1. **Regenerate lockfiles cleanly:** always `rm -rf node_modules
   package-lock.json && npm install` to get a complete lockfile (or use the
   newer `npm install --install-strategy` / fresh-clone install) [L1][N4].
2. **Commit a complete lockfile** that lists *all* platform packages. Add a CI
   check (loke.dev pattern [L1]):
   ```bash
   for p in darwin-arm64 darwin-x64 linux-x64 linux-arm64 win32-x64; do
     grep -q "@codeseys-labs/cli-$p" package-lock.json \
       || { echo "lockfile missing cli-$p"; exit 1; }
   done
   ```
3. **Document the AM_BINARY escape hatch + reinstall hint** in the launcher's
   error message (done in §4) so end users self-rescue.
4. **pnpm users:** can force-install other arches via `supportedArchitectures`
   in `pnpm-workspace.yaml` [P1] — useful for building cross-arch Docker images.
5. **Docker pitfall:** never `COPY node_modules` from a build stage on a
   different arch into the final image — optional-dep resolution breaks (Sentry
   guide flags this [S1]). Run `npm install` inside the target-arch stage.

---

## 7. Avoid shipping TypeScript source — verification

- **`files` whitelist is the mechanism.** The launcher's `files: ["bin",
  "README.md", "LICENSE"]` excludes everything else; the dev `src/`, `test/`,
  `ADRs/`, `dist/` never enter the tarball. `files` beats `.npmignore` for
  intent clarity. Mux explicitly drops `dist` from `files`: "the main package
  ships no built JS" [M1].
- **Platform packages** ship only `files: ["am", "am-acp-shell"]` (+ implicit
  `package.json`). No JS, no source.
- **Always dry-run before tagging:**
  ```bash
  cd npm/@codeseys-labs/agent-manager && npm pack --dry-run
  # inspect the "Tarball Contents" — must be ONLY bin/*.js + README + LICENSE
  cd npm/@codeseys-labs/cli-linux-x64 && npm pack --dry-run
  # must be ONLY am, am-acp-shell, package.json
  ```
- Add a CI assertion that `npm pack --dry-run --json | jq '.[0].files[].path'`
  contains no `*.ts` and no `src/`.

---

## 8. Cross-client behavior (test these)

| Client | optionalDependencies behavior | Notes |
|---|---|---|
| **npm v7+** | Skips non-matching `os`/`cpu` optional deps; never fails install [N1][N2] | Subject to lockfile bug #4828 [N4] |
| **pnpm** | Honors `os`/`cpu`; `supportedArchitectures` can force other arches [P1] | Best cross-arch story |
| **Yarn (berry)** | Applies `os`/`cpu`/`libc`; may require optional deps to be *resolvable*; `--ignore-optional` skips them [Y1][T-tavily §1] | Test explicitly |
| **Bun** | Honors optional deps; `bunx @codeseys-labs/agent-manager` works | Your dev runtime |

Install-test on at least npm + pnpm before announcing. The pattern is identical
to esbuild/biome which all four clients consume daily, so it's well-trodden.

---

## 9. Concrete migration checklist for `agent-manager`

- [ ] Reserve the `@codeseys-labs` org/scope on npmjs.com; enable a Trusted
      Publisher for `Codeseys-Labs/agent-manager` + the publish workflow file.
- [ ] Decide package suffix convention (`win32` recommended) and align
      `bin/am.js` `PLATFORMS` map + platform package names.
- [ ] Decide single-binary-per-platform-package carries BOTH `am` and
      `am-acp-shell` (recommended). Update both shims to resolve the same dep.
- [ ] Rewrite `bin/am.js` and `bin/am-acp-shell.js` to `require.resolve` from
      the optional packages (§4); add `AM_BINARY` override + #4828 hint.
- [ ] Author `scripts/npm-pack.ts`: emit per-platform `package.json`
      (`os`/`cpu`/`files`/exact version), copy binaries, emit launcher
      `package.json` with matching exact `optionalDependencies`, copy shims.
- [ ] Add `npm publish` workflow: build `--all` on one Bun runner → assemble →
      publish platform packages → publish launcher; OIDC, `--provenance`.
- [ ] Add CI guards: `npm pack --dry-run` contents assertion (no `*.ts`),
      lockfile completeness check for all platform packages.
- [ ] Smoke test: `npm i -g @codeseys-labs/agent-manager` and `npx
      @codeseys-labs/agent-manager --version` on macOS arm64, linux x64,
      win32 x64; repeat under pnpm.
- [ ] Keep the existing `install.sh` / GitHub Releases path unchanged — it's a
      good no-Node alternative (Mux keeps both [M1]).
- [ ] Update README install matrix (npm global / npx / curl installer / GH
      release download).

---

## Sources

- **[D-esbuild]** DeepWiki — evanw/esbuild distribution Q&A: `optionalDependencies`,
  per-platform `os`/`cpu`, `postinstall node install.js`,
  `pkgAndSubpathForCurrentPlatform()`, `require.resolve(\`${pkg}/${subpath}\`)`,
  hardlink shim optimization, WASM fallback.
  https://deepwiki.com/evanw/esbuild
- **[D-biome]** DeepWiki — biomejs/biome distribution Q&A: `@biomejs/cli-<os>-<arch>`,
  `os`/`cpu`/`libc`, `bin/biome` launcher (`PLATFORMS`, `isMusl()`,
  `require.resolve`, `spawnSync` stdio inherit, `process.exitCode`),
  `generate-packages.mjs`, `release_cli.yml` matrix. https://deepwiki.com/biomejs/biome
- **[D-biome-src]** biome launcher source `packages/@biomejs/biome/bin/biome`
  (verbatim `PLATFORMS`, `isMusl`, `spawnSync`): https://github.com/biomejs/biome/blob/main/packages/@biomejs/biome/bin/biome
- **[T-turbo]** turbo launcher `packages/turbo/bin/turbo` (env override,
  scoped+legacy resolve, signal forwarding, #4828 lockfile diagnostics):
  https://github.com/vercel/turborepo/blob/main/packages/turbo/bin/turbo
- **[M1]** Mux CLI npm distribution plan (Bun `--compile` → optionalDependencies,
  dir layout, launcher, version sync, CI order):
  https://github.com/muxinc/cli/blob/main/npm-distribution-plan.md
- **[N1]** npm package.json docs — `os`/`cpu` fields, optionalDependencies:
  https://docs.npmjs.com/cli/v11/configuring-npm/package-json
- **[N2]** "What is npm optionalDependencies?" — failed optional deps don't fail
  install; `--no-optional`: https://zenn.dev/catnose99/articles/7dfcd5b3e5b141?locale=en
- **[N3]** npm Trusted Publishing (OIDC, `id-token: write`, npm ≥11.5.1, Node
  ≥22.14, auto-provenance): https://docs.npmjs.com/trusted-publishers
- **[N4]** npm/cli#4828 — platform optional deps omitted from `package-lock.json`
  on reinstall (original report is about `@swc/core`):
  https://github.com/npm/cli/issues/4828
- **[N5]** npm/cli#8320 (2025) — recurrence of #4828 in CI:
  https://github.com/npm/cli/issues/8320
- **[L1]** loke.dev — "That Weird NPM Bug That Broke My Build" — #4828 workaround
  + CI grep guard: https://loke.dev/blog/npm-platform-specific-dependencies-bug
- **[S1]** Sentry — "How to publish binaries on npm" (os/cpu, require.resolve +
  path.join fallback, chmod +x, postinstall risks, Docker node_modules trap):
  https://blog.sentry.io/publishing-binaries-on-npm/
- **[SWC]** @swc/core package.json (real optionalDependencies platform listing):
  https://app.unpkg.com/@swc/core@1.6.13/files/package.json
- **[SWC-CI]** swc publish workflow (matrix + NODE_AUTH_TOKEN):
  https://github.com/swc-project/swc/blob/main/.github/workflows/publish-npm-package.yml
- **[B1]** Bun single-file executable docs (cross-compile `--target`, ~50-100 MB
  self-contained): https://bun.com/docs/bundler/executables
- **[B2]** DeployHQ Bun cheatsheet — cross-compile targets without Docker:
  https://www.deployhq.com/cheatsheets/bun
- **[P1]** pnpm settings — `supportedArchitectures`: https://pnpm.io/settings
- **[Y1]** Yarn manifest — os/cpu/libc + optional behavior:
  https://yarnpkg.com/configuration/manifest
- **[T-tavily]** Tavily research synthesis (npm selection rules, naming,
  launcher, CI ordering, scoping) — citations [1]–[11] therein map to the above.
