import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  expectedBetterleaksSha256,
  getBetterleaksPath,
  getBetterleaksVersion,
  isBetterleaksAvailable,
  platformBinaryName,
  scanWithBetterleaks,
  spawnFailed,
  verifyBetterleaksChecksum,
} from "../../src/core/betterleaks";

describe("betterleaks", () => {
  test("isBetterleaksAvailable returns a boolean", () => {
    const result = isBetterleaksAvailable();
    expect(typeof result).toBe("boolean");
  });

  test("getBetterleaksPath returns string or null", () => {
    const result = getBetterleaksPath();
    expect(result === null || typeof result === "string").toBe(true);
  });

  test("getBetterleaksVersion returns string or null", () => {
    const result = getBetterleaksVersion();
    expect(result === null || typeof result === "string").toBe(true);
  });

  test("scanWithBetterleaks with empty content returns empty array or null", () => {
    const result = scanWithBetterleaks("");
    // Returns null if betterleaks is not installed, empty array if installed
    if (result !== null) {
      expect(Array.isArray(result)).toBe(true);
      expect(result.length).toBe(0);
    } else {
      expect(result).toBeNull();
    }
  });

  test("scanWithBetterleaks with benign content returns no findings", () => {
    const result = scanWithBetterleaks("hello = world\nfoo = bar");
    if (result !== null) {
      expect(Array.isArray(result)).toBe(true);
      expect(result.length).toBe(0);
    } else {
      expect(result).toBeNull();
    }
  });

  test("availability and path are consistent", () => {
    const available = isBetterleaksAvailable();
    const path = getBetterleaksPath();
    if (available) {
      expect(path).not.toBeNull();
    }
    if (!path) {
      expect(available).toBe(false);
    }
  });
});

// seed 4b76 (a): the release-asset naming was wrong (`amd64`, no extension),
// pointing downloadUrl() at a 404 and never matching the pin map. The fixed
// name must use `x64`/`arm64` and carry the ARCHIVE extension (.tar.gz on
// darwin/linux, .zip on windows) — matching .github/workflows/ci.yml which
// downloads `betterleaks_<ver>_linux_x64.tar.gz`.
describe("betterleaks release-asset naming (seed 4b76)", () => {
  test("platformBinaryName uses x64/arm64 (never amd64) + an archive extension", () => {
    const name = platformBinaryName();
    // Never the broken `amd64` token.
    expect(name).not.toContain("amd64");
    // Always one of the two valid arch tokens.
    expect(/_(x64|arm64)(\.|$)/.test(name)).toBe(true);
    // Archive extension per platform.
    if (process.platform === "win32") {
      expect(name.endsWith(".zip")).toBe(true);
    } else {
      expect(name.endsWith(".tar.gz")).toBe(true);
    }
    // x64 hosts must produce the `_x64` token (regression on the amd64 bug).
    if (process.arch === "x64") {
      expect(name).toContain("_x64");
    }
  });

  test("downloadable asset name is keyed in the pin map (no 404 / no missing-pin)", () => {
    // The exact name we download must have a real digest in the built-in map.
    const pin = expectedBetterleaksSha256(platformBinaryName());
    expect(pin).toMatch(/^[0-9a-f]{64}$/);
  });
});

// P2-H: pinned-SHA-256 verification before chmod+exec.
describe("betterleaks checksum verification (P2-H)", () => {
  const ASSET = "betterleaks-test-asset";
  const payload = new TextEncoder().encode("fake-binary-bytes");
  const payloadSha = createHash("sha256").update(payload).digest("hex");
  // Variable-keyed env mutation (biome's noDelete allows a dynamic key).
  function setEnv(name: string, val: string | undefined) {
    if (val === undefined) delete process.env[name];
    else process.env[name] = val;
  }
  const orig: Record<string, string | undefined> = {
    AM_BETTERLEAKS_SHA256: process.env.AM_BETTERLEAKS_SHA256,
    AM_ALLOW_UNVERIFIED_BETTERLEAKS: process.env.AM_ALLOW_UNVERIFIED_BETTERLEAKS,
  };

  beforeEach(() => {
    setEnv("AM_BETTERLEAKS_SHA256", undefined);
    setEnv("AM_ALLOW_UNVERIFIED_BETTERLEAKS", undefined);
  });

  afterEach(() => {
    for (const [name, val] of Object.entries(orig)) setEnv(name, val);
  });

  test("FAILS CLOSED when no pin is available for an UNKNOWN asset", () => {
    // No env pin, and no built-in pin for an unknown (non-release) asset name
    // → must refuse. (Real release assets DO have pins; see the tests below.)
    const res = verifyBetterleaksChecksum(payload, ASSET);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toContain("No pinned SHA-256");
  });

  // seed 4b76 (b): the built-in pin map now carries REAL digests keyed on the
  // archive asset name platformBinaryName() produces. The current platform's
  // asset must resolve to a non-empty, well-formed 64-hex SHA-256 — without
  // any env override.
  test("the current platform's built-in pin is a real 64-hex digest (matches platformBinaryName)", () => {
    const pin = expectedBetterleaksSha256();
    expect(pin).not.toBeNull();
    expect(pin).toMatch(/^[0-9a-f]{64}$/);
    // And it must be keyed on EXACTLY the name platformBinaryName() produces.
    expect(expectedBetterleaksSha256(platformBinaryName())).toBe(pin);
  });

  test("matches an operator-supplied env pin", () => {
    process.env.AM_BETTERLEAKS_SHA256 = payloadSha;
    const res = verifyBetterleaksChecksum(payload, ASSET);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.sha256).toBe(payloadSha);
  });

  test("rejects a checksum mismatch (tampered/corrupt download)", () => {
    process.env.AM_BETTERLEAKS_SHA256 = "0".repeat(64);
    const res = verifyBetterleaksChecksum(payload, ASSET);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toContain("Checksum mismatch");
  });

  test("env pin is case-insensitive", () => {
    process.env.AM_BETTERLEAKS_SHA256 = payloadSha.toUpperCase();
    const res = verifyBetterleaksChecksum(payload, ASSET);
    expect(res.ok).toBe(true);
  });

  test("explicit AM_ALLOW_UNVERIFIED_BETTERLEAKS=1 opt-out bypasses the missing-pin gate", () => {
    process.env.AM_ALLOW_UNVERIFIED_BETTERLEAKS = "1";
    const res = verifyBetterleaksChecksum(payload, ASSET);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.sha256).toBe(payloadSha);
  });

  test("opt-out does NOT override a present-but-mismatched pin", () => {
    process.env.AM_ALLOW_UNVERIFIED_BETTERLEAKS = "1";
    process.env.AM_BETTERLEAKS_SHA256 = "0".repeat(64);
    const res = verifyBetterleaksChecksum(payload, ASSET);
    expect(res.ok).toBe(false);
  });

  // seed 4b76 (c): verify logic accepts matching bytes and rejects mismatched
  // bytes for a given digest — exercised offline with known bytes + their SHA
  // (no network download). The checksum is computed over the ARCHIVE bytes, so
  // this same logic gates the real archive in installBetterleaks().
  test("accepts when the digest matches the (archive) bytes, rejects when it does not", () => {
    const archiveBytes = new TextEncoder().encode("pretend-this-is-the-tar-gz-archive");
    const matchingSha = createHash("sha256").update(archiveBytes).digest("hex");

    // ACCEPT: digest is exactly the sha of the bytes.
    process.env.AM_BETTERLEAKS_SHA256 = matchingSha;
    const accepted = verifyBetterleaksChecksum(archiveBytes, ASSET);
    expect(accepted.ok).toBe(true);
    if (accepted.ok) expect(accepted.sha256).toBe(matchingSha);

    // REJECT: same bytes, a different (valid-shaped) digest.
    const wrongSha = "f".repeat(64);
    expect(wrongSha).not.toBe(matchingSha);
    process.env.AM_BETTERLEAKS_SHA256 = wrongSha;
    const rejected = verifyBetterleaksChecksum(archiveBytes, ASSET);
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) {
      expect(rejected.reason).toContain("Checksum mismatch");
      expect(rejected.sha256).toBe(matchingSha); // observed digest is the real one
    }
  });
});

// Silent-failure fix: a crashed/timed-out/non-zero betterleaks run must signal
// UNAVAILABLE (null) — NOT a false-clean empty-findings ([]) result. With
// `--exit-code 0` passed, a non-zero status genuinely means the tool failed.
describe("betterleaks scan failure ⇒ null (distinct from clean empty scan)", () => {
  describe("spawnFailed classifier", () => {
    test("clean successful run (status 0, no error/signal) is NOT a failure", () => {
      expect(spawnFailed({ status: 0, signal: null })).toBe(false);
    });

    test("non-zero exit status IS a failure (tool error under --exit-code 0)", () => {
      expect(spawnFailed({ status: 1, signal: null })).toBe(true);
      expect(spawnFailed({ status: 2, signal: null })).toBe(true);
    });

    test("spawn/timeout error IS a failure", () => {
      // Node populates result.error on spawn failure and on timeout.
      expect(spawnFailed({ error: new Error("spawn ENOENT"), status: null })).toBe(true);
      expect(spawnFailed({ error: new Error("ETIMEDOUT") })).toBe(true);
    });

    test("killed by signal IS a failure (timeout SIGTERM / maxBuffer overflow)", () => {
      expect(spawnFailed({ signal: "SIGTERM", status: null })).toBe(true);
      expect(spawnFailed({ signal: "SIGKILL", status: null })).toBe(true);
    });
  });

  describe("scanWithBetterleaks end-to-end against a failing shim binary", () => {
    let tmp: string;
    const origPath = process.env.PATH;

    function installShim(name: string, scriptBody: string) {
      // On Windows the resolver looks for betterleaks.exe; these POSIX shims
      // only exercise the failure path on Unix. The classifier tests above
      // cover the platform-agnostic logic.
      const binPath = join(tmp, name);
      writeFileSync(binPath, scriptBody, { mode: 0o755 });
      chmodSync(binPath, 0o755);
      process.env.PATH = `${tmp}:${origPath}`;
    }

    beforeEach(() => {
      tmp = mkdtempSync(join(tmpdir(), "am-betterleaks-shim-"));
    });

    afterEach(() => {
      process.env.PATH = origPath;
      try {
        rmSync(tmp, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
    });

    // We PREPEND our tmp dir to PATH (installShim), so our shim should win the
    // bare-name resolution. Run the e2e assertions ONLY when our shim is what
    // actually resolves — and SKIP when something else shadows it: a managed
    // install (getBetterleaksPath checks resolveConfigDir()/bin FIRST), or a
    // real `betterleaks` that out-resolves the shim. We can't tell shim-from-real
    // by the bare "betterleaks" return value, so we PROBE: the shim prints a
    // unique sentinel on `version`; only if `betterleaks version` echoes it do we
    // proceed. IMPORTANT: the probe (like getBetterleaksPath, post-fix) MUST pass
    // `env: process.env` — Bun's spawnSync resolves a bare name against the
    // launch-time PATH snapshot, not the live process.env.PATH, so without `env`
    // the prepended shim is invisible and these tests would silently skip
    // EVERYWHERE (the bug this probe + the production env-fix jointly close). The
    // 4 spawnFailed classifier unit tests above lock the decision logic
    // regardless of whether this integration layer runs.
    const SHIM_SENTINEL = "am-shim-betterleaks-2f1c";
    function shimResolves(): boolean {
      if (getBetterleaksPath() === null) return false;
      const probe = spawnSync("betterleaks", ["version"], {
        stdio: "pipe",
        timeout: 5000,
        env: process.env,
      });
      return (probe.stdout?.toString() ?? "").includes(SHIM_SENTINEL);
    }

    test("non-zero exit (with empty stdout) returns null, NOT []", () => {
      if (process.platform === "win32") return; // POSIX shim only
      // `version` must exit 0 so getBetterleaksPath() resolves the shim; the
      // real `stdin` scan exits non-zero with empty stdout — the silent-failure
      // case. Before the fix this reported [] (false-clean).
      installShim(
        "betterleaks",
        `#!/bin/sh\nif [ "$1" = "version" ]; then echo "betterleaks 1.1.1 ${SHIM_SENTINEL}"; exit 0; fi\nexit 3\n`,
      );
      if (!shimResolves()) return; // a real managed/base-PATH install shadows the shim
      const result = scanWithBetterleaks("token = abc123");
      expect(result).toBeNull();
    });

    test("successful run with empty findings returns [] (genuinely clean, not failure)", () => {
      if (process.platform === "win32") return; // POSIX shim only
      installShim(
        "betterleaks",
        `#!/bin/sh\nif [ "$1" = "version" ]; then echo "betterleaks 1.1.1 ${SHIM_SENTINEL}"; exit 0; fi\necho "[]"; exit 0\n`,
      );
      if (!shimResolves()) return; // a real managed/base-PATH install shadows the shim
      const result = scanWithBetterleaks("hello = world");
      expect(Array.isArray(result)).toBe(true);
      expect(result).toEqual([]);
    });

    test("clean exit but non-JSON garbage output returns null (not false-clean [])", () => {
      if (process.platform === "win32") return; // POSIX shim only
      installShim(
        "betterleaks",
        `#!/bin/sh\nif [ "$1" = "version" ]; then echo "betterleaks 1.1.1 ${SHIM_SENTINEL}"; exit 0; fi\necho "PANIC: not json"; exit 0\n`,
      );
      if (!shimResolves()) return; // a real managed/base-PATH install shadows the shim
      const result = scanWithBetterleaks("token = abc123");
      expect(result).toBeNull();
    });
  });
});
