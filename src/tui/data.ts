import { getDetectedAdapters, listAdapters } from "../adapters/registry.ts";
import { readActiveProfile } from "../commands/use.ts";
/**
 * Data loading for TUI — bridges core config/resolver/git to TUI state.
 */
import {
  buildResolvedConfig,
  loadResolvedConfig,
  resolveConfigDir,
  resolveProjectConfig,
} from "../core/config.ts";
import { type StatusResult, getStatus } from "../core/git.ts";
import { resolveActiveServers, resolveProfile } from "../core/resolver.ts";
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
    (await readActiveProfile(configDir)) ?? config.settings?.default_profile ?? "default";

  // Profile list
  const profiles = Object.keys(config.profiles ?? {});
  const profileDescriptions: Record<string, string> = {};
  for (const [name, prof] of Object.entries(config.profiles ?? {})) {
    profileDescriptions[name] = prof.description ?? "";
  }

  // Servers
  const servers: ServerEntry[] = Object.entries(config.servers ?? {}).map(([name, srv]) => ({
    name,
    command: srv.command,
    tags: srv.tags ?? [],
    enabled: srv.enabled ?? true,
    description: srv.description ?? "",
    transport: srv.transport ?? "stdio",
  }));

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

  // Build resolved config for drift detection using the core resolution path
  const resolvedConfig = buildResolvedConfig(config, profileName, configDir);

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
