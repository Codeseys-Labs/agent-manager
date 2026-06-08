/**
 * Marketplace installer: install/uninstall plugins from marketplace repos.
 *
 * @deprecated Marketplace v1 is retired per ADR-0039. This module is frozen for
 * compatibility and scheduled for removal; use the MCP Registry for servers and
 * git-subtree/git-submodule bundles for skills/instructions/agents. See
 * ADRs/0039-marketplace-v1-scope-decision.md.
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
import { resolveConfigDir, tryReadConfig } from "../core/config";
import { withConfig } from "../core/controller";
import type { AgentProfile, Config, Server, Skill } from "../core/schema";
import { requireConfig } from "../lib/errors";
import { MarketplaceError, findMarketplaceEntry, verifyMarketplacePin } from "./client";
import { scanAllMarketplaces } from "./scanner";
import { assertServerCommandSafe, safeResolveInsidePlugin } from "./security";
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
  opts?: { yes?: boolean; trustCommands?: boolean },
): Promise<InstallResult> {
  // Find the plugin across all marketplaces
  const allPlugins = await scanAllMarketplaces();
  const plugin = allPlugins.find((p) => p.manifest.name === pluginName);
  if (!plugin) {
    throw new MarketplaceError(
      `Plugin "${pluginName}" not found in any marketplace. Run \`am marketplace list\` to see available plugins.`,
    );
  }

  // Supply-chain: verify the clone's HEAD still matches the pinned SHA.
  const marketplaceEntry = await findMarketplaceEntry(plugin.marketplace);
  if (marketplaceEntry) {
    await verifyMarketplacePin(marketplaceEntry);
  }

  const configDir = resolveConfigDir();

  // opts.yes reserved for future install-time confirmation prompts; the SHA
  // pin verification path above is already wired to respect the flag via
  // updateMarketplace. We keep the arg name stable for the CLI contract.
  // opts.trustCommands is forwarded through applyPlugin into the
  // command-allowlist enforcement so unsafe commands can be installed
  // anyway when the user has explicitly opted in.
  void opts;

  // REV-1 MEDIUM-2: serialize RMW via withConfig. adapters.toml writes
  // (setCommunityAdapterConfig) happen inside the span so the whole install
  // is atomic under a single mutex held against concurrent MCP/CLI callers.
  return withConfig(configDir, async (config) => {
    requireConfig(config);

    const result = applyPlugin(config, plugin, { trustCommands: opts?.trustCommands });

    // Register community adapter in adapters.toml if declared
    if (plugin.manifest.adapter) {
      const adapterName = plugin.manifest.name;
      const adapterConfig: CommunityAdapterConfig = {
        source:
          plugin.manifest.adapter.source ?? `marketplace:${plugin.marketplace}/${adapterName}`,
        command: plugin.manifest.adapter.command,
        installed_at: new Date().toISOString(),
      };
      await setCommunityAdapterConfig(configDir, adapterName, adapterConfig);
      result.adapter = adapterName;
    }

    return {
      result,
      changed: true,
      commitMessage: `marketplace install: ${pluginName}`,
    };
  });
}

/**
 * Apply a plugin's manifest entries to an in-memory config.
 * Mutates the config object and returns what was added.
 *
 * Server `command` values are gated through {@link assertServerCommandSafe}
 * before being copied into config. Pass `opts.trustCommands = true` to
 * bypass the denylist (e.g. when the user has answered "yes" to a trust
 * prompt at the CLI layer).
 */
export function applyPlugin(
  config: Config,
  plugin: DiscoveredPlugin,
  opts: { trustCommands?: boolean } = {},
): InstallResult {
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
      // Supply-chain: gate the command + argv pair through the allowlist
      // BEFORE copying it into config. Throws MarketplaceSecurityError on
      // shells / shell-equivalents / `-c` smuggling unless the caller has
      // explicitly opted in via trustCommands.
      assertServerCommandSafe(
        serverDef.command,
        serverDef.args,
        `plugin "${manifest.name}".servers["${name}"].command`,
        { trustCommands: opts.trustCommands },
      );
      const transport = serverDef.transport ?? "stdio";
      const server: Server = {
        command: serverDef.command,
        args: serverDef.args,
        env: serverDef.env,
        transport,
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
      // Guard `url` on the RESOLVED transport (mirrors install.ts): the
      // ServerSchema discriminated union (ADR-0057) forbids `url` on a stdio
      // server, and writeConfig does NOT validate — so an unguarded copy here
      // would silently persist a stdio+url server that bricks the config on the
      // next read (ConfigSchema.parse throws). A plugin manifest may set `url`
      // with `transport` absent, which resolves to stdio.
      if (serverDef.url && transport !== "stdio") server.url = serverDef.url;
      config.servers[name] = server;
      result.servers.push(name);
    }
  }

  // Add skills
  if (manifest.skills) {
    if (!config.skills) config.skills = {};
    for (const skillPath of manifest.skills) {
      // Supply-chain: ensure the skill path stays inside the plugin dir.
      const resolvedSkillPath = safeResolveInsidePlugin(
        plugin.pluginDir,
        skillPath,
        `skills["${skillPath}"]`,
      );
      const skillName = skillPath.replace(/\/$/, "").split("/").pop() || skillPath;
      const skill: Skill = {
        path: resolvedSkillPath,
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
      // Supply-chain: if the agent has a prompt_file, force it to resolve
      // inside the plugin dir. Reject any that escape.
      let resolvedPromptFile: string | undefined = agentDef.prompt_file;
      if (agentDef.prompt_file) {
        resolvedPromptFile = safeResolveInsidePlugin(
          plugin.pluginDir,
          agentDef.prompt_file,
          `agents["${name}"].prompt_file`,
        );
      }
      const agent: AgentProfile = {
        name: agentDef.name,
        description: agentDef.description,
        prompt: agentDef.prompt,
        prompt_file: resolvedPromptFile,
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

  // REV-1 MEDIUM-2: serialize RMW via withConfig. adapters.toml removal is
  // scoped inside the same critical section so a concurrent install can't
  // re-add the adapter between the config.toml write and the adapters.toml
  // removal (or vice versa).
  return withConfig(configDir, async (config) => {
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

    return {
      result,
      changed: true,
      commitMessage: `marketplace uninstall: ${pluginName}`,
    };
  });
}

/**
 * List all installed plugins by scanning config for _marketplace provenance.
 * Scans servers, skills, and agents for marketplace-installed entities.
 */
export async function listInstalled(): Promise<
  Array<{
    plugin: string;
    marketplace: string;
    servers: string[];
    skills: string[];
    agents: string[];
    installedAt: string;
  }>
> {
  const configDir = resolveConfigDir();
  const configPath = join(configDir, "config.toml");
  const config = await tryReadConfig(configPath);
  if (!config) return [];

  const pluginMap = new Map<
    string,
    {
      marketplace: string;
      servers: string[];
      skills: string[];
      agents: string[];
      installedAt: string;
    }
  >();

  function track(
    pluginName: string,
    entityType: "servers" | "skills" | "agents",
    entityName: string,
    mp: { source: string; install_path?: string; imported_at: string },
  ) {
    const existing = pluginMap.get(pluginName);
    if (existing) {
      existing[entityType].push(entityName);
    } else {
      pluginMap.set(pluginName, {
        marketplace: mp.install_path ? "local" : mp.source,
        servers: [],
        skills: [],
        agents: [],
        installedAt: mp.imported_at,
      });
      pluginMap.get(pluginName)![entityType].push(entityName);
    }
  }

  if (config.servers) {
    for (const [name, server] of Object.entries(config.servers)) {
      if (server._marketplace)
        track(server._marketplace.package, "servers", name, server._marketplace);
    }
  }
  if (config.skills) {
    for (const [name, skill] of Object.entries(config.skills)) {
      const mp = (
        skill as {
          _marketplace?: {
            package: string;
            source: string;
            install_path?: string;
            imported_at: string;
          };
        }
      )._marketplace;
      if (mp) track(mp.package, "skills", name, mp);
    }
  }
  if (config.agents) {
    for (const [name, agent] of Object.entries(config.agents)) {
      const mp = (
        agent as {
          _marketplace?: {
            package: string;
            source: string;
            install_path?: string;
            imported_at: string;
          };
        }
      )._marketplace;
      if (mp) track(mp.package, "agents", name, mp);
    }
  }

  return Array.from(pluginMap.entries()).map(([plugin, data]) => ({
    plugin,
    ...data,
  }));
}
