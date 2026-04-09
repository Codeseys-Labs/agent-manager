import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { DetectResult } from "../types.ts";

/**
 * Resolve the VS Code globalStorage path for the Cline extension.
 *
 * The extension ID is `saoudrizwan.claude-dev`.
 * Paths vary by OS:
 *   - macOS:  ~/Library/Application Support/Code/User/globalStorage/saoudrizwan.claude-dev
 *   - Linux:  ~/.config/Code/User/globalStorage/saoudrizwan.claude-dev
 *   - Windows: %APPDATA%/Code/User/globalStorage/saoudrizwan.claude-dev
 */
export function getGlobalStoragePath(home: string): string {
  const extensionId = "saoudrizwan.claude-dev";
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
 * Detect whether Cline is installed and discover config paths.
 *
 * Detection strategy:
 *   1. VS Code globalStorage for saoudrizwan.claude-dev extension
 *   2. cline_mcp_settings.json in globalStorage/settings/
 *   3. .clinerules (file or directory) at project root
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
  const mcpSettingsPath = join(globalStoragePath, "settings", "cline_mcp_settings.json");
  if (existsSync(mcpSettingsPath)) {
    paths.mcpSettings = mcpSettingsPath;
  }

  const installed = "globalStorageDir" in paths || "mcpSettings" in paths;

  // Project-level paths
  if (projectPath) {
    // .clinerules directory (newer format, takes priority)
    const rulesDir = join(projectPath, ".clinerules");
    if (existsSync(rulesDir)) {
      const fs = require("node:fs");
      try {
        const stat = fs.statSync(rulesDir);
        if (stat.isDirectory()) {
          paths.rulesDir = rulesDir;
        } else {
          // Legacy single-file format
          paths.rulesFile = rulesDir;
        }
      } catch {
        // skip
      }
    }
  }

  return { installed, paths };
}
