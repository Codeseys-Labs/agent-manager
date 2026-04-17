/** Git-based marketplace types for plugin discovery and installation. */

export type MarketplaceSource = "github" | "gitlab" | "local";

/** Entry in ~/.config/agent-manager/marketplaces.json */
export interface MarketplaceEntry {
  name: string;
  url: string;
  source: MarketplaceSource;
  added_at: string;
  updated_at?: string;
  /**
   * Commit SHA pinned at add time (or most recent accepted update).
   * Null/undefined for local symlink marketplaces.
   */
  commit?: string;
  /**
   * When true, install operations will refuse to proceed if the clone's
   * HEAD does not match `commit`. Defaults to true for git-based
   * marketplaces once a commit is recorded.
   */
  pinned?: boolean;
}

/** Tracked marketplace list persisted to disk. */
export interface MarketplacesFile {
  marketplaces: MarketplaceEntry[];
}

/** Author metadata inside a plugin manifest. */
export interface PluginAuthor {
  name: string;
  email?: string;
}

/** Server definition within a plugin manifest. */
export interface PluginServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  transport?: "stdio" | "streamable-http" | "sse";
  url?: string;
}

/** Agent definition within a plugin manifest. */
export interface PluginAgentConfig {
  name: string;
  description?: string;
  prompt?: string;
  prompt_file?: string;
  model?: string;
  tools?: string[];
}

/** Community adapter definition within a plugin manifest (ADR-0027). */
export interface PluginAdapterConfig {
  /** Command to run the adapter binary (JSON-RPC 2.0 over stdio). */
  command: string;
  /** npm/git/local source string for provenance tracking. */
  source?: string;
}

/**
 * Plugin manifest: <plugin-dir>/.am-plugin/plugin.json
 *
 * Also discovered from .claude-plugin/plugin.json for cross-tool compatibility.
 */
export interface PluginManifest {
  name: string;
  description: string;
  version?: string;
  author?: PluginAuthor;
  servers?: Record<string, PluginServerConfig>;
  skills?: string[];
  agents?: Record<string, PluginAgentConfig>;
  /** Optional community adapter — registered in adapters.toml via ADR-0027 loader. */
  adapter?: PluginAdapterConfig;
}

/** A discovered plugin within a marketplace, with its location metadata. */
export interface DiscoveredPlugin {
  manifest: PluginManifest;
  marketplace: string;
  pluginDir: string;
  manifestPath: string;
}

/** Provenance metadata stored with marketplace-installed servers. */
export interface MarketplaceProvenance {
  source: "marketplace";
  marketplace: string;
  plugin: string;
  version?: string;
  installed_at: string;
}
