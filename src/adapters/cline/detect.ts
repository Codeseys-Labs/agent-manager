import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { DetectResult } from "../types.ts";
import {
  findFirstExistingVSCodeExtensionStorage,
  resolveVSCodeExtensionStorage,
} from "../vscode/paths.ts";

/**
 * Cline marketplace extension ID. We try the canonical mixed-case and a
 * lowercase fallback — VS Code has historically downcased on install, but
 * modern installs preserve case. On case-sensitive Linux filesystems this
 * distinction matters.
 */
export const CLINE_EXTENSION_IDS = ["saoudrizwan.claude-dev"] as const;

/**
 * Resolve the VS Code globalStorage path for the Cline extension.
 *
 * Tries every VS Code variant (stable, Insiders, VSCodium, Cursor, Windsurf).
 * Returns the first on-disk hit, falling back to the stable-VSCode candidate
 * so existing code that assumes a path is always returned keeps working.
 */
export function getGlobalStoragePath(home: string): string {
  const hit = findFirstExistingVSCodeExtensionStorage([...CLINE_EXTENSION_IDS], home);
  if (hit) return hit;
  // Fall back to the first candidate path (stable VS Code) so callers that
  // want to construct a path relative to it (e.g. settings/*.json) still get
  // a well-defined path, even if nothing exists yet.
  const candidates = resolveVSCodeExtensionStorage([...CLINE_EXTENSION_IDS], home);
  return candidates[0];
}

/**
 * Detect whether Cline is installed and discover config paths.
 *
 * Detection strategy:
 *   1. VS Code globalStorage for the Cline extension across all variants
 *   2. cline_mcp_settings.json in that globalStorage/settings/
 *   3. .clinerules (file or directory) at project root
 */
export function detect(homeDir?: string, projectPath?: string): DetectResult {
  const home = homeDir ?? homedir();
  const paths: Record<string, string> = {};

  const extStorage = findFirstExistingVSCodeExtensionStorage([...CLINE_EXTENSION_IDS], home);
  if (extStorage) {
    paths.globalStorageDir = extStorage;
    const mcpSettingsPath = join(extStorage, "settings", "cline_mcp_settings.json");
    if (existsSync(mcpSettingsPath)) {
      paths.mcpSettings = mcpSettingsPath;
    }
  }

  const installed = "globalStorageDir" in paths || "mcpSettings" in paths;

  if (projectPath) {
    const rulesDir = join(projectPath, ".clinerules");
    if (existsSync(rulesDir)) {
      const fs = require("node:fs");
      try {
        const stat = fs.statSync(rulesDir);
        if (stat.isDirectory()) {
          paths.rulesDir = rulesDir;
        } else {
          paths.rulesFile = rulesDir;
        }
      } catch {
        // skip
      }
    }
  }

  return { installed, paths };
}
