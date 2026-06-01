import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { DetectResult } from "../types.ts";

/**
 * Detect whether Gemini CLI is installed and discover config paths.
 *
 * @param homeDir - Override home directory (useful for testing)
 * @param projectPath - Optional project directory to check for project-level configs
 */
export function detect(homeDir?: string, projectPath?: string): DetectResult {
  const home = homeDir ?? homedir();
  const paths: Record<string, string> = {};

  // Global config directory: ~/.gemini/
  const configDir = join(home, ".gemini");
  if (existsSync(configDir)) {
    paths.configDir = configDir;
  }

  // Global settings: ~/.gemini/settings.json
  const globalSettings = join(home, ".gemini", "settings.json");
  if (existsSync(globalSettings)) {
    paths.globalSettings = globalSettings;
  }

  const installed = "configDir" in paths || "globalSettings" in paths;

  // Try to get version
  let version: string | undefined;
  if (installed) {
    version = getGeminiVersion();
  }

  // Project-level paths
  if (projectPath) {
    const projectSettings = join(projectPath, ".gemini", "settings.json");
    if (existsSync(projectSettings)) {
      paths.projectSettings = projectSettings;
    }

    const geminiMd = join(projectPath, "GEMINI.md");
    if (existsSync(geminiMd)) {
      paths.geminiMd = geminiMd;
    }
  }

  return { installed, version, paths };
}

function getGeminiVersion(): string | undefined {
  try {
    const proc = Bun.spawnSync(["gemini", "--version"], {
      stdout: "pipe",
      stderr: "pipe",
      // stdin must be detached: a CLI that blocks reading stdin would hang
      // the synchronous spawn (and the single-threaded test event loop).
      stdin: "ignore",
      // Cap the probe: a slow / hung CLI must not block tool detection.
      timeout: 2000,
    });
    if (proc.exitCode === 0) {
      return proc.stdout.toString().trim();
    }
  } catch {
    // gemini CLI not in PATH — that's fine, installed detection is file-based
  }
  return undefined;
}
