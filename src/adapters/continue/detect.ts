import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { DetectResult } from "../types.ts";

/**
 * Detect whether Continue is installed and discover config paths.
 *
 * Checks for ~/.continue/ directory and config.json (deprecated but still read).
 *
 * @param homeDir - Override home directory (useful for testing)
 * @param projectPath - Optional project directory to check for project-level configs
 */
export function detect(homeDir?: string, projectPath?: string): DetectResult {
  const home = homeDir ?? homedir();
  const paths: Record<string, string> = {};

  // Global config dir: ~/.continue/
  const continueDir = join(home, ".continue");
  if (existsSync(continueDir)) {
    paths.configDir = continueDir;
  }

  // Global config.json (deprecated but still read by Continue)
  const configJson = join(continueDir, "config.json");
  if (existsSync(configJson)) {
    paths.globalConfig = configJson;
  }

  const installed = "configDir" in paths || "globalConfig" in paths;

  // Project-level paths
  if (projectPath) {
    // .continue/config.json
    const projectConfig = join(projectPath, ".continue", "config.json");
    if (existsSync(projectConfig)) {
      paths.projectConfig = projectConfig;
    }
  }

  return { installed, paths };
}
