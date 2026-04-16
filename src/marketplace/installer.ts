/**
 * Marketplace installer: install/uninstall plugins from marketplace repos.
 *
 * Installing a plugin reads its manifest and adds servers, skills, agents,
 * and community adapters to the am config with provenance tracking.
 */
import { join } from "node:path";
import {
  readAdaptersToml,
  removeCommunityAdapterConfig,
  setCommunityAdapterConfig,
  writeAdaptersToml,
} from "../adapters/community/loader";
import type { CommunityAdapterConfig } from "../adapters/community/types";
import { resolveConfigDir, tryReadConfig, writeConfig } from "../core/config";
import { commitAll } from "../core/git";
import type { AgentProfile, Config, Server, Skill } from "../core/schema";
import { requireConfig } from "../lib/errors";
import { MarketplaceError } from "./client";
import { scanAllMarketplaces } from "./scanner";
import type { DiscoveredPlugin, MarketplaceProvenance, PluginManifest } from "./types";

/** Result of an install operation. */
export interface InstallResult {
  plugin: string;
  marketplace: string;
  servers: string[];
  skills: string[];
  agents: string[];
  adapter?: string;
}

/** Result of an uninstall operation. */
export interface UninstallResult {
  plugin: string;
  removedServers: string[];
  removedSkills: string[];
  removedAgents: string[];
  removedAdapter?: string;
}

/**
 * Install a plugin from a marketplace into the am config.
 *
 * Reads the plugin manifest and adds servers/skills/agents to config.toml
 * with _marketplace provenance metadata.
 */
export async function installPlugin(
  pluginName: string,
  opts?: { yes?: boolean },
): Promise<InstallResult> {
  // Find the plugin across all marketplaces
  const allPlugins = await scanAllMarketplaces();
  const plugin = allPlugins.find((p) => p.manifest.name === pluginName);
  if (!plugin) {
    throw new MarketplaceError(
      `Plugin "${pluginName}" not found in any marketplace. Run \`am marketplace list\` to see available plugins.`,
    );
  }

  const configDir = resolveConfigDir();
  const configPath = join(configDir, "config.toml");
  const config = await tryReadConfig(configPath);
  requireConfig(config);

  const result = applyPlugin(config, plugin);

  // Write config.toml for servers/skills/agents
  await writeConfig(configPath, config);

  // Register community adapter in adapters.toml if declared
  if (plugin.manifest.adapter) {
    const adapterName = plugin.manifest.name;
    const adapterConfig: CommunityAdapterConfig = {
      source: plugin.manifest.adapter.source ?? `marketplace:${plugin.marketplace}/${adapterName}`,
      command: plugin.manifest.adapter.command,
      installed_at: new Date().toISOString(),
    };
    await setCommunityAdapterConfig(configDir, adapterName, adapterConfig);
    result.adapter = adapterName;
  }

  try {
    await commitAll(configDir, `marketplace install: ${pluginName}`);
  } catch {
    // Nothing to commit
  }

  return result;
}

/**
 * Apply a plugin's manifest entries to an in-memory config.
 * Mutates the config object and returns what was added.
 */
export function applyPlugin(config: Config, plugin: DiscoveredPlugin): InstallResult {
  const manifest = plugin.manifest;
  const provenance: MarketplaceProvenance = {
    source: "marketplace",
    marketplace: plugin.marketplace,
    plugin: manifest.name,
    version: manifest.version,
    installed_at: new Date().toISOString(),
  };

  const result: InstallResult = {
    plugin: manifest.name,
    marketplace: plugin.marketplace,
    servers: [],
    skills: [],
    agents: [],
  };

  // Add servers
  if (manifest.servers) {
    if (!config.servers) config.servers = {};
    for (const [name, serverDef] of Object.entries(manifest.servers)) {
      const server: Server = {
        command: serverDef.command,
        args: serverDef.args,
        env: serverDef.env,
        transport: serverDef.transport ?? "stdio",
        enabled: true,
        description: `From plugin: ${manifest.name}`,
        _marketplace: {
          source: "claude-plugin",
          package: manifest.name,
          version: manifest.version ?? "0.0.0",
          imported_at: provenance.installed_at,
          install_path: plugin.pluginDir,
        },
      };
      if (serverDef.url) server.url = serverDef.url;
      config.servers[name] = server;
      result.servers.push(name);
    }
  }

  // Add skills
  if (manifest.skills) {
    if (!config.skills) config.skills = {};
    for (const skillPath of manifest.skills) {
      const skillName = skillPath.replace(/\/$/, "").split("/").pop() || skillPath;
      const skill: Skill = {
        path: join(plugin.pluginDir, skillPath),
        description: `From plugin: ${manifest.name}`,
        _marketplace: {
          source: "claude-plugin",
          package: manifest.name,
          version: manifest.version ?? "0.0.0",
          imported_at: provenance.installed_at,
          install_path: plugin.pluginDir,
        },
      };
      config.skills[skillName] = skill;
      result.skills.push(skillName);
    }
  }

  // Add agents
  if (manifest.agents) {
    if (!config.agents) config.agents = {};
    for (const [name, agentDef] of Object.entries(manifest.agents)) {
      const agent: AgentProfile = {
        name: agentDef.name,
        description: agentDef.description,
        prompt: agentDef.prompt,
        prompt_file: agentDef.prompt_file,
        model: agentDef.model,
        tools: agentDef.tools,
        _marketplace: {
          source: "claude-plugin",
          package: manifest.name,
          version: manifest.version ?? "0.0.0",
          imported_at: provenance.installed_at,
          install_path: plugin.pluginDir,
        },
      };
      config.agents[name] = agent;
      result.agents.push(name);
    }
  }

  return result;
}

/**
 * Uninstall a plugin: remove all servers/skills/agents that have
 * _marketplace provenance matching the plugin name.
 */
export async function uninstallPlugin(pluginName: string): Promise<UninstallResult> {
  const configDir = resolveConfigDir();
  const configPath = join(configDir, "config.toml");
  const config = await tryReadConfig(configPath);
  requireConfig(config);

  const result: UninstallResult = {
    plugin: pluginName,
    removedServers: [],
    removedSkills: [],
    removedAgents: [],
  };

  // Remove servers with matching provenance
  if (config.servers) {
    for (const [name, server] of Object.entries(config.servers)) {
      if (server._marketplace?.package === pluginName) {
        delete config.servers[name];
        result.removedServers.push(name);
      }
    }
  }

  // Remove skills with matching provenance
  if (config.skills) {
    for (const [name, skill] of Object.entries(config.skills)) {
      if (skill._marketplace?.package === pluginName) {
        delete config.skills[name];
        result.removedSkills.push(name);
      }
    }
  }

  // Remove agents with matching provenance
  if (config.agents) {
    for (const [name, agent] of Object.entries(config.agents)) {
      if (agent._marketplace?.package === pluginName) {
        delete config.agents[name];
        result.removedAgents.push(name);
      }
    }
  }

  // Remove community adapter if it was installed from this plugin
  const removed = await removeCommunityAdapterConfig(configDir, pluginName);
  if (removed) {
    result.removedAdapter = pluginName;
  }

  const totalRemoved =
    result.removedServers.length +
    result.removedSkills.length +
    result.removedAgents.length +
    (result.removedAdapter ? 1 : 0);

  if (totalRemoved === 0) {
    throw new MarketplaceError(`No installed entities found for plugin "${pluginName}".`);
  }

  await writeConfig(configPath, config);
  try {
    await commitAll(configDir, `marketplace uninstall: ${pluginName}`);
  } catch {
    // Nothing to commit
  }

  return result;
}

/**
 * List all installed plugins by scanning config for _marketplace provenance.
 * Returns unique plugin names with their server counts.
 */
export async function listInstalled(): Promise<
  Array<{ plugin: string; marketplace: string; servers: string[]; installedAt: string }>
> {
  const configDir = resolveConfigDir();
  const configPath = join(configDir, "config.toml");
  const config = await tryReadConfig(configPath);
  if (!config?.servers) return [];

  const pluginMap = new Map<
    string,
    { marketplace: string; servers: string[]; installedAt: string }
  >();

  for (const [name, server] of Object.entries(config.servers)) {
    const mp = server._marketplace;
    if (mp) {
      const existing = pluginMap.get(mp.package);
      if (existing) {
        existing.servers.push(name);
      } else {
        pluginMap.set(mp.package, {
          marketplace: mp.install_path ? "local" : mp.source,
          servers: [name],
          installedAt: mp.imported_at,
        });
      }
    }
  }

  return Array.from(pluginMap.entries()).map(([plugin, data]) => ({
    plugin,
    ...data,
  }));
}
