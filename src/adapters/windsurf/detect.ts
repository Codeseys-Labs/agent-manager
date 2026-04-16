import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { DetectResult } from "../types.ts";

/**
 * Detect whether Windsurf is installed and discover config paths.
 *
 * @param homeDir - Override home directory (useful for testing)
 * @param projectPath - Optional project directory to check for project-level configs
 */
export function detect(homeDir?: string, projectPath?: string): DetectResult {
  const home = homeDir ?? homedir();
  const paths: Record<string, string> = {};

  // Global config: ~/.codeium/windsurf/
  const windsurfDir = join(home, ".codeium", "windsurf");
  if (existsSync(windsurfDir)) {
    paths.configDir = windsurfDir;
  }

  // Global MCP config: ~/.codeium/windsurf/mcp_config.json
  const mcpConfig = join(windsurfDir, "mcp_config.json");
  if (existsSync(mcpConfig)) {
    paths.globalMcpConfig = mcpConfig;
  }

  // Global rules: ~/.codeium/windsurf/memories/global_rules.md
  const globalRules = join(windsurfDir, "memories", "global_rules.md");
  if (existsSync(globalRules)) {
    paths.globalRules = globalRules;
  }

  const installed = "configDir" in paths || "globalMcpConfig" in paths;

  // Project-level paths
  if (projectPath) {
    // .windsurf/rules/ directory
    const rulesDir = join(projectPath, ".windsurf", "rules");
    if (existsSync(rulesDir)) {
      paths.rulesDir = rulesDir;
    }

    // .windsurf/skills/ directory (Windsurf 2.0.44+)
    const skillsDir = join(projectPath, ".windsurf", "skills");
    if (existsSync(skillsDir)) {
      paths.skillsDir = skillsDir;
    }

    // AGENTS.md instruction file (Windsurf 2.0.44+)
    const agentsMd = join(projectPath, "AGENTS.md");
    if (existsSync(agentsMd)) {
      paths.agentsMd = agentsMd;
    }

    // Legacy .windsurfrules
    const legacyRules = join(projectPath, ".windsurfrules");
    if (existsSync(legacyRules)) {
      paths.legacyRules = legacyRules;
    }
  }

  return { installed, paths };
}
