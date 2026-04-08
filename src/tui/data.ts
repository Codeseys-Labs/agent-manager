/**
 * Data loading for TUI — bridges core config/resolver/git to TUI state.
 */
import {
  resolveConfigDir,
  loadResolvedConfig,
  resolveProjectConfig,
} from "../core/config.ts";
import { getStatus, type StatusResult } from "../core/git.ts";
import { readActiveProfile } from "../commands/use.ts";
import { getDetectedAdapters, listAdapters } from "../adapters/registry.ts";
import { resolveProfile, resolveActiveServers } from "../core/resolver.ts";
import type { Config, Server } from "../core/schema.ts";

export interface ServerEntry {
  name: string;
  command: string;
  tags: string[];
  enabled: boolean;
  description: string;
  transport: string;
}

export interface AdapterDrift {
  name: string;
  status: string;
  changes: number;
}

export interface TuiData {
  profileName: string;
  profiles: string[];
  profileDescriptions: Record<string, string>;
  servers: ServerEntry[];
  activeServerNames: string[];
  adapters: AdapterDrift[];
  git: StatusResult;
  allAdapterNames: string[];
  config: Config;
}

export async function loadTuiData(): Promise<TuiData> {
  const configDir = resolveConfigDir();
  const projectFile = resolveProjectConfig(process.cwd());

  const config = await loadResolvedConfig({ configDir, projectFile });

  const profileName =
    (await readActiveProfile(configDir)) ??
    config.settings?.default_profile ??
    "default";

  // Profile list
  const profiles = Object.keys(config.profiles ?? {});
  const profileDescriptions: Record<string, string> = {};
  for (const [name, prof] of Object.entries(config.profiles ?? {})) {
    profileDescriptions[name] = prof.description ?? "";
  }

  // Servers
  const servers: ServerEntry[] = Object.entries(config.servers ?? {}).map(
    ([name, srv]) => ({
      name,
      command: srv.command,
      tags: srv.tags ?? [],
      enabled: srv.enabled ?? true,
      description: srv.description ?? "",
      transport: srv.transport ?? "stdio",
    }),
  );

  // Active servers from resolved profile
  let activeServerNames: string[] = [];
  try {
    const resolved = resolveProfile(profileName, config);
    activeServerNames = resolved.servers;
  } catch {
    // Profile doesn't exist yet — show all
  }

  // Git status
  let git: StatusResult;
  try {
    git = await getStatus(configDir);
  } catch {
    git = { branch: "unknown", clean: true, dirty: [], remotes: [] };
  }

  // Adapter drift detection
  const detected = await getDetectedAdapters();
  const adapters: AdapterDrift[] = [];

  // Build resolved config for drift detection
  const resolvedServers: Record<string, any> = {};
  for (const [name, srv] of Object.entries(config.servers ?? {})) {
    resolvedServers[name] = {
      name,
      command: srv.command,
      args: srv.args ?? [],
      env: srv.env ?? {},
      transport: srv.transport ?? "stdio",
      description: srv.description ?? "",
      tags: srv.tags ?? [],
      enabled: srv.enabled ?? true,
      adapters: (srv.adapters as Record<string, Record<string, unknown>>) ?? {},
    };
  }
  const resolvedConfig = {
    servers: resolvedServers,
    instructions: {},
    skills: {},
    agents: {},
    profile: profileName,
    adapters:
      (config.adapters as Record<string, Record<string, unknown>>) ?? {},
  };

  for (const adapter of detected) {
    try {
      const diffResult = adapter.diff(resolvedConfig);
      adapters.push({
        name: adapter.meta.displayName,
        status: diffResult.status,
        changes: diffResult.changes.length,
      });
    } catch {
      adapters.push({
        name: adapter.meta.displayName,
        status: "unknown",
        changes: 0,
      });
    }
  }

  return {
    profileName,
    profiles,
    profileDescriptions,
    servers,
    activeServerNames,
    adapters,
    git,
    allAdapterNames: listAdapters(),
    config,
  };
}
