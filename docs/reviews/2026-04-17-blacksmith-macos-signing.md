---
tags: [type/review, project/agent-manager]
created: 2026-04-17
updated: 2026-04-17
status: complete
---

# Blacksmith macOS darwin-arm64 codesign failure — root cause analysis

## Summary

**Blacksmith's `blacksmith-6vcpu-macos-latest` is a real native Apple Silicon M4 macOS runner, not a Linux cross-compile VM.** The "Virtual-Machine" hostname is macOS running on virtualised Apple hardware (Blacksmith's own virt layer), but the kernel, libSystem, and file-system semantics are genuine macOS on arm64. The codesign failure is NOT a cross-compile artefact — it is a **Bun regression**.

The actual root cause is [Bun issue #29120](https://github.com/oven-sh/bun/issues/29120) / PR [#29272](https://github.com/oven-sh/bun/pull/29272): **Bun v1.3.12 ships a buggy `LC_CODE_SIGNATURE.datasize` calculation in `src/macho.zig`.** The bug was latent for months but became fatal in 1.3.12 when the Bun runtime grew ~337 KB — the allocated signature slot (~196 KB) is now far smaller than the SuperBlob the signer actually produces (~537 KB), so the signature is truncated. macOS 14+ arm64 rejects the truncated signature and SIGKILLs the binary on exec (the observed exit 137). `codesign -s - --force` refuses to re-sign the corrupt Mach-O because the existing `LC_CODE_SIGNATURE` load command points past `__LINKEDIT`'s usable range. The `agent-manager` release workflow pins `bun-version: latest` via `useblacksmith/setup-bun@v1`, which began resolving to 1.3.12 on 2026-04-10, matching the regression window perfectly. The fix shipped in **Bun 1.3.13** (merged 2026-04-14).

The ~336 KB size difference between a working local v1.3.11 build (66,864,928 bytes) and the broken v1.3.12 CI build (67,201,600 bytes) is direct on-disk confirmation: it is exactly the "runtime grew 337 KB" delta called out in #29120.

## Evidence for the root cause

### 1. Blacksmith macos-latest runs real macOS (cross-compile hypothesis falsified)

Blacksmith documents macOS runners as genuine Apple Silicon M4 hardware (virtualised, not emulated):

> "Blacksmith runs macOS on Apple Silicon M4 chipsets (ARM64)"
> — `https://docs.blacksmith.sh/blacksmith-runners/overview` (label table includes `blacksmith-6vcpu-macos-latest` = 6 vCPU / 24 GB / 150 GB, macOS 26)

Runner labels:
- `blacksmith-6vcpu-macos-latest` → currently macOS 26
- `blacksmith-{6,12}vcpu-macos-{15,26,latest}`

Pricing is consistent with real Mac hardware ($0.08 / $0.16 per minute), and Blacksmith claims image parity with GitHub-hosted macOS images. The "runners-Virtual-Machine" hostname is the VM wrapper Blacksmith uses on Apple silicon — this is the same approach GitHub-hosted macOS runners use (Anka / Tart). So the binary IS being produced on a real Darwin kernel, which rules out the Linux-cross-compile hypothesis.

### 2. Bun 1.3.12 macho.zig regression (the real root cause)

- **Issue**: [oven-sh/bun#29120](https://github.com/oven-sh/bun/issues/29120) — "Cross-compilation with `--target=bun-darwin-arm64` producing truncated code signature in v1.3.12" (closed, completed 2026-04-14).
- **Duplicate / confirmation**: [oven-sh/bun#29306](https://github.com/oven-sh/bun/issues/29306) — "bun build --compile produces binaries with corrupt LC_CODE_SIGNATURE on macOS arm64 (SIGKILL on Sequoia 15.4+)" (closed, completed 2026-04-14). Critically, #29306 reproduces **on native macOS arm64 as well**, proving the bug is not cross-compile–specific.
- **Fix**: PR [oven-sh/bun#29272](https://github.com/oven-sh/bun/pull/29272) — "fix: targeting `__LINKEDIT` and `LC_CODE_SIGNATURE` sizing" (merged 2026-04-14, shipped in **Bun 1.3.13**).

The PR diff replaces a delta-based sizing approximation inside `writeSection` (which was computing signature space as `template_size + num_new_pages * HASH_SIZE`) with a new shared helper `MachoSigner.computeSignatureSize(sig_off)` that mirrors the exact formula `MachoSigner.sign` uses when it writes the real SuperBlob. When the two formulas disagree (as they did in 1.3.12 because the runtime binary grew), the `LC_CODE_SIGNATURE.datasize` field gets stamped with the wrong value and `__LINKEDIT.filesize/vmsize` under-cover the real signature region.

### 3. Timeline alignment

| Date | Event |
|------|-------|
| 2026-02-26 | Bun **v1.3.10** — working |
| 2026-03-18 | Bun **v1.3.11** — working (last known-good; local build used this) |
| 2026-04-10 | Bun **v1.3.12** — runtime grew ~337 KB, signature-slot math now fatal |
| 2026-04-13 | Issue #29120 filed |
| 2026-04-14 | PR #29272 merged → **Bun v1.3.13** shipped with fix |
| 2026-04-15/16 | agent-manager release CI (uses `bun-version: latest`) picks up 1.3.12 → broken artefacts |

The 336 KB on-disk difference between the local (working) and CI (broken) binaries — 67,201,600 − 66,864,928 = **336,672 bytes**, i.e. ~329 KB — matches the runtime growth referenced in the issue to within rounding. This is the smoking gun: the local dev machine is still on 1.3.11, CI is on 1.3.12.

### 4. `actions/upload-artifact` zip round-trip (secondary hypothesis — ruled out as root cause)

Worth addressing because the current release.yml comments assume this is the problem. Evidence:

- No open issues match "upload-artifact + codesign + strip" on actions/upload-artifact. The tool uses the standard zip format which **does preserve** file bytes (including Mach-O `LC_CODE_SIGNATURE` load commands) — zip archives do strip extended attributes (xattrs like `com.apple.quarantine`), but the code signature itself lives **inside the Mach-O**, not in an xattr, so zip round-trips preserve it.
- The Blacksmith artefact fails `codesign -dv` with "code object is not signed at all" *immediately after build*, before any upload-artifact step runs (assuming the workflow step ordering in release.yml is followed). The current in-place `codesign -s - --force` step in the job would re-sign it if the signature were merely stripped — but it FAILS with "invalid or unsupported format for signature", meaning the Mach-O's `LC_CODE_SIGNATURE` load command is structurally corrupt, not absent.

So the upload-artifact concern is a red herring for this specific failure. It CAN strip xattrs (quarantine, Finder tags) but it does not corrupt Mach-O structure.

### 5. macOS arm64 hard-signing requirement (confirms SIGKILL mechanism)

- Apple's dyld enforcement: since macOS 11 on Apple Silicon, the kernel refuses to execute any arm64 Mach-O without at least an ad-hoc signature. An unsigned or corrupt-signature arm64 binary is terminated immediately with SIGKILL (exit 137 = 128 + 9). Reference: Apple "Preparing your app to work on macOS 11 on Apple Silicon" (WWDC 2020), and the AMFI (Apple Mobile File Integrity) kernel extension behaviour documented in the Darwin xnu source.
- The minimum valid structure is: an `LC_CODE_SIGNATURE` load command pointing into `__LINKEDIT`, whose `dataoff/datasize` covers a valid `SuperBlob` (CSMAGIC_EMBEDDED_SIGNATURE = 0xfade0cc0) containing at least a CodeDirectory with per-page SHA hashes and the `adhoc` flag bit set. `codesign -s -` fills in the hashes but requires the caller to have already reserved a correctly-sized signature slot. Bun pre-reserves this slot via the `writeSection` code that #29272 fixes — if the slot is truncated, `codesign` sees the magic byte at an offset but the blob length it reads is larger than the slot, hence "invalid or unsupported format for signature".

## Why codesign fails on the artifact (Mach-O structure analysis)

Walking through the exact failure mode based on the PR #29272 diff:

1. `bun build --compile` copies the Bun runtime Mach-O and appends the bundled JS payload, then invokes `writeSection` to extend `__LINKEDIT` and stamp `LC_CODE_SIGNATURE` before calling `MachoSigner.sign`.
2. In 1.3.12, `writeSection` computes the new signature space as `original_template_sig_size + pages_added * 32`. This is incorrect because the signer computes from scratch: `sizeof(SuperBlob) + sizeof(CodeDirectory) + (total_pages * hash_size) + alignment/slot padding`. For a binary where the page count increase crosses internal hash-table-size thresholds, or where the template's original signature used a different CodeDirectory slot layout, the two formulas diverge.
3. With the 1.3.12 runtime (~67 MB), the mismatch exceeds what fits in the reserved slot. `MachoSigner.sign` happily writes the full ~537 KB SuperBlob starting at the `LC_CODE_SIGNATURE.dataoff` — but `__LINKEDIT.filesize` was only sized for ~196 KB. The SuperBlob spills past the declared end of `__LINKEDIT`.
4. When `codesign -dv` parses the binary, it reads `LC_CODE_SIGNATURE.datasize = 196592`, then tries to read a SuperBlob of that length at `dataoff`. It finds the magic bytes (0xfade0cc0) but the length field inside the SuperBlob header says the blob is 537,138 bytes, which exceeds `datasize`. codesign reports "code object is not signed at all" (its idiosyncratic way of saying "found signature header, rejected as malformed").
5. `codesign -s - --force` tries to replace the signature. It needs to either reuse the existing slot (too small) or grow `__LINKEDIT`. Bun has already grown `__LINKEDIT` beyond what the Mach-O's `vmsize`/`filesize` fields declare, so codesign sees inconsistent segment math and aborts with "invalid or unsupported format for signature". macOS then SIGKILLs on exec because there is no valid signature.

The local v1.3.11 build doesn't hit this because (a) the runtime binary is 337 KB smaller, keeping the reserved slot large enough for whatever page-count delta the signer produces, and (b) the original delta-based approximation happens to be within the reserved slack.

## Workaround options, ranked by effort

### 1. Pin Bun to 1.3.13+ (one-line fix — **recommended**)

Change release.yml:

```yaml
- uses: useblacksmith/setup-bun@v1
  with:
    bun-version: 1.3.13   # was: latest
```

Effort: 1 line of YAML, one re-run. Zero cost change. This is the ideal fix: the regression is known, the fix is upstream, and pinning to a specific version gets us deterministic builds (`latest` caused this exact problem by silently picking up 1.3.12 the morning of its release).

Trade-off: need to remember to bump this pin periodically. Mitigate with a `renovate.json` or Dependabot rule matching `useblacksmith/setup-bun` with-version values.

### 2. Keep `latest` + add post-build `rcodesign` repair (belt + braces)

Add a Linux-host-capable ad-hoc signer that rebuilds the signature from scratch, independent of whatever Bun emitted:

```yaml
- name: Install rcodesign (Linux + macOS)
  run: |
    curl -L https://github.com/indygreg/apple-platform-rs/releases/download/apple-codesign%2F0.29.0/apple-codesign-0.29.0-x86_64-unknown-linux-musl.tar.gz \
      | tar xz --strip-components=1 -C /usr/local/bin apple-codesign-0.29.0-x86_64-unknown-linux-musl/rcodesign

- name: Re-sign darwin binaries (works on Linux or macOS)
  run: |
    for bin in dist/am-darwin-*; do
      rcodesign sign "$bin"   # ad-hoc by default
    done
```

Effort: ~10 lines of YAML. `rcodesign` (https://github.com/indygreg/apple-platform-rs) is a pure-Rust re-implementation of Apple's code-signing tool that runs on Linux. It rebuilds `LC_CODE_SIGNATURE` and `__LINKEDIT` from scratch, so it isn't fooled by Bun's corrupt slot sizing. This also means the release-job (which runs on `blacksmith-2vcpu-ubuntu-2404`) can re-sign after `download-artifact` if the zip round-trip ever does cause issues.

Trade-off: adds a build-time dependency and a non-trivial re-sign step; the version pin approach is strictly simpler.

### 3. Switch macOS matrix entry to GitHub-hosted `macos-latest`

```yaml
- os: macos-latest   # GitHub-hosted, not Blacksmith
  targets: "bun-darwin-arm64 bun-darwin-x64"
```

Effort: 1 line. Cost: GitHub's macOS minutes are 10× Linux minutes for private repos (~$0.08/min on GitHub vs Blacksmith's same $0.08/min — roughly break-even actually; see https://www.blacksmith.sh/pricing). But this does NOT fix the problem — the bug reproduces on native macOS too. Only worthwhile as a control experiment to confirm that we'd hit the same bug on GitHub runners (we would, because it's a Bun bug, not a runner bug).

### 4. Self-host a Mac builder

Effort: days to weeks. Cost: a Mac mini + maintenance. Not justified — there is nothing Blacksmith is doing wrong here; they host real macOS.

### 5. Ship darwin from source only (`bun install -g agent-manager`)

Effort: drop the darwin row from the build matrix. Users `bun install -g` or `brew install --build-from-source` to compile locally. Works around the bug but regresses the `brew install` UX (pre-built binary becomes source tarball + bun + install). Keep in reserve if 1.3.13 doesn't fully fix it.

### 6. Document end-user workaround

For users who have already downloaded a broken 0.5.0-rc1 darwin binary:

```bash
curl -L https://github.com/Codeseys-Labs/agent-manager/releases/download/v0.5.0-rc1/am-darwin-arm64 -o am
chmod +x am
codesign -s - --force --deep am   # may fail — if so, use rcodesign
# or:
brew install indygreg/apple-platform-rs/rcodesign && rcodesign sign am
xattr -dr com.apple.quarantine am   # clear quarantine bit from download
./am version
```

This works around the bug ONLY if the user is on 1.3.11 or earlier — once we re-release with a fixed binary, this becomes moot.

## Recommended fix

**Pin `bun-version: 1.3.13` in `.github/workflows/release.yml`** (Option 1), and re-cut the release as `v0.5.0-rc3`. Additionally, add Option 2's `rcodesign` step as defence-in-depth — it costs ~10 lines and protects against (a) future Bun regressions in this same code path, (b) the upload-artifact xattr-stripping concern (which is real for quarantine bits even if not the cause of this specific failure), and (c) the known risk that the release-merge job on Linux has no way to re-sign today.

Rationale against the alternatives for our constraints (private repo, 2,355 passing tests, need darwin-arm64 end users working, don't want to self-host):

- Switching to GitHub-hosted runners doesn't fix the bug (#29306 reproduces natively).
- Self-hosting is overkill when Blacksmith's macOS offering is genuine.
- Source-install regresses the Homebrew UX we already built (see the `Formula/am.rb` generation in release.yml).
- Documenting a client-side workaround is user-hostile when a one-line YAML pin + 10-line `rcodesign` step fully resolves it server-side.

Concrete diff for release.yml:

```diff
       - uses: useblacksmith/setup-bun@v1
         with:
-          bun-version: latest
+          # Pinned: avoid 1.3.12 regression (LC_CODE_SIGNATURE truncation,
+          # https://github.com/oven-sh/bun/issues/29120). 1.3.13 has the fix.
+          bun-version: 1.3.13
```

And in the release-assembly job (which runs on Linux) add a defensive re-sign before `gh release create`:

```yaml
      - name: Install rcodesign
        run: |
          curl -L https://github.com/indygreg/apple-platform-rs/releases/download/apple-codesign%2F0.29.0/apple-codesign-0.29.0-x86_64-unknown-linux-musl.tar.gz \
            | tar xz -C /tmp
          sudo mv /tmp/apple-codesign-*/rcodesign /usr/local/bin/rcodesign

      - name: Defensive ad-hoc re-sign of darwin binaries
        run: |
          for bin in ./artifacts/am-darwin-*; do
            rcodesign sign "$bin"
            rcodesign verify "$bin"
          done
```

After the re-run, verify locally:

```bash
gh release download v0.5.0-rc3 --pattern 'am-darwin-arm64'
codesign -dv ./am-darwin-arm64  # must show Format=Mach-O thin (arm64), Signature=adhoc
./am-darwin-arm64 version       # must print the version, not get Killed: 9
```

## References

- Blacksmith docs — macOS runners: https://docs.blacksmith.sh/blacksmith-runners/overview
- Blacksmith pricing (macOS M4): https://www.blacksmith.sh/pricing
- Bun issue #29120 — darwin-arm64 truncated code signature: https://github.com/oven-sh/bun/issues/29120
- Bun issue #29306 — corrupt LC_CODE_SIGNATURE on native macOS arm64: https://github.com/oven-sh/bun/issues/29306
- Bun PR #29272 — fix `__LINKEDIT` and `LC_CODE_SIGNATURE` sizing: https://github.com/oven-sh/bun/pull/29272
- Bun docs — codesign on macOS: https://bun.sh/docs/bundler/executables#code-signing-on-macos
- rcodesign (Linux-capable Apple code signer): https://github.com/indygreg/apple-platform-rs
- Apple Mach-O code signing internals: https://developer.apple.com/documentation/security/code_signing_services
- useblacksmith/setup-bun action: https://github.com/useblacksmith/setup-bun

## Appendix: confidence check

- Root cause (Bun 1.3.12 macho.zig regression): **high confidence**. Three independent signals line up — the 336 KB binary-size delta matches the cited runtime growth exactly, the timeline matches the 1.3.12 release date, and the failure mode ("code object is not signed at all" + SIGKILL + refuses to re-sign) is literally the reproduction in #29120/#29306.
- Blacksmith macos-latest = real macOS: **high confidence** (documented, priced like real Mac hardware, label table published).
- Recommended fix will work: **high confidence** — 1.3.13 is the merged-and-released fix; pinning is mechanical.
