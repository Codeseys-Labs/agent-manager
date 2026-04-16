/**
 * Marketplace scanner: find all plugins within marketplace repos.
 *
 * Scans for directories containing .am-plugin/plugin.json (am native) or
 * .claude-plugin/plugin.json (Claude Code compatible) within each
 * marketplace's plugins/ directory (or root-level plugin dirs).
 */
import * as fs from "node:fs";
import { join, relative } from "node:path";
import { readMarketplacesFile, resolveMarketplacesDir } from "./client";
import type { DiscoveredPlugin, PluginManifest } from "./types";

/** Manifest directory names to scan, in priority order. */
const MANIFEST_DIRS = [".am-plugin", ".claude-plugin"] as const;
const PLUGIN_MANIFEST_FILE = "plugin.json";

/**
 * Read and parse a plugin manifest from a directory.
 * Checks .am-plugin/plugin.json first, then .claude-plugin/plugin.json.
 * Returns null if no valid manifest is found.
 */
export async function readPluginManifest(pluginDir: string): Promise<PluginManifest | null> {
  for (const manifestDir of MANIFEST_DIRS) {
    const manifestPath = join(pluginDir, manifestDir, PLUGIN_MANIFEST_FILE);
    try {
      const raw = await fs.promises.readFile(manifestPath, "utf-8");
      const parsed = JSON.parse(raw) as PluginManifest;
      // Validate required fields
      if (!parsed.name || !parsed.description) continue;
      return parsed;
    } catch {}
  }
  return null;
}

/**
 * Resolve which manifest directory was found for a plugin.
 * Returns the full path to the manifest file.
 */
export async function resolveManifestPath(pluginDir: string): Promise<string | null> {
  for (const manifestDir of MANIFEST_DIRS) {
    const manifestPath = join(pluginDir, manifestDir, PLUGIN_MANIFEST_FILE);
    try {
      await fs.promises.access(manifestPath);
      return manifestPath;
    } catch {}
  }
  return null;
}

/**
 * Scan a single marketplace directory for plugins.
 * Looks for .am-plugin/plugin.json in immediate subdirectories.
 */
export async function scanMarketplace(
  marketplaceName: string,
  marketplaceDir: string,
): Promise<DiscoveredPlugin[]> {
  const plugins: DiscoveredPlugin[] = [];

  // Resolve symlinks
  let resolvedDir: string;
  try {
    resolvedDir = await fs.promises.realpath(marketplaceDir);
  } catch {
    return plugins;
  }

  // Scan directories that could contain plugins:
  // 1. plugins/<name>/.am-plugin/plugin.json (conventional)
  // 2. <name>/.am-plugin/plugin.json (flat layout)
  const searchDirs = [resolvedDir];
  const pluginsSubdir = join(resolvedDir, "plugins");
  try {
    await fs.promises.access(pluginsSubdir);
    searchDirs.push(pluginsSubdir);
  } catch {
    // No plugins/ subdirectory
  }

  for (const searchDir of searchDirs) {
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(searchDir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      // Skip hidden dirs and .git
      if (entry.name.startsWith(".")) continue;

      const pluginDir = join(searchDir, entry.name);
      const manifest = await readPluginManifest(pluginDir);
      if (manifest) {
        const manifestPath = await resolveManifestPath(pluginDir);
        plugins.push({
          manifest,
          marketplace: marketplaceName,
          pluginDir,
          manifestPath: manifestPath!,
        });
      }
    }
  }

  return plugins;
}

/**
 * Scan all registered marketplaces and return discovered plugins.
 */
export async function scanAllMarketplaces(): Promise<DiscoveredPlugin[]> {
  const { marketplaces } = await readMarketplacesFile();
  const marketplacesDir = resolveMarketplacesDir();
  const allPlugins: DiscoveredPlugin[] = [];

  for (const entry of marketplaces) {
    const dir = join(marketplacesDir, entry.name);
    const plugins = await scanMarketplace(entry.name, dir);
    allPlugins.push(...plugins);
  }

  return allPlugins;
}

/**
 * Search for plugins matching a query string across all marketplaces.
 * Matches against plugin name, description, and server names.
 */
export async function searchPlugins(query: string): Promise<DiscoveredPlugin[]> {
  const all = await scanAllMarketplaces();
  const q = query.toLowerCase();

  return all.filter((p) => {
    const m = p.manifest;
    if (m.name.toLowerCase().includes(q)) return true;
    if (m.description.toLowerCase().includes(q)) return true;
    if (m.servers) {
      for (const serverName of Object.keys(m.servers)) {
        if (serverName.toLowerCase().includes(q)) return true;
      }
    }
    if (m.adapter?.command?.toLowerCase().includes(q)) return true;
    return false;
  });
}
