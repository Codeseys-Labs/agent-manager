import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  findFirstExistingVSCodeExtensionStorage,
  resolveVSCodeExtensionStorage,
} from "../shared/vscode-paths.ts";
import type { DetectResult } from "../types.ts";

/**
 * Roo Code marketplace extension IDs. The upstream marketplace registers
 * `RooVeterinaryInc.roo-cline` (mixed case); we also probe the lowercase form
 * since older installs and some case-sensitive filesystems may have stored
 * either one.
 */
export const ROO_EXTENSION_IDS = [
  "RooVeterinaryInc.roo-cline",
  "rooveterinaryinc.roo-cline",
] as const;

/**
 * Resolve the VS Code globalStorage path for the Roo Code extension.
 *
 * Tries every VS Code variant × every extension-ID casing. Returns the first
 * on-disk hit, falling back to the first constructed path so callers that
 * only want the intended location (e.g. to write a file that doesn't exist
 * yet) still get a well-defined value.
 */
export function getGlobalStoragePath(home: string): string {
  const hit = findFirstExistingVSCodeExtensionStorage([...ROO_EXTENSION_IDS], home);
  if (hit) return hit;
  const candidates = resolveVSCodeExtensionStorage([...ROO_EXTENSION_IDS], home);
  return candidates[0];
}

/**
 * Detect whether Roo Code is installed and discover config paths.
 *
 * Detection strategy:
 *   1. VS Code globalStorage across variants, checking both ID casings
 *   2. mcp_settings.json in globalStorage/settings/
 *   3. .roo/ directory at project root
 *   4. .roomodes file at project root
 */
export function detect(homeDir?: string, projectPath?: string): DetectResult {
  const home = homeDir ?? homedir();
  const paths: Record<string, string> = {};

  const extStorage = findFirstExistingVSCodeExtensionStorage([...ROO_EXTENSION_IDS], home);
  if (extStorage) {
    paths.globalStorageDir = extStorage;
    const mcpSettingsPath = join(extStorage, "settings", "mcp_settings.json");
    if (existsSync(mcpSettingsPath)) {
      paths.mcpSettings = mcpSettingsPath;
    }
  }

  const installed = "globalStorageDir" in paths || "mcpSettings" in paths;

  if (projectPath) {
    const rooDir = join(projectPath, ".roo");
    if (existsSync(rooDir)) {
      paths.rooDir = rooDir;
    }

    const projectMcp = join(projectPath, ".roo", "mcp.json");
    if (existsSync(projectMcp)) {
      paths.projectMcp = projectMcp;
    }

    const roomodes = join(projectPath, ".roomodes");
    if (existsSync(roomodes)) {
      paths.roomodes = roomodes;
    }

    const sharedRulesDir = join(projectPath, ".roo", "rules");
    if (existsSync(sharedRulesDir)) {
      paths.sharedRulesDir = sharedRulesDir;
    }
  }

  return { installed, paths };
}
