import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { DetectResult } from "../types.ts";

/**
 * Detect whether Amazon Q Developer is installed and discover config paths.
 *
 * @param homeDir - Override home directory (useful for testing)
 * @param projectPath - Optional project directory to check for project-level configs
 */
export function detect(homeDir?: string, projectPath?: string): DetectResult {
  const home = homeDir ?? homedir();
  const paths: Record<string, string> = {};

  // Global config dir: ~/.aws/amazonq/
  const amazonqDir = join(home, ".aws", "amazonq");
  if (existsSync(amazonqDir)) {
    paths.configDir = amazonqDir;
  }

  // Global MCP config: ~/.aws/amazonq/mcp.json
  const globalMcp = join(amazonqDir, "mcp.json");
  if (existsSync(globalMcp)) {
    paths.globalMcpConfig = globalMcp;
  }

  const installed = "configDir" in paths || "globalMcpConfig" in paths;

  // Project-level paths
  if (projectPath) {
    // .amazonq/mcp.json
    const projectMcp = join(projectPath, ".amazonq", "mcp.json");
    if (existsSync(projectMcp)) {
      paths.projectMcpConfig = projectMcp;
    }

    // .amazonq/rules/ directory
    const rulesDir = join(projectPath, ".amazonq", "rules");
    if (existsSync(rulesDir)) {
      paths.rulesDir = rulesDir;
    }
  }

  return { installed, paths };
}
