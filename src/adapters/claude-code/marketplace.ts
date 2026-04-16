/**
 * Claude Code marketplace scanner: reads installed plugins from
 * ~/.claude/settings.json enabledPlugins and their plugin.json manifests.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import type {
  ImportedServer,
  ImportedSkill,
  MarketplaceItem,
  MarketplaceResult,
} from "../types.ts";

interface PluginManifest {
  name?: string;
  version?: string;
  author?: string;
  repository?: string;
  skills?: { name: string; description?: string; path: string }[];
  hooks?: unknown[];
  mcpServers?: Record<string, { command: string; args?: string[]; env?: Record<string, string> }>;
}

/**
 * Scan installed Claude Code plugins for bundled MCP servers and skills.
 */
export function scanClaudePlugins(homeDir?: string): MarketplaceResult {
  const home = homeDir ?? homedir();
  const items: MarketplaceItem[] = [];
  const warnings: string[] = [];

  const fs = require("node:fs");

  // 1. Read enabledPlugins from ~/.claude/settings.json
  const settingsPath = join(home, ".claude", "settings.json");
  let enabledPlugins: string[] = [];
  try {
    const text = fs.readFileSync(settingsPath, "utf-8");
    const settings = JSON.parse(text);
    enabledPlugins = settings?.enabledPlugins ?? [];
  } catch {
    warnings.push(`Cannot read Claude settings: ${settingsPath}`);
    return { items, warnings };
  }

  if (!Array.isArray(enabledPlugins) || enabledPlugins.length === 0) {
    return { items, warnings };
  }

  // 2. For each enabled plugin, read its plugin.json
  for (const pluginId of enabledPlugins) {
    const pluginDir = join(home, ".claude", "plugins", pluginId);
    const manifestPath = join(pluginDir, "plugin.json");

    let manifest: PluginManifest;
    try {
      const text = fs.readFileSync(manifestPath, "utf-8");
      manifest = JSON.parse(text);
    } catch {
      warnings.push(`Plugin ${pluginId}: no plugin.json found at ${manifestPath}`);
      continue;
    }

    const servers: ImportedServer[] = [];
    const skills: ImportedSkill[] = [];

    // Extract MCP servers
    if (manifest.mcpServers && typeof manifest.mcpServers === "object") {
      for (const [name, config] of Object.entries(manifest.mcpServers)) {
        if (!config || !config.command) continue;
        servers.push({
          name,
          command: config.command,
          args: config.args,
          env: config.env,
          scope: "global",
          tags: [`plugin:${pluginId}`],
        });
      }
    }

    // Extract skills
    if (Array.isArray(manifest.skills)) {
      for (const skill of manifest.skills) {
        if (!skill.name || !skill.path) continue;
        skills.push({
          name: skill.name,
          path: join(pluginDir, skill.path),
          description: skill.description,
        });
      }
    }

    items.push({
      id: pluginId,
      name: manifest.name ?? pluginId,
      version: manifest.version ?? "unknown",
      source: "claude-plugin",
      servers,
      skills,
      metadata: {
        publisher: manifest.author,
        repository: manifest.repository,
        installPath: pluginDir,
        manifestPath,
      },
    });
  }

  return { items, warnings };
}
