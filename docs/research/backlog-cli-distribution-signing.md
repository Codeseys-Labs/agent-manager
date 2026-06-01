# Secure Distribution for the `am` Single-Binary CLI

**Date:** 2026-05-31
**Status:** research / backlog input
**Scope:** Signing `checksums.sha256`, hardening a future `install.sh` (fail-closed),
macOS Gatekeeper/quarantine/exit-137 for ad-hoc-signed Bun binaries, Windows
SmartScreen, and prior art from bun/deno/starship/grype/babashka/goreleaser.

> Context: the repo ships 5 targets via `bun build --compile` (`scripts/build.ts`)
> and `.github/workflows/release.yml` already (a) ad-hoc `codesign -s -`s the darwin
> binaries on the macOS runner and (b) generates `checksums.sha256` with `sha256sum`
> on the Linux release job. **There is no `install.sh` yet** and **the checksums
> file is not signed.** This report targets exactly those two gaps plus the OS
> trust-prompt realities.

---

## 0. TL;DR / decision

1. **Sign `checksums.sha256` with `minisign`, not cosign — for now.** For a small OSS
   project whose primary install path is `curl … | bash`, minisign gives fully
   offline verification with a single embedded public-key string and a 2-line
   verify step, no `cosign` binary on the user's machine, no Rekor network call.
   Cosign keyless is *better provenance* (no long-lived key, Rekor transparency
   log) but adds a hard `cosign` dependency to the installer and identity/issuer
   flags users get wrong. **Recommendation: ship minisign now, add cosign keyless
   bundles as a second, optional artifact later (belt-and-suspenders).** See §1.
2. **Make `install.sh` fail-closed on checksum mismatch**, following the
   `anchore/grype` pattern (manual `grep`+`cut`+compare, `set -u` + explicit return
   codes rather than `set -e`, `mktemp -d` + `trap … EXIT`, `main "$@"` wrapper
   guarding against `curl|bash` truncation). See §3 + §6.
3. **macOS: the curl|bash path does NOT trigger Gatekeeper quarantine.** `curl`/`wget`
   do not set `com.apple.quarantine` (only browsers/Finder do). So an **ad-hoc
   signature is sufficient** for the installer path; the only requirement is that the
   binary carries a *valid* ad-hoc signature so Apple-Silicon `amfid` doesn't SIGKILL
   it (exit 137). The existing re-sign step is correct in spirit but has a bug: a
   *corrupt* pre-existing signature block makes `codesign -s - -f` fail — you must
   `codesign --remove-signature` first. See §4.
4. **Windows: SmartScreen is reputation-based, not signature-based.** A cheap OV cert
   no longer buys instant reputation (changed Aug 2024); EV no longer instant either
   (changed Mar 2024). For a small OSS CLI, **don't buy a cert** — recommend `winget`/
   `scoop` (which carry their own trust signal) and document the "More info → Run
   anyway" path. See §5.

---

## 1. Signing the checksums file — cosign keyless vs minisign

We sign **`checksums.sha256`** (the manifest), not each binary. A signed manifest
vouches for every listed artifact hash, so one signature covers all 5 platforms +
the `am-acp-shell` secondaries.

### 1a. minisign (recommended first step)

Ed25519, single ~`minisign.pub` line, offline verify, no transparency log.

**Maintainer / CI (one-time keygen, then sign every release):**
```bash
# one-time, locally; password-protect the secret key
minisign -G -p minisign.pub -s minisign.key
# CI signs the manifest (secret key from a GitHub Actions secret, password via env)
echo "$MINISIGN_KEY" > minisign.key
minisign -S -s minisign.key -m checksums.sha256 \
  -t "agent-manager $GITHUB_REF_NAME — github.com/Codeseys-Labs/agent-manager"
# produces checksums.sha256.minisig ; upload it as a release asset
```
`-t` writes a *trusted comment* that is itself signed (covered by the global
signature `minisign -V` checks by default). Note: the *untrusted* comment is NOT
signed — never display it as if it were authenticated (jedisct1/minisign#175).

**User / installer (public key embedded in install.sh, fully offline):**
```bash
MINISIGN_PUBKEY='RWQf6LRCGA9i53mlYecO4IzT51TGPpvWucNSCh1CBM0QTaLn73Y7GFO3'  # ours, baked in
minisign -Vm checksums.sha256 -P "$MINISIGN_PUBKEY"   # exit!=0 ⇒ abort
```

| | minisign |
|---|---|
| User deps | `minisign` binary (brew/apt/scoop) **or** none if treated as optional |
| Network at verify | none (offline) |
| Maintainer secret | long-lived Ed25519 key (store as GH Actions secret, password-encrypted) |
| Revocation | manual: publish a new pubkey, bump installer |
| Transparency log | none |
| Installer complexity | 2 lines, 1 embedded constant |

Sources: minisign README (`-G`/`-S`/`-V`/`-P`, trusted comment) —
https://github.com/jedisct1/minisign/blob/master/README.md ;
https://jedisct1.github.io/minisign/ ; trusted-comment caveat —
https://github.com/jedisct1/minisign/issues/175 ; CI action —
https://github.com/thomasdesr/minisign-action (note: some actions write the key
plaintext to `~/.minisign/minisign.key`; prefer explicit `-s` path + cleanup).

### 1b. cosign keyless (recommended *later*, as a second artifact)

GitHub Actions OIDC → Fulcio short-lived cert → ephemeral key signs blob → entry in
Rekor. No long-lived maintainer key. Cosign v3 emits a single `.sigstore.json`
**bundle** (sig + cert + Rekor inclusion proof) enabling offline verify.

**CI (workflow needs `permissions: id-token: write`):**
```yaml
- uses: sigstore/cosign-installer@v3
- run: cosign sign-blob --yes --bundle=checksums.sha256.sigstore.json checksums.sha256
```
(GoReleaser's documented equivalent: `signs: [{cmd: cosign, signature:
"${artifact}.sigstore.json", args: [sign-blob, --bundle=${signature}, ${artifact},
--yes], artifacts: checksum}]` — https://goreleaser.com/customization/sign/)

**User / installer:**
```bash
cosign verify-blob \
  --bundle checksums.sha256.sigstore.json \
  --certificate-identity-regexp '^https://github.com/Codeseys-Labs/agent-manager/\.github/workflows/release\.yml@.*' \
  --certificate-oidc-issuer 'https://token.actions.githubusercontent.com' \
  checksums.sha256
```
`--certificate-identity[-regexp]` pins the *workflow identity* that was allowed to
sign (use the workflow path form, not an email, for GH-Actions OIDC);
`--certificate-oidc-issuer` pins GitHub's token endpoint. Without both, any
Fulcio-issued cert would pass.

| | cosign keyless |
|---|---|
| User deps | `cosign` binary **required** (large Go binary) |
| Network at verify | none *if* bundle ships the Rekor proof (else queries Rekor) |
| Maintainer secret | **none** (ephemeral key, short-lived cert) |
| Revocation | n/a (cert lives minutes; Rekor is the audit trail) |
| Transparency log | yes (Rekor) — strong non-repudiation |
| Installer complexity | identity/issuer flags users routinely misconfigure |

Sources: `cosign sign-blob` —
https://github.com/sigstore/cosign/blob/main/doc/cosign_sign-blob.md ;
verify — https://docs.sigstore.dev/cosign/verifying/verify ; v3 bundle —
https://goreleaser.com/blog/cosign-v3 ; OIDC-in-Fulcio —
https://docs.sigstore.dev/certificate_authority/oidc-in-fulcio ; keyless GH demo —
https://github.com/chrisns/cosign-keyless-demo ; Rekor —
https://github.com/sigstore/rekor/blob/main/README.md.

### 1c. Verdict

minisign wins on **installer UX and zero user deps**; cosign wins on **maintainer
key hygiene + transparency**. For `am` today: **minisign in `install.sh` (required,
offline), cosign `.sigstore.json` bundle as an optional release asset** documented in
`SECURITY.md` for users who want Rekor-backed provenance. This is the same belt-and-
suspenders posture goreleaser/grype-class projects converge on.

---

## 2. What the popular CLIs actually do (prior art — sobering)

| Project | install.sh verifies checksum? | Signature in installer? | Shell flags | Notes |
|---|---|---|---|---|
| **bun** (`bun.sh/install`) | **No** (curl\|bash path) | No | `set -euo pipefail` | GPG+SHA verify only in the **Dockerfiles** (`SHASUMS256.txt.asc`), not the curl path. |
| **deno** (`deno_install`) | **No** | No | `set -e` only | README documents *manual* SHA256SUM of the script; CI checks the script's own hash, not the binary at install time. |
| **starship** | **No** | No | `set -eu` (no `pipefail`, no main, no trap) | Release CI makes checksums + SignPath-signs Windows; installer ignores both. |
| **rustup/Homebrew** | partial / N/A | N/A | strict + `main`-wrapped | Homebrew installer is `main`-wrapped; relies on TLS + GH. |
| **anchore/grype** | **Yes, fail-closed** | (cosign separately) | `set -u`, **no `set -e`** (errors propagated manually), `mktemp -d` + `trap … EXIT` | **The reference pattern.** |
| **babashka** | **Yes** (via `--checksum` flag) | No | `set -euo pipefail` | Pins version+checksum together; `sha256sum --check --status`. |
| **goreleaser users** | usually yes | cosign keyless bundle | — | Canonical "checksums.txt + .sigstore.json" layout. |

**Takeaway:** verifying in `install.sh` at all already puts `am` ahead of bun/deno/
starship. The bar to clear is **grype**, not bun. Don't over-index on what bun's
curl path does — it punts verification to package managers/Dockerfiles.

Sources (DeepWiki repo Q&A): oven-sh/bun, denoland/deno_install, starship/starship;
real code: https://github.com/anchore/grype/blob/main/install.sh ,
https://github.com/babashka/babashka/blob/master/install ,
https://github.com/Homebrew/install/blob/HEAD/install.sh.

---

## 3. The grype-style fail-closed verification (copy-adaptable)

This is the core block to lift. Note the deliberate **`set -u` without `set -e`** —
they want explicit, message-bearing return codes, not silent `set -e` aborts. (bun/
babashka prefer `set -euo pipefail`; either is defensible — pick one and wrap in a
`main`.)

```sh
hash_sha256() (
  TARGET=${1:-/dev/stdin}
  if   is_command sha256sum; then sha256sum "$TARGET" | cut -d ' ' -f 1
  elif is_command shasum;    then shasum -a 256 "$TARGET" | cut -d ' ' -f 1
  elif is_command gsha256sum;then gsha256sum "$TARGET" | cut -d ' ' -f 1
  elif is_command openssl;   then openssl dgst -sha256 "$TARGET" | cut -d ' ' -f a
  else log_err "no sha256 tool found"; return 1
  fi
)

hash_sha256_verify() (
  target=$1; checksums=$2
  [ -n "$checksums" ] || { log_err "checksum file not specified"; return 1; }
  target_basename=${target##*/}
  want=$(grep "${target_basename}" "${checksums}" 2>/dev/null | tr '\t' ' ' | cut -d ' ' -f 1)
  [ -n "$want" ] || { log_err "no checksum for '${target}' in '${checksums}'"; return 1; }  # FAIL-CLOSED
  got=$(hash_sha256 "$target")
  [ "$want" = "$got" ] || { log_err "checksum mismatch ${want} vs ${got}"; return 1; }       # FAIL-CLOSED
)
```
Two fail-closed gates: **missing checksum line** and **mismatch** both `return 1`.
Verbatim source: https://github.com/anchore/grype/blob/main/install.sh

---

## 4. macOS: Gatekeeper, quarantine, and exit-137 SIGKILL

### 4a. The single most important fact for the curl|bash path

> **`curl` and `wget` do NOT set the `com.apple.quarantine` extended attribute.**
> Only browsers, Mail, Messages, and Finder-driven downloads do.

(Source: https://stackoverflow.com/questions/37791355/gatekeeper-quarantine-issue-with-certificate
— "command-line tools like `curl` and `wget` won't apply quarantine.")

Consequence: a binary installed via `curl … | bash` is **not quarantined**, so the
full Gatekeeper/notarization assessment (`spctl --assess`) is **never invoked** on
first run. **We therefore do NOT need an Apple Developer ID or notarization for the
installer path.** Notarization only matters for users who download the binary in a
browser or ship it inside a `.dmg`/`.zip` opened via Finder — a documentation note
(`xattr -dr com.apple.quarantine ./am`) covers that minority.

### 4b. But Apple Silicon still requires a *valid* signature (or SIGKILL / exit 137)

Independent of quarantine, on `arm64` macOS the kernel/`amfid` **requires every
executable to carry a valid code signature — even ad-hoc**. An unsigned or
*corrupt-signature* Mach-O is killed with `SIGKILL` on `exec`, surfacing as
**exit 137, 0 bytes of output, `zsh: killed`**.

Real-world evidence this bites Bun-compiled CLIs specifically:
- backnotprop/plannotator#541: v0.17.8 shipped macOS binaries with **no signature**
  → `code object is not signed at all` → SIGKILL on Sequoia. Root cause: release
  workflow used `bun-version: latest` and picked up **Bun 1.3.12, which regressed and
  stripped the ad-hoc linker signature** from cross-compiled macOS Mach-O. v0.17.7
  (Bun 1.3.11) was fine. **Our `release.yml` pins `bun-version: 1.3.11` — keep it
  pinned; do not float to `latest`.** (https://github.com/backnotprop/plannotator/issues/541)
- garrytan/gstack#997: same SIGKILL; `otool -l` shows an `LC_CODE_SIGNATURE` load
  command but an empty/corrupt block; `codesign -dv` → `code object is not signed at
  all`; `spctl --assess` → `invalid or unsupported format for signature`.
  (https://github.com/garrytan/gstack/issues/997)

### 4c. The re-sign bug in the current release.yml

The workflow currently does:
```bash
codesign -s - --force --timestamp=none "$bin"
```
Per gstack#997, **a naive `codesign -s - -f` FAILS** with *"invalid or unsupported
format for signature"* when a *corrupt* signature block already exists (exactly the
Bun-regression case). The robust sequence is **remove-then-sign**:
```bash
codesign --remove-signature "$bin" 2>/dev/null || true   # tolerate "not signed"
codesign -s - --force --timestamp=none "$bin"
codesign -dv "$bin" 2>&1 | grep -q 'Signature=adhoc'      # assert it took
```
Also note the larger latent bug flagged in the workflow's own comments: `actions/
upload-artifact` **zips and strips xattrs/signatures**, and the *release* job runs on
**Linux** where it cannot re-sign. So the signature applied on the macOS *build* job
can be stripped before the asset reaches the release. Two fixes (pick one):
- **(A)** Do the `sha256sum` + (later) re-sign on a **macOS** release job, or
- **(B)** Apply ad-hoc signing **inside `scripts/build.ts`** right after `bun build
  --compile` on the same macOS runner *and* upload the dist files with a method that
  preserves the Mach-O signature (the signature lives *inside* the Mach-O, so a plain
  binary upload preserves it; the risk is only the zip round-trip of
  upload/download-artifact). Verify post-download on the release job with
  `otool -l … | grep LC_CODE_SIGNATURE` and **fail the release if absent**.

### 4d. Installer self-heal (defensive)

Even with CI signing, `install.sh` should ad-hoc re-sign on the user's machine as a
safety net (it's a no-op cost):
```sh
if [ "$(uname -s)" = "Darwin" ] && command -v codesign >/dev/null 2>&1; then
  codesign --remove-signature "$DEST" 2>/dev/null || true
  codesign -s - --force "$DEST" 2>/dev/null || true
fi
```

Commands cheat-sheet: `codesign -dv ./am` (inspect; want `Signature=adhoc`),
`codesign -v ./am` (verify), `xattr -dr com.apple.quarantine ./am` (clear quarantine
if browser-downloaded), `spctl --assess --verbose ./am` (Gatekeeper assessment —
only relevant for quarantined files). Bun docs codesign guidance (Developer-ID path,
JIT entitlements) — https://bun.com/docs/bundler/executables.

---

## 5. Windows SmartScreen

SmartScreen has **two signals: publisher reputation + per-file-hash reputation**, and
since 2024 a code-signing certificate (even EV) **no longer grants instant
reputation** — it must accrue over "several weeks and hundreds of clean installs."

- OV cert: $100–500/yr, since Jun 2023 must live on a hardware token/HSM; reputation
  builds in ~2–8 weeks (unofficial), not instant.
- EV cert: $250–700/yr, registered-business only; **as of Mar 2024 no longer instant**
  either.

Microsoft's own guidance: the most reliable way to avoid the warning is **publish to
the Microsoft Store**, or distribute via a channel that carries its own trust
(`winget`, `scoop`). Unsigned files build hash reputation per-file and reset every
release.

**Recommendation for `am`:** **do not buy a cert.** Instead:
1. Publish a `winget` manifest and a `scoop` bucket entry (these are the trusted
   distribution channels Windows users expect for CLIs; the manifest carries the
   `checksums.sha256` hash, giving integrity without Authenticode).
2. In `install.ps1` / docs, verify the SHA256 (`Get-FileHash -Algorithm SHA256`) and
   document the "More info → Run anyway" click-through for direct-download users.
3. Use a **consistent publisher identity** in the Bun Windows metadata
   (`scripts/build.ts` could pass `--windows-publisher`, etc.) so that *if* a cert is
   ever added, reputation isn't reset.

Sources: https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/smartscreen-reputation ;
https://stackoverflow.com/questions/48946680/ ;
https://www.advancedinstaller.com/prevent-smartscreen-from-appearing.html ;
https://codesigningstore.com/what-does-this-smartscreen-message-means (Aug-2024 EV change).

---

## 6. Concrete `install.sh` hardening diff plan

There is no `install.sh` today — this is a **create**, written to clear the grype bar.
Place at `scripts/install.sh`, served via raw GitHub (or a redirect).

### Required release.yml change (publish the signature + keep using checksums)
```diff
       - name: Generate checksums
         working-directory: ./artifacts
         run: |
           sha256sum am-* > checksums.sha256
+      - name: Sign checksums (minisign)
+        working-directory: ./artifacts
+        env:
+          MINISIGN_KEY: ${{ secrets.MINISIGN_SECRET_KEY }}
+          MINISIGN_PASSWORD: ${{ secrets.MINISIGN_PASSWORD }}
+        run: |
+          printf '%s' "$MINISIGN_KEY" > mk.key
+          echo "$MINISIGN_PASSWORD" | minisign -S -s mk.key -m checksums.sha256 \
+            -t "agent-manager ${GITHUB_REF_NAME} github.com/Codeseys-Labs/agent-manager"
+          rm -f mk.key
+      # (optional, later) cosign keyless bundle:
+      # cosign sign-blob --yes --bundle=checksums.sha256.sigstore.json checksums.sha256
```
…and ensure `gh release create … ./artifacts/*` now uploads
`checksums.sha256.minisig` (and optionally the `.sigstore.json`).

### Fix the darwin re-sign step (remove-then-sign)
```diff
       - name: Ad-hoc sign darwin binaries (macOS only)
         if: runner.os == 'macOS'
         run: |
           set -euo pipefail
           for bin in dist/am-darwin-* dist/am-acp-shell-darwin-*; do
+            codesign --remove-signature "$bin" 2>/dev/null || true
             codesign -s - --force --timestamp=none "$bin"
-            codesign -dv "$bin" 2>&1 | head -3
+            codesign -dv "$bin" 2>&1 | grep -q 'Signature=adhoc' \
+              || { echo "ad-hoc signing did not take for $bin"; exit 1; }
           done
```

### Add a release-job gate that fails if a darwin signature was stripped
```diff
+      - name: Assert darwin binaries are signed
+        working-directory: ./artifacts
+        run: |
+          for bin in am-darwin-* am-acp-shell-darwin-*; do
+            otool -l "$bin" 2>/dev/null | grep -q LC_CODE_SIGNATURE \
+              || { echo "FATAL: $bin lost its code signature in transit"; exit 1; }
+          done
```
> If the release job stays on Linux (no `otool`), use `llvm-otool`, or move this job
> to macOS (recommended) so it can also *re-sign* after the artifact round-trip.

### New `scripts/install.sh` — hardening checklist (grype + babashka synthesis)
- [ ] `#!/usr/bin/env bash`; `set -u`; **wrap all logic in `main()` and call
      `main "$@"` on the last line** → guards against `curl|bash` truncation
      (a partially delivered file never reaches the `main` call).
- [ ] `umask 077`; sanitize `PATH`; create `tmpdir=$(mktemp -d)` and
      `trap 'rm -rf -- "$tmpdir"' EXIT INT TERM`.
- [ ] OS/arch detection → map to artifact names exactly as `scripts/build.ts` emits
      (`am-darwin-arm64`, `am-darwin-x64`, `am-linux-x64`, `am-linux-arm64`,
      `am-windows-x64.exe`) **and** the `am-acp-shell-*` secondaries (ADR-0033: tier-2
      shims ENOENT without both binaries).
- [ ] Pinning: honor `AM_VERSION` / `--version`; default to GitHub "latest" release.
- [ ] Download with `curl --fail --location --proto '=https' --tlsv1.2 --retry 3`
      (`--proto '=https'` blocks downgrade; `--fail` blocks HTML error pages).
- [ ] Download `checksums.sha256` + `checksums.sha256.minisig` to `tmpdir`.
- [ ] **minisign verify (fail-closed) if `minisign` present**, else WARN + fall back
      to checksum-only (document that `minisign` is strongly recommended):
      `minisign -Vm "$tmpdir/checksums.sha256" -P "$MINISIGN_PUBKEY" || die`.
- [ ] **sha256 verify the downloaded binary against the (now-trusted) manifest,
      fail-closed** using the grype `hash_sha256_verify` block (§3).
- [ ] Atomic install: `chmod 0755`; `mv "$tmpdir/$asset" "$DEST"` (same-fs rename is
      atomic; mv into place last, after all verification).
- [ ] macOS self-heal: `codesign --remove-signature` then `codesign -s - --force`
      (§4d).
- [ ] Distinct non-zero exit codes per failure class (download / no-checksum-tool /
      sig-fail / hash-mismatch) for debuggability.
- [ ] `AM_INSTALL_DIR` override (default `$HOME/.local/bin`); PATH hint at end.

### Minimal verified skeleton (drop-in starting point)
```sh
#!/usr/bin/env bash
set -u
MINISIGN_PUBKEY='RW...REPLACE_WITH_OUR_PUBKEY...'
REPO='Codeseys-Labs/agent-manager'
INSTALL_DIR="${AM_INSTALL_DIR:-$HOME/.local/bin}"

die() { printf 'install: %s\n' "$*" >&2; exit "${2:-1}"; }
is_command() { command -v "$1" >/dev/null 2>&1; }

main() {
  tmpdir="$(mktemp -d)"; trap 'rm -rf -- "$tmpdir"' EXIT INT TERM
  os=$(uname -s | tr 'A-Z' 'a-z'); arch=$(uname -m)
  case "$arch" in arm64|aarch64) arch=arm64;; x86_64|amd64) arch=x64;; esac
  case "$os" in darwin) asset="am-darwin-$arch";; linux) asset="am-linux-$arch";;
    *) die "unsupported OS: $os";; esac
  ver="${AM_VERSION:-latest}"
  base="https://github.com/$REPO/releases"
  url="$base/$( [ "$ver" = latest ] && echo latest/download || echo download/$ver )"

  dl() { curl --fail --location --proto '=https' --tlsv1.2 --retry 3 -o "$1" "$2" \
           || die "download failed: $2" 3; }
  dl "$tmpdir/$asset"               "$url/$asset"
  dl "$tmpdir/checksums.sha256"     "$url/checksums.sha256"
  dl "$tmpdir/checksums.sha256.minisig" "$url/checksums.sha256.minisig" || true

  if is_command minisign; then
    minisign -Vm "$tmpdir/checksums.sha256" -P "$MINISIGN_PUBKEY" \
      || die "signature verification FAILED — aborting" 4
  else
    printf 'install: minisign not found; skipping signature check (install minisign to enable)\n' >&2
  fi

  want=$(grep " $asset\$" "$tmpdir/checksums.sha256" | cut -d ' ' -f 1)
  [ -n "$want" ] || die "no checksum for $asset (fail-closed)" 5
  if   is_command sha256sum; then got=$(sha256sum "$tmpdir/$asset" | cut -d ' ' -f 1)
  elif is_command shasum;    then got=$(shasum -a 256 "$tmpdir/$asset" | cut -d ' ' -f 1)
  else die "no sha256 tool found" 6; fi
  [ "$want" = "$got" ] || die "checksum mismatch: $want vs $got (fail-closed)" 5

  mkdir -p "$INSTALL_DIR"
  chmod 0755 "$tmpdir/$asset"; mv "$tmpdir/$asset" "$INSTALL_DIR/am"
  if [ "$os" = darwin ] && is_command codesign; then
    codesign --remove-signature "$INSTALL_DIR/am" 2>/dev/null || true
    codesign -s - --force "$INSTALL_DIR/am" 2>/dev/null || true
  fi
  printf 'installed: %s/am (%s)\n' "$INSTALL_DIR" "$ver"
}
main "$@"
```
> The trailing `main "$@"` is the truncation guard: bash parses the whole file before
> executing the final call, so a short read never half-runs the installer.

---

## 7. Open questions / follow-ups
- Generate the minisign keypair, add `MINISIGN_SECRET_KEY` + `MINISIGN_PASSWORD`
  GH-Actions secrets, bake the pubkey into `install.sh`. (One-time.)
- Decide whether to **move the release job to macOS** (lets it re-sign + `otool`-gate
  in one place) — strongly recommended given the upload-artifact xattr-strip risk.
- Author `SECURITY.md` documenting: minisign pubkey + fingerprint, manual verify
  steps, the (optional) cosign `.sigstore.json` identity/issuer, and the macOS
  `xattr -dr com.apple.quarantine` note for browser downloads. (Ties to ADR-0019
  security hardening; consider an ADR for the distribution-trust model.)
- Add a `winget` manifest + `scoop` bucket entry for Windows (avoids SmartScreen
  cert spend).
- Keep `bun-version` **pinned** in CI (never `latest`) to avoid the 1.3.12-class
  signature-stripping regression.

## 8. Source index
- Bun executables / codesigning: https://bun.com/docs/bundler/executables
- Plannotator SIGKILL post-mortem (Bun 1.3.12 regression): https://github.com/backnotprop/plannotator/issues/541
- gstack SIGKILL / remove-then-resign: https://github.com/garrytan/gstack/issues/997
- curl doesn't set quarantine: https://stackoverflow.com/questions/37791355/
- HackTricks Gatekeeper/Quarantine/XProtect: https://hacktricks.wiki/en/macos-hardening/macos-security-and-privilege-escalation/macos-security-protections/macos-gatekeeper.html
- grype install.sh (reference fail-closed pattern): https://github.com/anchore/grype/blob/main/install.sh
- babashka install (version+checksum pinning): https://github.com/babashka/babashka/blob/master/install
- Homebrew install.sh (main-wrapped): https://github.com/Homebrew/install/blob/HEAD/install.sh
- minisign README + site: https://github.com/jedisct1/minisign/blob/master/README.md , https://jedisct1.github.io/minisign/
- minisign trusted-comment caveat: https://github.com/jedisct1/minisign/issues/175
- cosign sign-blob / verify: https://github.com/sigstore/cosign/blob/main/doc/cosign_sign-blob.md , https://docs.sigstore.dev/cosign/verifying/verify
- cosign v3 bundle / goreleaser sign: https://goreleaser.com/blog/cosign-v3 , https://goreleaser.com/customization/sign/
- Rekor / Fulcio OIDC: https://github.com/sigstore/rekor/blob/main/README.md , https://docs.sigstore.dev/certificate_authority/oidc-in-fulcio
- SmartScreen reputation (MS): https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/smartscreen-reputation
- SmartScreen cert reality: https://stackoverflow.com/questions/48946680/ , https://www.advancedinstaller.com/prevent-smartscreen-from-appearing.html , https://codesigningstore.com/what-does-this-smartscreen-message-means
- curl security / pinning: https://curl.se/libcurl/security.html , https://curl.se/libcurl/c/CURLOPT_PINNEDPUBLICKEY.html
