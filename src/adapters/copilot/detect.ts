import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { DetectResult } from "../types.ts";
import { resolveVSCodeUserMcpJson } from "../vscode/paths.ts";

/**
 * Detect whether GitHub Copilot (VS Code) is installed and discover config paths.
 *
 * Variants handled (via {@link resolveVSCodeUserMcpJson}):
 *   - VS Code stable (`Code`)
 *   - VS Code Insiders (`Code - Insiders`)
 *   - VSCodium / VSCodium Insiders
 *   - Cursor
 *   - Windsurf
 *
 * @param homeDir - Override home directory (useful for testing)
 * @param projectPath - Optional project directory to check for project-level configs
 */
export function detect(homeDir?: string, projectPath?: string): DetectResult {
  const home = homeDir ?? homedir();
  const paths: Record<string, string> = {};

  // VS Code marker directory (just used as a heuristic)
  const vscodeDir = join(home, ".vscode");
  if (existsSync(vscodeDir)) {
    paths.vscodeDir = vscodeDir;
  }

  // User-level mcp.json across every VS Code variant
  const userMcpCandidates = resolveVSCodeUserMcpJson(home);
  for (const candidate of userMcpCandidates) {
    if (existsSync(candidate)) {
      paths.userMcpConfig = candidate;
      break;
    }
  }

  // Copilot CLI config: ~/.copilot/mcp-config.json
  const cliConfig = join(home, ".copilot", "mcp-config.json");
  if (existsSync(cliConfig)) {
    paths.cliMcpConfig = cliConfig;
  }

  const installed = "vscodeDir" in paths || "userMcpConfig" in paths;

  // Project-level paths
  if (projectPath) {
    const projectMcp = join(projectPath, ".vscode", "mcp.json");
    if (existsSync(projectMcp)) {
      paths.projectMcpConfig = projectMcp;
    }

    const globalInstructions = join(projectPath, ".github", "copilot-instructions.md");
    if (existsSync(globalInstructions)) {
      paths.globalInstructions = globalInstructions;
    }

    const instructionsDir = join(projectPath, ".github", "instructions");
    if (existsSync(instructionsDir)) {
      paths.instructionsDir = instructionsDir;
    }
  }

  return { installed, paths };
}
