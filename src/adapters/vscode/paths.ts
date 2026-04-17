/**
 * Shared VS Code extension storage path resolution.
 *
 * VS Code and its forks (Insiders, VSCodium, Cursor, Windsurf) share the same
 * globalStorage layout but under different product directories. This module
 * centralizes the resolution logic so every adapter that reads VS Code
 * extension data handles all variants the same way.
 *
 * Notes on filesystem case sensitivity:
 *   - macOS HFS+/APFS is case-insensitive by default (mixed-case == lower-case)
 *   - Windows NTFS is case-insensitive
 *   - Linux ext4/xfs/btrfs are CASE-SENSITIVE — extension IDs must match disk
 *     exactly. We therefore emit candidate paths for every casing variant an
 *     extension might be installed under.
 *
 * Extension IDs on the VS Code marketplace are registered with a specific
 * case (e.g. `RooVeterinaryInc.roo-cline`, `kilocode.Kilo-Code`) but VS Code
 * historically has also lowercased them on install. Callers should pass in
 * every casing they want to try via `resolveVSCodeExtensionStorage`.
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface VSCodeVariant {
  /** Human-readable name for diagnostics. */
  displayName: string;
  /** The product directory under Application Support / .config / APPDATA. */
  dirName: string;
}

/**
 * The VS Code variants we support. Order matters — adapters that report
 * "the first variant that has this file" will prefer stable VS Code.
 */
export const VSCODE_VARIANTS: readonly VSCodeVariant[] = [
  { displayName: "VS Code", dirName: "Code" },
  { displayName: "VS Code Insiders", dirName: "Code - Insiders" },
  { displayName: "VSCodium", dirName: "VSCodium" },
  { displayName: "VSCodium Insiders", dirName: "VSCodium - Insiders" },
  { displayName: "Cursor", dirName: "Cursor" },
  { displayName: "Windsurf", dirName: "Windsurf" },
] as const;

/** Resolve the base User directory for a given variant on the current platform. */
export function resolveVSCodeUserDir(variant: VSCodeVariant, homeDir?: string): string {
  const home = homeDir ?? homedir();

  if (process.platform === "darwin") {
    return join(home, "Library", "Application Support", variant.dirName, "User");
  }
  if (process.platform === "win32") {
    const appData = process.env.APPDATA ?? join(home, "AppData", "Roaming");
    return join(appData, variant.dirName, "User");
  }
  // Linux and other XDG-style platforms
  return join(home, ".config", variant.dirName, "User");
}

/**
 * Return ALL candidate paths for a VS Code extension's globalStorage,
 * across every variant we know about, and across every casing the caller
 * provides.
 *
 * Caller is expected to pick the first that exists.
 *
 * @param extensionId - Marketplace extension ID (e.g. `saoudrizwan.claude-dev`).
 *   You can also pass an array of ID casings (e.g.
 *   `["RooVeterinaryInc.roo-cline", "rooveterinaryinc.roo-cline"]`) and the
 *   helper will try each one under each variant.
 */
export function resolveVSCodeExtensionStorage(
  extensionId: string | string[],
  homeDir?: string,
): string[] {
  const ids = Array.isArray(extensionId) ? extensionId : [extensionId];
  const paths: string[] = [];

  for (const variant of VSCODE_VARIANTS) {
    const userDir = resolveVSCodeUserDir(variant, homeDir);
    for (const id of ids) {
      paths.push(join(userDir, "globalStorage", id));
    }
  }

  return paths;
}

/**
 * Convenience: return the first path returned by
 * `resolveVSCodeExtensionStorage` that actually exists on disk, or
 * `undefined` if none do.
 */
export function findFirstExistingVSCodeExtensionStorage(
  extensionId: string | string[],
  homeDir?: string,
): string | undefined {
  const candidates = resolveVSCodeExtensionStorage(extensionId, homeDir);
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

/** Return all candidate `settings.json` paths (user-scope), one per variant. */
export function resolveVSCodeUserSettings(homeDir?: string): string[] {
  return VSCODE_VARIANTS.map((v) => join(resolveVSCodeUserDir(v, homeDir), "settings.json"));
}

/**
 * Return all candidate user-scope `mcp.json` paths, one per variant.
 *
 * Used by GitHub Copilot (VS Code) which stores the user profile MCP config
 * at `<User>/mcp.json` (not inside globalStorage).
 */
export function resolveVSCodeUserMcpJson(homeDir?: string): string[] {
  return VSCODE_VARIANTS.map((v) => join(resolveVSCodeUserDir(v, homeDir), "mcp.json"));
}
