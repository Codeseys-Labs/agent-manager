import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { DetectResult } from "../types.ts";

/**
 * Resolve the VS Code globalStorage path for the Roo Code extension.
 *
 * Extension ID: rooveterinaryinc.roo-cline
 * Paths vary by OS:
 *   - macOS:  ~/Library/Application Support/Code/User/globalStorage/rooveterinaryinc.roo-cline
 *   - Linux:  ~/.config/Code/User/globalStorage/rooveterinaryinc.roo-cline
 *   - Windows: %APPDATA%/Code/User/globalStorage/rooveterinaryinc.roo-cline
 */
export function getGlobalStoragePath(home: string): string {
  const extensionId = "rooveterinaryinc.roo-cline";
  const suffix = join("Code", "User", "globalStorage", extensionId);

  if (process.platform === "darwin") {
    return join(home, "Library", "Application Support", suffix);
  }
  if (process.platform === "win32") {
    return join(process.env.APPDATA ?? join(home, "AppData", "Roaming"), suffix);
  }
  // Linux and other platforms
  return join(home, ".config", suffix);
}

/**
 * Detect whether Roo Code is installed and discover config paths.
 *
 * Detection strategy:
 *   1. VS Code globalStorage for rooveterinaryinc.roo-cline extension
 *   2. mcp_settings.json in globalStorage/settings/
 *   3. .roo/ directory at project root
 *   4. .roomodes file at project root
 */
export function detect(homeDir?: string, projectPath?: string): DetectResult {
  const home = homeDir ?? homedir();
  const paths: Record<string, string> = {};

  // Global: VS Code globalStorage
  const globalStoragePath = getGlobalStoragePath(home);
  if (existsSync(globalStoragePath)) {
    paths.globalStorageDir = globalStoragePath;
  }

  // MCP settings file
  const mcpSettingsPath = join(globalStoragePath, "settings", "mcp_settings.json");
  if (existsSync(mcpSettingsPath)) {
    paths.mcpSettings = mcpSettingsPath;
  }

  const installed = "globalStorageDir" in paths || "mcpSettings" in paths;

  // Project-level paths
  if (projectPath) {
    // .roo/ directory
    const rooDir = join(projectPath, ".roo");
    if (existsSync(rooDir)) {
      paths.rooDir = rooDir;
    }

    // .roo/mcp.json (project MCP servers)
    const projectMcp = join(projectPath, ".roo", "mcp.json");
    if (existsSync(projectMcp)) {
      paths.projectMcp = projectMcp;
    }

    // .roomodes file (custom modes)
    const roomodes = join(projectPath, ".roomodes");
    if (existsSync(roomodes)) {
      paths.roomodes = roomodes;
    }

    // .roo/rules/ directory (shared rules)
    const sharedRulesDir = join(projectPath, ".roo", "rules");
    if (existsSync(sharedRulesDir)) {
      paths.sharedRulesDir = sharedRulesDir;
    }
  }

  return { installed, paths };
}
