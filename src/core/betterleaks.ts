import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync } from "node:fs";
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
 * Keyed by the release asset filename (`platformBinaryName()`), value is the
 * lowercase hex SHA-256 of that asset.
 *
 * TODO(P2-H): populate with the REAL upstream checksums for
 * betterleaks v1.1.1. These cannot be obtained offline; until they are filled
 * in, every platform's pin is the empty-string sentinel and installation
 * FAILS CLOSED (see `verifyChecksum`) unless the operator supplies the
 * expected digest out-of-band via `AM_BETTERLEAKS_SHA256` or explicitly
 * accepts the risk via `AM_ALLOW_UNVERIFIED_BETTERLEAKS=1`.
 */
const BETTERLEAKS_SHA256: Record<string, string> = {
  [`betterleaks_${BETTERLEAKS_VERSION}_darwin_arm64`]: "",
  [`betterleaks_${BETTERLEAKS_VERSION}_darwin_amd64`]: "",
  [`betterleaks_${BETTERLEAKS_VERSION}_linux_arm64`]: "",
  [`betterleaks_${BETTERLEAKS_VERSION}_linux_amd64`]: "",
  [`betterleaks_${BETTERLEAKS_VERSION}_windows_arm64.exe`]: "",
  [`betterleaks_${BETTERLEAKS_VERSION}_windows_amd64.exe`]: "",
};

/** Where we store the managed betterleaks binary */
function betterleaksBinDir(): string {
  return join(resolveConfigDir(), "bin");
}

function betterleaksBinPath(): string {
  const ext = process.platform === "win32" ? ".exe" : "";
  return join(betterleaksBinDir(), `betterleaks${ext}`);
}

/** Check if betterleaks is available (either on PATH or managed install) */
export function isBetterleaksAvailable(): boolean {
  // Check managed install first
  if (existsSync(betterleaksBinPath())) return true;

  // Check PATH
  try {
    const result = spawnSync("betterleaks", ["version"], { stdio: "pipe", timeout: 5000 });
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
    const result = spawnSync("betterleaks", ["version"], { stdio: "pipe", timeout: 5000 });
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
    const result = spawnSync(bin, ["version"], { stdio: "pipe", timeout: 5000 });
    return result.stdout?.toString().trim() || null;
  } catch {
    return null;
  }
}

/** Determine the correct binary name for this platform */
function platformBinaryName(): string {
  const os = process.platform;
  const arch = process.arch;

  let osStr: string;
  if (os === "darwin") osStr = "darwin";
  else if (os === "win32") osStr = "windows";
  else osStr = "linux";

  let archStr: string;
  if (arch === "arm64") archStr = "arm64";
  else archStr = "amd64";

  const ext = os === "win32" ? ".exe" : "";
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
 * Install betterleaks into the agent-manager config directory.
 * Downloads the binary from GitHub releases and verifies it runs.
 */
export async function installBetterleaks(): Promise<{
  success: boolean;
  path: string;
  error?: string;
}> {
  const binDir = betterleaksBinDir();
  const binPath = betterleaksBinPath();
  const url = downloadUrl();

  mkdirSync(binDir, { recursive: true });

  try {
    // Download using fetch (Bun native)
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

    // P2-H: verify the pinned SHA-256 BEFORE the binary is written
    // executable. Fail-closed — never chmod+exec an unverified download.
    const check = verifyBetterleaksChecksum(bytes);
    if (!check.ok) {
      return { success: false, path: binPath, error: check.reason };
    }

    const { writeFile } = await import("node:fs/promises");
    await writeFile(binPath, Buffer.from(bytes));

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
 * Scan text content using betterleaks stdin mode.
 * Returns parsed findings or null if betterleaks is not available.
 */
export function scanWithBetterleaks(content: string): BetterleaksFinding[] | null {
  const bin = getBetterleaksPath();
  if (!bin) return null;

  try {
    const result = spawnSync(
      bin,
      ["stdin", "--no-banner", "--no-color", "--report-format", "json", "--exit-code", "0"],
      {
        input: content,
        stdio: ["pipe", "pipe", "pipe"],
        timeout: 30000,
        maxBuffer: 10 * 1024 * 1024, // 10MB
      },
    );

    const stdout = result.stdout?.toString().trim();
    if (!stdout || stdout === "[]" || stdout === "null") return [];

    try {
      return JSON.parse(stdout) as BetterleaksFinding[];
    } catch {
      // Couldn't parse JSON output
      return [];
    }
  } catch {
    return null;
  }
}

/**
 * Scan a TOML config file using betterleaks dir mode.
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
        "--exit-code",
        "0",
      ],
      {
        stdio: ["pipe", "pipe", "pipe"],
        timeout: 30000,
      },
    );

    const stdout = result.stdout?.toString().trim();
    if (!stdout || stdout === "[]" || stdout === "null") return [];

    try {
      return JSON.parse(stdout) as BetterleaksFinding[];
    } catch {
      return [];
    }
  } catch {
    return null;
  }
}
