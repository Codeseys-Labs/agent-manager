import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { DetectResult } from "../types.ts";

/**
 * Detect whether Continue is installed and discover config paths.
 *
 * Continue has migrated from `config.json` to `config.yaml` (since 0.10.x).
 * We probe for both:
 *   - Modern: `~/.continue/config.yaml` and `.continue/mcpServers/*.yaml`
 *   - Legacy: `~/.continue/config.json` (emits deprecation warning at import)
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

  // Modern: ~/.continue/config.yaml
  const globalYaml = join(continueDir, "config.yaml");
  if (existsSync(globalYaml)) {
    paths.globalConfigYaml = globalYaml;
  }

  // Legacy: ~/.continue/config.json (deprecated)
  const globalJson = join(continueDir, "config.json");
  if (existsSync(globalJson)) {
    paths.globalConfigJson = globalJson;
  }

  // Per-server YAML blocks: ~/.continue/mcpServers/
  const globalMcpDir = join(continueDir, "mcpServers");
  if (existsSync(globalMcpDir) && isDir(globalMcpDir)) {
    paths.globalMcpServersDir = globalMcpDir;
  }

  const installed =
    "configDir" in paths ||
    "globalConfigYaml" in paths ||
    "globalConfigJson" in paths ||
    "globalMcpServersDir" in paths;

  // Project-level paths
  if (projectPath) {
    const projectYaml = join(projectPath, ".continue", "config.yaml");
    if (existsSync(projectYaml)) {
      paths.projectConfigYaml = projectYaml;
    }

    const projectJson = join(projectPath, ".continue", "config.json");
    if (existsSync(projectJson)) {
      paths.projectConfigJson = projectJson;
    }

    const projectMcpDir = join(projectPath, ".continue", "mcpServers");
    if (existsSync(projectMcpDir) && isDir(projectMcpDir)) {
      paths.projectMcpServersDir = projectMcpDir;
    }
  }

  return { installed, paths };
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** Return `.yaml`/`.yml` files directly inside a directory. Empty array on error. */
export function listYamlFiles(dir: string): string[] {
  try {
    return readdirSync(dir).filter((n) => /\.(ya?ml)$/i.test(n));
  } catch {
    return [];
  }
}
