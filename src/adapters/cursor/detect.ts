import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { DetectResult } from "../types.ts";

/**
 * Detect whether Cursor is installed and discover config paths.
 *
 * @param homeDir - Override home directory (useful for testing)
 * @param projectPath - Optional project directory to check for project-level configs
 */
export function detect(homeDir?: string, projectPath?: string): DetectResult {
  const home = homeDir ?? homedir();
  const paths: Record<string, string> = {};

  // Global MCP config: ~/.cursor/mcp.json
  const globalMcp = join(home, ".cursor", "mcp.json");
  if (existsSync(globalMcp)) {
    paths.globalMcpConfig = globalMcp;
  }

  // Config directory: ~/.cursor/
  const configDir = join(home, ".cursor");
  if (existsSync(configDir)) {
    paths.configDir = configDir;
  }

  const installed = "configDir" in paths;

  // Try to get version
  let version: string | undefined;
  if (installed) {
    version = getCursorVersion();
  }

  // Project-level paths
  if (projectPath) {
    const projectMcp = join(projectPath, ".cursor", "mcp.json");
    if (existsSync(projectMcp)) {
      paths.projectMcpConfig = projectMcp;
    }

    const rulesDir = join(projectPath, ".cursor", "rules");
    if (existsSync(rulesDir)) {
      paths.rulesDir = rulesDir;
    }

    const legacyRules = join(projectPath, ".cursorrules");
    if (existsSync(legacyRules)) {
      paths.legacyRules = legacyRules;
    }

    const agentsDir = join(projectPath, ".cursor", "agents");
    if (existsSync(agentsDir)) {
      paths.agentsDir = agentsDir;
    }
  }

  return { installed, version, paths };
}

function getCursorVersion(): string | undefined {
  try {
    const proc = Bun.spawnSync(["cursor", "--version"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    if (proc.exitCode === 0) {
      return proc.stdout.toString().trim();
    }
  } catch {
    // cursor CLI not in PATH
  }
  return undefined;
}
