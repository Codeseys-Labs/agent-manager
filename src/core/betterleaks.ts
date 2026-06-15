import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveConfigDir } from "./config";

const BETTERLEAKS_VERSION = "1.1.1";
const GITHUB_REPO = "betterleaks/betterleaks";

/**
 * Pinned SHA-256 checksums per release asset (P2-H supply-chain fix).
 *
 * SECURITY.md §6 and ADR-0042 require pin-by-hash for any downloaded,
 * executed artifact. Until now `installBetterleaks` chmod+exec'd a freshly
 * downloaded GitHub-release binary with NO integrity check, so a compromised
 * release or a MITM on the redirect chain meant code execution in the user's
 * config dir.
 *
 * Keyed by the release ARCHIVE asset filename (`platformBinaryName()`), value
 * is the lowercase hex SHA-256 of that ARCHIVE. Upstream releases the binary
 * inside a `.tar.gz` (darwin/linux) or `.zip` (windows) archive — the asset
 * names use `x64`/`arm64` (NOT `amd64`) and carry the archive extension. The
 * checksum is computed over the archive bytes (matching the upstream
 * `checksums.txt`), and `installBetterleaks` verifies BEFORE extracting the
 * `betterleaks` binary out of the archive.
 *
 * Digests below are verified dual-source (gh release API + the v1.1.1
 * `checksums.txt`).
 */
const BETTERLEAKS_SHA256: Record<string, string> = {
  [`betterleaks_${BETTERLEAKS_VERSION}_darwin_arm64.tar.gz`]:
    "81eb78a8328f9159421855f282a03ad40c2cfeaa7c7a79f4c42308d705be31c4",
  [`betterleaks_${BETTERLEAKS_VERSION}_darwin_x64.tar.gz`]:
    "9462919fc8b625cc86f5ca216a0ca8366b1492c795f2a52710338e38875078f4",
  [`betterleaks_${BETTERLEAKS_VERSION}_linux_arm64.tar.gz`]:
    "97b774367630846a5f2298f7f3e3f8096f0567d3fc0275b1b63c0e1e16f856f1",
  [`betterleaks_${BETTERLEAKS_VERSION}_linux_x64.tar.gz`]:
    "d590d5f051e49f6769c61dc8cebbce947b20a4042e2915ee234760f81a01c8c4",
  [`betterleaks_${BETTERLEAKS_VERSION}_windows_arm64.zip`]:
    "27897dbe70defaa8ce5e2d0cbbcdbe49708376def2e8ec91ea48d39aa44b6440",
  [`betterleaks_${BETTERLEAKS_VERSION}_windows_x64.zip`]:
    "df3078b80fe0ec9144b10e34b1e29779f1e0e4ad5cbba430eea240b6a3894d70",
};

/** Where we store the managed betterleaks binary */
function betterleaksBinDir(): string {
  return join(resolveConfigDir(), "bin");
}

function betterleaksBinPath(): string {
  const ext = process.platform === "win32" ? ".exe" : "";
  return join(betterleaksBinDir(), `betterleaks${ext}`);
}

// Bun's spawnSync resolves a BARE command name against the PATH snapshot taken
// at process launch, NOT the live `process.env.PATH`. Without passing `env`
// explicitly, a betterleaks installed into a dir added to PATH within this
// process (or any in-process PATH mutation) is invisible — the scan silently
// reports UNAVAILABLE. Passing `env: process.env` makes resolution honor the
// current PATH. Centralized here so every bare-name spawn is consistent.
const SPAWN_ENV = { env: process.env } as const;

/** Check if betterleaks is available (either on PATH or managed install) */
export function isBetterleaksAvailable(): boolean {
  // Check managed install first
  if (existsSync(betterleaksBinPath())) return true;

  // Check PATH
  try {
    const result = spawnSync("betterleaks", ["version"], {
      stdio: "pipe",
      timeout: 5000,
      ...SPAWN_ENV,
    });
    return result.status === 0 && !result.error;
  } catch {
    return false;
  }
}

/** Get the betterleaks binary path (managed or PATH) */
export function getBetterleaksPath(): string | null {
  const managed = betterleaksBinPath();
  if (existsSync(managed)) return managed;

  // Check PATH
  try {
    const result = spawnSync("betterleaks", ["version"], {
      stdio: "pipe",
      timeout: 5000,
      ...SPAWN_ENV,
    });
    if (result.status === 0) return "betterleaks";
  } catch {
    /* not on PATH */
  }

  return null;
}

/** Get betterleaks version string */
export function getBetterleaksVersion(): string | null {
  const bin = getBetterleaksPath();
  if (!bin) return null;

  try {
    const result = spawnSync(bin, ["version"], { stdio: "pipe", timeout: 5000, ...SPAWN_ENV });
    return result.stdout?.toString().trim() || null;
  } catch {
    return null;
  }
}

/**
 * Determine the correct release ARCHIVE asset name for this platform.
 *
 * Upstream v1.1.1 assets are named e.g. `betterleaks_1.1.1_linux_x64.tar.gz`
 * — the arch is `x64`/`arm64` (NOT node's `x64`/`arm64`→`amd64` rename), and
 * the artifact is a `.tar.gz` (darwin/linux) or `.zip` (windows) ARCHIVE, not
 * a bare executable. The CI workflow (.github/workflows/ci.yml) downloads
 * `betterleaks_${VER}_linux_x64.tar.gz` — this is the canonical naming.
 */
export function platformBinaryName(): string {
  const os = process.platform;
  const arch = process.arch;

  let osStr: string;
  if (os === "darwin") osStr = "darwin";
  else if (os === "win32") osStr = "windows";
  else osStr = "linux";

  // node's process.arch reports "x64" for 64-bit Intel/AMD; betterleaks assets
  // use "x64" too (the old "amd64" mapping pointed at a non-existent asset).
  const archStr = arch === "arm64" ? "arm64" : "x64";

  const ext = os === "win32" ? ".zip" : ".tar.gz";
  return `betterleaks_${BETTERLEAKS_VERSION}_${osStr}_${archStr}${ext}`;
}

/** Download URL for the current platform */
function downloadUrl(): string {
  const name = platformBinaryName();
  return `https://github.com/${GITHUB_REPO}/releases/download/v${BETTERLEAKS_VERSION}/${name}`;
}

/**
 * Resolve the expected SHA-256 for the current platform's asset.
 *
 * Priority:
 *   1. `AM_BETTERLEAKS_SHA256` env var (operator-supplied out-of-band pin),
 *   2. the built-in `BETTERLEAKS_SHA256` pin map.
 *
 * Returns `null` when no non-empty pin is available — the caller treats that
 * as "unverifiable" and FAILS CLOSED.
 */
export function expectedBetterleaksSha256(assetName = platformBinaryName()): string | null {
  const envPin = process.env.AM_BETTERLEAKS_SHA256?.trim().toLowerCase();
  if (envPin) return envPin;
  const pinned = BETTERLEAKS_SHA256[assetName]?.trim().toLowerCase();
  return pinned ? pinned : null;
}

/** Outcome of a pre-exec checksum check. */
export type ChecksumResult =
  | { ok: true; sha256: string }
  | { ok: false; reason: string; sha256: string };

/**
 * Verify a downloaded binary's SHA-256 against the platform pin BEFORE it is
 * ever made executable (P2-H). Fail-closed semantics:
 *
 *   - pin present + match   → ok
 *   - pin present + mismatch → reject (tampered / wrong asset)
 *   - pin absent            → reject UNLESS the operator explicitly opts out
 *     via `AM_ALLOW_UNVERIFIED_BETTERLEAKS=1` (documented escape hatch). We do
 *     NOT silently trust an unpinned binary — that is the whole point.
 */
export function verifyBetterleaksChecksum(
  data: Uint8Array,
  assetName = platformBinaryName(),
): ChecksumResult {
  const actual = createHash("sha256").update(data).digest("hex").toLowerCase();
  const expected = expectedBetterleaksSha256(assetName);

  if (!expected) {
    if (process.env.AM_ALLOW_UNVERIFIED_BETTERLEAKS === "1") {
      return { ok: true, sha256: actual };
    }
    return {
      ok: false,
      sha256: actual,
      reason: `No pinned SHA-256 is available for "${assetName}" — refusing to install an unverified executable. Supply the expected digest via AM_BETTERLEAKS_SHA256, or set AM_ALLOW_UNVERIFIED_BETTERLEAKS=1 to bypass at your own risk. (Observed digest: sha256:${actual})`,
    };
  }

  if (actual !== expected) {
    return {
      ok: false,
      sha256: actual,
      reason: `Checksum mismatch for "${assetName}": expected sha256:${expected}, got sha256:${actual}. The download may be corrupt or tampered with — refusing to install.`,
    };
  }

  return { ok: true, sha256: actual };
}

/**
 * Extract the `betterleaks` executable from a release ARCHIVE into `destPath`.
 *
 * Upstream ships the binary inside a `.tar.gz` (darwin/linux) or `.zip`
 * (windows) archive, with the binary named `betterleaks` (unix) or
 * `betterleaks.exe` (windows) at the archive root. We write the archive bytes
 * to a temp file (already checksum-verified by the caller), shell out to the
 * platform-standard extractor (`tar -xzf` / `unzip`), and copy the extracted
 * binary to `destPath`. The temp dir is always cleaned up.
 *
 * Returns `{ ok: true }` on success or `{ ok: false, error }` describing the
 * failure (missing extractor, archive without the expected entry, etc.).
 */
function extractBetterleaksBinary(
  archiveBytes: Uint8Array,
  isZip: boolean,
  destPath: string,
): { ok: true } | { ok: false; error: string } {
  const work = mkdtempSync(join(tmpdir(), "am-betterleaks-extract-"));
  const entryName = process.platform === "win32" ? "betterleaks.exe" : "betterleaks";
  try {
    const archivePath = join(work, isZip ? "archive.zip" : "archive.tar.gz");
    const { writeFileSync, copyFileSync } = require("node:fs") as typeof import("node:fs");
    writeFileSync(archivePath, Buffer.from(archiveBytes));

    // Extract just the betterleaks binary into the work dir.
    const extract = isZip
      ? // -o overwrite, -j junk paths (binary lands directly in `work`),
        // -d destination dir. `unzip` is present on the windows runner via
        // bundled tooling; on unix it's the standard zip extractor.
        spawnSync("unzip", ["-o", "-j", archivePath, entryName, "-d", work], {
          stdio: "pipe",
          timeout: 30000,
          ...SPAWN_ENV,
        })
      : // tar is universal on darwin/linux (and present on the windows runner).
        spawnSync("tar", ["-xzf", archivePath, "-C", work, entryName], {
          stdio: "pipe",
          timeout: 30000,
          ...SPAWN_ENV,
        });

    if (extract.error || (typeof extract.status === "number" && extract.status !== 0)) {
      const stderr = extract.stderr?.toString().trim();
      const reason = extract.error ? extract.error.message : `exit ${extract.status}`;
      return {
        ok: false,
        error: `Failed to extract betterleaks from archive (${reason})${stderr ? `: ${stderr}` : ""}`,
      };
    }

    const extracted = join(work, entryName);
    if (!existsSync(extracted)) {
      return {
        ok: false,
        error: `Archive did not contain the expected "${entryName}" entry`,
      };
    }

    copyFileSync(extracted, destPath);
    return { ok: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: msg };
  } finally {
    try {
      rmSync(work, { recursive: true, force: true });
    } catch {
      /* best-effort temp cleanup */
    }
  }
}

/**
 * Install betterleaks into the agent-manager config directory.
 *
 * Flow (P2-H supply-chain): download the release ARCHIVE → verify the pinned
 * SHA-256 over the ARCHIVE bytes (fail-closed BEFORE anything is extracted or
 * made executable) → extract the `betterleaks` binary out of the archive →
 * chmod+exec → verify it runs.
 */
export async function installBetterleaks(): Promise<{
  success: boolean;
  path: string;
  error?: string;
}> {
  const binDir = betterleaksBinDir();
  const binPath = betterleaksBinPath();
  const url = downloadUrl();
  const isZip = process.platform === "win32";

  mkdirSync(binDir, { recursive: true });

  try {
    // Download the ARCHIVE using fetch (Bun native)
    const response = await fetch(url, { redirect: "follow" });
    if (!response.ok) {
      return {
        success: false,
        path: binPath,
        error: `Download failed: HTTP ${response.status} from ${url}`,
      };
    }

    const buffer = await response.arrayBuffer();
    const bytes = new Uint8Array(buffer);

    // P2-H: verify the pinned SHA-256 over the ARCHIVE bytes BEFORE we extract
    // or exec anything. The pin map is keyed on the archive asset name and the
    // digest is over the archive, so this now matches. Fail-closed — never
    // extract+exec an unverified download.
    const check = verifyBetterleaksChecksum(bytes);
    if (!check.ok) {
      return { success: false, path: binPath, error: check.reason };
    }

    // Extract the binary out of the verified archive into the managed bin dir.
    const extracted = extractBetterleaksBinary(bytes, isZip, binPath);
    if (!extracted.ok) {
      return { success: false, path: binPath, error: extracted.error };
    }

    // Make executable on Unix
    if (process.platform !== "win32") {
      chmodSync(binPath, 0o755);
    }

    // Verify it runs
    const result = spawnSync(binPath, ["version"], { stdio: "pipe", timeout: 10000 });
    if (result.status !== 0) {
      return {
        success: false,
        path: binPath,
        error: "Downloaded binary failed verification check",
      };
    }

    return { success: true, path: binPath };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { success: false, path: binPath, error: msg };
  }
}

export interface BetterleaksFinding {
  RuleID: string;
  Description: string;
  Secret: string;
  Match: string;
  File: string;
  Line: number;
  StartColumn: number;
  EndColumn: number;
  Entropy: number;
}

/**
 * Did a spawnSync invocation fail to *complete a clean run*?
 *
 * We pass `--exit-code 0` so betterleaks returns 0 even when it finds secrets;
 * therefore any of the following genuinely means the tool itself failed (it
 * did NOT successfully scan), and an empty stdout MUST NOT be read as
 * "no secrets found":
 *
 *   - result.error      → failed to spawn, or timed out (Node populates .error
 *                         with an ETIMEDOUT-style error on timeout)
 *   - result.signal     → killed by a signal (e.g. SIGTERM on timeout, or
 *                         maxBuffer overflow which terminates the child)
 *   - result.status !==0 → non-zero exit; with --exit-code 0 this can only be a
 *                         tool-level failure (bad args, crash, panic)
 *
 * Returns true when the scan is UNAVAILABLE (failed) and callers should treat
 * the result as null rather than an authoritative clean scan.
 */
export function spawnFailed(result: {
  error?: Error;
  signal?: NodeJS.Signals | null;
  status?: number | null;
}): boolean {
  if (result.error) return true;
  if (result.signal) return true;
  // status is null when the process was signaled (covered above); a non-zero
  // numeric status is a genuine tool failure under --exit-code 0.
  if (typeof result.status === "number" && result.status !== 0) return true;
  return false;
}

/**
 * Scan text content using betterleaks stdin mode.
 *
 * Returns:
 *   - `BetterleaksFinding[]` — successful scan (possibly empty = genuinely no
 *     inline secrets found)
 *   - `null` — scan UNAVAILABLE: betterleaks not installed, OR the subprocess
 *     crashed / timed out / was signaled / exited non-zero (silent-failure
 *     fix). Callers null-check and surface "Tier-2 scan failed" instead of
 *     asserting a false-clean. An empty-stdout-on-success run still returns
 *     `[]`, distinct from this failure signal.
 */
export function scanWithBetterleaks(content: string): BetterleaksFinding[] | null {
  const bin = getBetterleaksPath();
  if (!bin) return null;

  try {
    const result = spawnSync(
      bin,
      // `--report-path -` is REQUIRED: without it betterleaks writes findings to
      // a default report FILE and emits nothing on stdout, so the `if (!stdout)`
      // check below silently returns [] even when a secret IS present — the
      // Tier-2 scan was dead. `-` directs the JSON report to stdout.
      [
        "stdin",
        "--no-banner",
        "--no-color",
        "--report-format",
        "json",
        "--report-path",
        "-",
        "--exit-code",
        "0",
      ],
      {
        input: content,
        stdio: ["pipe", "pipe", "pipe"],
        timeout: 30000,
        maxBuffer: 10 * 1024 * 1024, // 10MB
        ...SPAWN_ENV,
      },
    );

    // Silent-failure fix: a crashed/timed-out/non-zero run leaves stdout empty.
    // Returning [] here would report ZERO findings — indistinguishable from a
    // genuinely clean scan. Signal unavailable (null) so callers don't assert
    // false-clean Tier-2 coverage.
    if (spawnFailed(result)) return null;

    const stdout = result.stdout?.toString().trim();
    if (!stdout || stdout === "[]" || stdout === "null") return [];

    try {
      return JSON.parse(stdout) as BetterleaksFinding[];
    } catch {
      // Ran cleanly (exit 0) but emitted non-JSON output we can't interpret as
      // findings. Treat as unavailable rather than asserting "no secrets" — a
      // garbled report is not evidence of a clean config.
      return null;
    }
  } catch {
    return null;
  }
}

/**
 * Scan a TOML config file using betterleaks dir mode.
 *
 * Same return contract as `scanWithBetterleaks`: `BetterleaksFinding[]` on a
 * successful scan (empty = no findings), `null` when the scan is UNAVAILABLE
 * (binary missing, or the subprocess crashed / timed out / was signaled /
 * exited non-zero). Distinguishes failure from a genuinely clean scan.
 */
export function scanFileWithBetterleaks(filePath: string): BetterleaksFinding[] | null {
  const bin = getBetterleaksPath();
  if (!bin) return null;

  try {
    const result = spawnSync(
      bin,
      [
        "dir",
        "--source",
        filePath,
        "--no-banner",
        "--no-color",
        "--report-format",
        "json",
        // See scanWithBetterleaks: `-` sends the JSON report to stdout instead
        // of a default report file (without it, findings never reach us).
        "--report-path",
        "-",
        "--exit-code",
        "0",
      ],
      {
        stdio: ["pipe", "pipe", "pipe"],
        timeout: 30000,
        ...SPAWN_ENV,
      },
    );

    // Silent-failure fix: signal unavailable (null) rather than false-clean ([])
    // when the run did not complete successfully.
    if (spawnFailed(result)) return null;

    const stdout = result.stdout?.toString().trim();
    if (!stdout || stdout === "[]" || stdout === "null") return [];

    try {
      return JSON.parse(stdout) as BetterleaksFinding[];
    } catch {
      return null;
    }
  } catch {
    return null;
  }
}
