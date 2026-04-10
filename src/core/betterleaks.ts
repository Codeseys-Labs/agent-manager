import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { resolveConfigDir } from "./config";

const BETTERLEAKS_VERSION = "1.1.1";
const GITHUB_REPO = "betterleaks/betterleaks";

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
    const { writeFile } = await import("node:fs/promises");
    await writeFile(binPath, Buffer.from(buffer));

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
