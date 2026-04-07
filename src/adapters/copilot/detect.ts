import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { DetectResult } from "../types.ts";

/**
 * Detect whether GitHub Copilot (VS Code) is installed and discover config paths.
 *
 * @param homeDir - Override home directory (useful for testing)
 * @param projectPath - Optional project directory to check for project-level configs
 */
export function detect(homeDir?: string, projectPath?: string): DetectResult {
  const home = homeDir ?? homedir();
  const paths: Record<string, string> = {};

  // VS Code directory: ~/.vscode/
  const vscodeDir = join(home, ".vscode");
  if (existsSync(vscodeDir)) {
    paths.vscodeDir = vscodeDir;
  }

  // User-level MCP config (macOS): ~/Library/Application Support/Code/User/mcp.json
  const userMcpConfig = join(
    home,
    "Library",
    "Application Support",
    "Code",
    "User",
    "mcp.json",
  );
  if (existsSync(userMcpConfig)) {
    paths.userMcpConfig = userMcpConfig;
  }

  // Copilot CLI config: ~/.copilot/mcp-config.json
  const cliConfig = join(home, ".copilot", "mcp-config.json");
  if (existsSync(cliConfig)) {
    paths.cliMcpConfig = cliConfig;
  }

  const installed = "vscodeDir" in paths || "userMcpConfig" in paths;

  // Project-level paths
  if (projectPath) {
    // .vscode/mcp.json
    const projectMcp = join(projectPath, ".vscode", "mcp.json");
    if (existsSync(projectMcp)) {
      paths.projectMcpConfig = projectMcp;
    }

    // .github/copilot-instructions.md
    const globalInstructions = join(
      projectPath,
      ".github",
      "copilot-instructions.md",
    );
    if (existsSync(globalInstructions)) {
      paths.globalInstructions = globalInstructions;
    }

    // .github/instructions/ directory
    const instructionsDir = join(projectPath, ".github", "instructions");
    if (existsSync(instructionsDir)) {
      paths.instructionsDir = instructionsDir;
    }
  }

  return { installed, paths };
}
