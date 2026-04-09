/**
 * Minimal MCP server implementing JSON-RPC 2.0 over stdio.
 *
 * Three permission tiers (ADR-0009):
 *   read-only    — always available
 *   write-local  — available by default
 *   write-remote — requires opt-in via settings.mcp_serve
 */

import { join } from "node:path";
import { getAdapter, getDetectedAdapters, listAdapters } from "../adapters/registry";
import { readActiveProfile, writeActiveProfile } from "../commands/use";
import {
  buildResolvedConfig,
  loadResolvedConfig,
  readConfig,
  resolveConfigDir,
  resolveProjectConfig,
  writeConfig,
} from "../core/config";
import { commitAll, getStatus, pull, push } from "../core/git";
import type { Config, Settings } from "../core/schema";
import { interpolateEnvAsync, loadKey } from "../core/secrets";
import { filterMessages, formatJson, formatMarkdown } from "../core/session";
import type { SessionSummary } from "../core/session";

// ── JSON-RPC types ──────────────────────────────────────────────

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

// ── MCP tool definition ─────────────────────────────────────────

interface McpToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
}

type ToolTier = "read-only" | "write-local" | "write-remote";

interface ToolEntry {
  def: McpToolDef;
  tier: ToolTier;
  handler: (args: Record<string, unknown>) => Promise<unknown>;
}

// ── Permission check ────────────────────────────────────────────

function checkPermission(
  tier: ToolTier,
  settings?: Settings,
): { allowed: boolean; reason?: string } {
  if (tier === "read-only" || tier === "write-local") {
    return { allowed: true };
  }
  // write-remote requires explicit opt-in
  const mcpServe = settings?.mcp_serve;
  if (tier === "write-remote") {
    // Only allow_push gates write-remote (am_sync_push, am_sync_pull)
    if (mcpServe?.allow_push) {
      return { allowed: true };
    }
    return {
      allowed: false,
      reason:
        "Write-remote tools require opt-in. Set settings.mcp_serve.allow_push = true in config.toml",
    };
  }
  return { allowed: true };
}

// ── Secret redaction ───────────────────────────────────────────

function redactSecrets(obj: unknown): unknown {
  if (typeof obj === "string" && obj.startsWith("enc:v1:")) return "[encrypted]";
  if (Array.isArray(obj)) return obj.map(redactSecrets);
  if (obj && typeof obj === "object") {
    return Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, redactSecrets(v)]));
  }
  return obj;
}

// ── Helpers ─────────────────────────────────────────────────────

async function loadConfigAndProfile(): Promise<{
  config: Config;
  configDir: string;
  profileName: string;
}> {
  const configDir = resolveConfigDir();
  const projectFile = resolveProjectConfig(process.cwd());
  const config = await loadResolvedConfig({ configDir, projectFile });
  const profileName =
    (await readActiveProfile(configDir)) ?? config.settings?.default_profile ?? "default";
  return { config, configDir, profileName };
}

// ── Tool definitions ────────────────────────────────────────────

function defineTools(): ToolEntry[] {
  return [
    // ── Read-only tier ────────────────────────────────────────
    {
      def: {
        name: "am_list_servers",
        description:
          "List MCP servers in the agent-manager config. Returns name, command, args, tags, enabled status for each server.",
        inputSchema: {
          type: "object",
          properties: {
            active: {
              type: "boolean",
              description: "If true, show only enabled servers",
            },
          },
        },
      },
      tier: "read-only",
      handler: async (args) => {
        const { config } = await loadConfigAndProfile();
        const servers = config.servers ?? {};
        let entries = Object.entries(servers).map(([name, srv]) => ({
          name,
          command: srv.command,
          args: srv.args ?? [],
          tags: srv.tags ?? [],
          enabled: srv.enabled ?? true,
          description: srv.description ?? "",
          transport: srv.transport ?? "stdio",
        }));
        if (args.active) {
          entries = entries.filter((s) => s.enabled);
        }
        return { servers: entries };
      },
    },
    {
      def: {
        name: "am_list_profiles",
        description: "List available profiles and indicate which one is active.",
        inputSchema: { type: "object", properties: {} },
      },
      tier: "read-only",
      handler: async () => {
        const { config, configDir } = await loadConfigAndProfile();
        const profiles = config.profiles ?? {};
        const activeProfile =
          (await readActiveProfile(configDir)) ?? config.settings?.default_profile ?? "default";
        const entries = Object.entries(profiles).map(([name, profile]) => ({
          name,
          description: profile.description ?? "",
          inherits: profile.inherits ?? null,
          active: name === activeProfile,
        }));
        return { profiles: entries, activeProfile };
      },
    },
    {
      def: {
        name: "am_status",
        description:
          "Check drift detection and sync state. Returns profile, server count, git status, and per-tool drift status.",
        inputSchema: { type: "object", properties: {} },
      },
      tier: "read-only",
      handler: async () => {
        const { config, configDir, profileName } = await loadConfigAndProfile();
        let gitStatus;
        try {
          gitStatus = await getStatus(configDir);
        } catch {
          gitStatus = { branch: "unknown", clean: true, dirty: [], remotes: [] };
        }
        const resolved = buildResolvedConfig(config, profileName, configDir);
        const serverCount = Object.keys(resolved.servers).length;
        const adapters = await getDetectedAdapters();
        const toolStatuses: Array<{ name: string; status: string; changes: number }> = [];
        for (const adapter of adapters) {
          try {
            const diffResult = adapter.diff(resolved);
            toolStatuses.push({
              name: adapter.meta.displayName,
              status: diffResult.status,
              changes: diffResult.changes.length,
            });
          } catch {
            toolStatuses.push({ name: adapter.meta.displayName, status: "unknown", changes: 0 });
          }
        }
        return {
          profile: profileName,
          servers: serverCount,
          git: {
            branch: gitStatus.branch,
            clean: gitStatus.clean,
            dirty: gitStatus.dirty,
            remotes: gitStatus.remotes,
          },
          tools: toolStatuses,
        };
      },
    },
    {
      def: {
        name: "am_config_show",
        description:
          "Show the fully resolved agent-manager configuration (merged global + local + project configs).",
        inputSchema: { type: "object", properties: {} },
      },
      tier: "read-only",
      handler: async () => {
        const { config, profileName } = await loadConfigAndProfile();
        return { profile: profileName, config: redactSecrets(config) };
      },
    },

    // ── Session tools (read-only) ──────────────────────────────
    {
      def: {
        name: "am_session_list",
        description:
          "List AI coding sessions across all tools (or a specific adapter). Returns session summaries with message counts, timestamps, and token estimates.",
        inputSchema: {
          type: "object",
          properties: {
            adapter: {
              type: "string",
              description: "Filter to a specific adapter (e.g., 'claude-code', 'codex-cli')",
            },
          },
        },
      },
      tier: "read-only",
      handler: async (args) => {
        const adapterFilter = args.adapter as string | undefined;
        const allSummaries: SessionSummary[] = [];

        const adapterNames = adapterFilter ? [adapterFilter] : listAdapters();

        for (const name of adapterNames) {
          const adapter = await getAdapter(name);
          if (!adapter?.sessionReader) continue;
          if (!adapter.sessionReader.hasSessionStorage()) continue;

          try {
            const summaries = await adapter.sessionReader.listSessions();
            allSummaries.push(...summaries);
          } catch {
            // Skip adapters that fail to list sessions
          }
        }

        // Sort by most recent first
        allSummaries.sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime());

        return {
          sessions: allSummaries.map((s) => ({
            ...s,
            startedAt: s.startedAt.toISOString(),
            endedAt: s.endedAt?.toISOString() ?? null,
          })),
          total: allSummaries.length,
        };
      },
    },
    {
      def: {
        name: "am_session_export",
        description:
          "Export an AI coding session by ID. Supports filtering by role, stripping tool/system messages, and markdown or JSON output.",
        inputSchema: {
          type: "object",
          properties: {
            id: { type: "string", description: "Session ID to export" },
            adapter: {
              type: "string",
              description: "Adapter name that owns this session (e.g., 'claude-code')",
            },
            role: {
              type: "string",
              description: "Filter to a specific role: user, assistant, system, tool",
            },
            noTools: {
              type: "boolean",
              description: "Strip tool-role messages",
            },
            noSystem: {
              type: "boolean",
              description: "Strip system-role messages",
            },
            format: {
              type: "string",
              enum: ["md", "json"],
              description: "Output format: 'md' (markdown, default) or 'json'",
            },
          },
          required: ["id", "adapter"],
        },
      },
      tier: "read-only",
      handler: async (args) => {
        const id = args.id as string;
        const adapterName = args.adapter as string;
        const format = (args.format as string) ?? "md";

        const adapter = await getAdapter(adapterName);
        if (!adapter?.sessionReader) {
          throw new Error(`Adapter "${adapterName}" does not support session reading`);
        }

        const session = await adapter.sessionReader.loadSession(id);
        if (!session) {
          throw new Error(`Session "${id}" not found in ${adapterName}`);
        }

        const filter = {
          ...(args.role ? { roles: [args.role as "user" | "assistant" | "system" | "tool"] } : {}),
          ...(args.noTools ? { noTools: true } : {}),
          ...(args.noSystem ? { noSystem: true } : {}),
        };

        if (format === "json") {
          return formatJson(session, filter);
        }
        return {
          content: formatMarkdown(session, filter),
        };
      },
    },
    {
      def: {
        name: "am_session_search",
        description:
          "Search AI coding sessions for a query string. Returns matching sessions with message snippets containing the query.",
        inputSchema: {
          type: "object",
          properties: {
            query: { type: "string", description: "Text to search for in session messages" },
            adapter: {
              type: "string",
              description: "Filter to a specific adapter",
            },
            role: {
              type: "string",
              description: "Filter to a specific message role",
            },
          },
          required: ["query"],
        },
      },
      tier: "read-only",
      handler: async (args) => {
        const query = args.query as string;
        const adapterFilter = args.adapter as string | undefined;
        const roleFilter = args.role as string | undefined;

        const adapterNames = adapterFilter ? [adapterFilter] : listAdapters();
        const results: Array<{
          sessionId: string;
          adapter: string;
          project: string | null;
          matches: Array<{ role: string; snippet: string }>;
        }> = [];

        for (const name of adapterNames) {
          const adapter = await getAdapter(name);
          if (!adapter?.sessionReader) continue;
          if (!adapter.sessionReader.hasSessionStorage()) continue;

          let summaries;
          try {
            summaries = await adapter.sessionReader.listSessions();
          } catch {
            continue;
          }

          for (const summary of summaries) {
            let session;
            try {
              session = await adapter.sessionReader.loadSession(summary.id);
            } catch {
              continue;
            }
            if (!session) continue;

            const filter = {
              query,
              ...(roleFilter
                ? { roles: [roleFilter as "user" | "assistant" | "system" | "tool"] }
                : {}),
            };
            const matched = filterMessages(session.messages, filter);

            if (matched.length > 0) {
              results.push({
                sessionId: summary.id,
                adapter: name,
                project: session.project ?? null,
                matches: matched.slice(0, 5).map((m) => ({
                  role: m.role,
                  snippet: m.content.length > 200 ? `${m.content.slice(0, 200)}...` : m.content,
                })),
              });
            }
          }
        }

        return { query, results, total: results.length };
      },
    },

    // ── Write-local tier ──────────────────────────────────────
    {
      def: {
        name: "am_add_server",
        description: "Add an MCP server to the agent-manager catalog.",
        inputSchema: {
          type: "object",
          properties: {
            name: { type: "string", description: "Server name (unique identifier)" },
            command: { type: "string", description: "Command to run the server" },
            args: {
              type: "array",
              items: { type: "string" },
              description: "Command arguments",
            },
            tags: {
              type: "array",
              items: { type: "string" },
              description: "Tags for categorization",
            },
            description: { type: "string", description: "Human-readable description" },
            env: {
              type: "object",
              additionalProperties: { type: "string" },
              description: "Environment variables",
            },
          },
          required: ["name", "command"],
        },
      },
      tier: "write-local",
      handler: async (args) => {
        const configDir = resolveConfigDir();
        const configPath = join(configDir, "config.toml");
        const config = await readConfig(configPath);
        const name = args.name as string;

        if (config.servers?.[name]) {
          throw new Error(`Server "${name}" already exists`);
        }

        if (!config.servers) config.servers = {};
        config.servers[name] = {
          command: args.command as string,
          ...(args.args ? { args: args.args as string[] } : {}),
          ...(args.tags ? { tags: args.tags as string[] } : {}),
          ...(args.description ? { description: args.description as string } : {}),
          ...(args.env ? { env: args.env as Record<string, string> } : {}),
          transport: "stdio",
          enabled: true,
        };

        await writeConfig(configPath, config);
        try {
          await commitAll(configDir, `add server: ${name}`);
        } catch {
          // Nothing to commit
        }
        return { action: "add", server: name };
      },
    },
    {
      def: {
        name: "am_remove_server",
        description: "Remove an MCP server from the agent-manager catalog.",
        inputSchema: {
          type: "object",
          properties: {
            name: { type: "string", description: "Server name to remove" },
          },
          required: ["name"],
        },
      },
      tier: "write-local",
      handler: async (args) => {
        const configDir = resolveConfigDir();
        const configPath = join(configDir, "config.toml");
        const config = await readConfig(configPath);
        const name = args.name as string;

        if (!config.servers?.[name]) {
          throw new Error(`Server "${name}" not found`);
        }

        delete config.servers[name];
        await writeConfig(configPath, config);
        try {
          await commitAll(configDir, `remove server: ${name}`);
        } catch {
          // Nothing to commit
        }
        return { action: "remove", server: name };
      },
    },
    {
      def: {
        name: "am_use_profile",
        description: "Switch the active profile.",
        inputSchema: {
          type: "object",
          properties: {
            profile: { type: "string", description: "Profile name to activate" },
          },
          required: ["profile"],
        },
      },
      tier: "write-local",
      handler: async (args) => {
        const configDir = resolveConfigDir();
        const configPath = join(configDir, "config.toml");
        const config = await readConfig(configPath);
        const profile = args.profile as string;

        const profiles = config.profiles ?? {};
        if (Object.keys(profiles).length > 0 && !profiles[profile]) {
          throw new Error(
            `Profile "${profile}" not found. Available: ${Object.keys(profiles).join(", ")}`,
          );
        }

        await writeActiveProfile(configDir, profile);
        return { action: "use", profile };
      },
    },
    {
      def: {
        name: "am_import",
        description:
          "Import MCP servers from a tool's native config (e.g., 'claude-code', 'cursor', or 'auto' for all detected tools).",
        inputSchema: {
          type: "object",
          properties: {
            source: {
              type: "string",
              description: "Adapter name or 'auto' for all detected tools",
            },
          },
          required: ["source"],
        },
      },
      tier: "write-local",
      handler: async (args) => {
        const configDir = resolveConfigDir();
        const configPath = join(configDir, "config.toml");
        const config = await readConfig(configPath);
        const source = args.source as string;

        let adapters;
        if (source === "auto") {
          adapters = await getDetectedAdapters();
          if (adapters.length === 0) {
            return { action: "import", source, imported: 0, message: "No tools detected" };
          }
        } else {
          const adapter = await getAdapter(source);
          if (!adapter) {
            throw new Error(
              `Adapter "${source}" not found. Available: ${listAdapters().join(", ")}`,
            );
          }
          adapters = [adapter];
        }

        let totalImported = 0;
        if (!config.servers) config.servers = {};

        for (const adapter of adapters) {
          try {
            const result = adapter.import({});
            for (const srv of result.servers) {
              if (!config.servers[srv.name]) {
                config.servers[srv.name] = {
                  command: srv.command,
                  args: srv.args,
                  env: srv.env,
                  transport: srv.transport ?? "stdio",
                  description: srv.description,
                  tags: srv.tags,
                  enabled: srv.enabled ?? true,
                };
                totalImported++;
              }
            }
          } catch {
            // Skip adapters that fail to import
          }
        }

        await writeConfig(configPath, config);
        if (totalImported > 0) {
          try {
            await commitAll(configDir, `import: ${source} (${totalImported} servers)`);
          } catch {
            // Nothing to commit
          }
        }

        return { action: "import", source, imported: totalImported };
      },
    },

    // ── Registry tools (read-only + write-local) ─────────────
    {
      def: {
        name: "am_registry_search",
        description:
          "Search the MCP registry for server packages. Returns package names, descriptions, versions, and install status.",
        inputSchema: {
          type: "object",
          properties: {
            query: { type: "string", description: "Search query" },
            tag: { type: "string", description: "Filter by tag" },
            verified: {
              type: "boolean",
              description: "Show only verified packages",
            },
            limit: {
              type: "number",
              description: "Max results (default: 20)",
            },
          },
          required: ["query"],
        },
      },
      tier: "read-only",
      handler: async (args) => {
        const { search } = await import("../registry/client");
        const filters: Record<string, unknown> = {};
        if (args.tag) filters.tag = args.tag;
        if (args.verified) filters.verified = true;
        if (args.limit) filters.limit = args.limit;
        if (!filters.limit) filters.limit = 20;
        const result = await search(args.query as string, filters as any);
        return result;
      },
    },
    {
      def: {
        name: "am_registry_install",
        description:
          "Install an MCP server package from the registry into the agent-manager config. Resolves package metadata, adds the server entry, and auto-commits.",
        inputSchema: {
          type: "object",
          properties: {
            name: {
              type: "string",
              description: "Package name to install",
            },
            env: {
              type: "object",
              additionalProperties: { type: "string" },
              description: "Environment variable values for the server (key-value pairs)",
            },
          },
          required: ["name"],
        },
      },
      tier: "write-local",
      handler: async (args) => {
        const { getPackage: getPkg } = await import("../registry/client");
        const pkgName = args.name as string;
        const pkg = await getPkg(pkgName);
        if (!pkg) {
          throw new Error(`Package "${pkgName}" not found in the registry`);
        }

        const configDir = resolveConfigDir();
        const configPath = join(configDir, "config.toml");
        const config = await readConfig(configPath);

        if (config.servers?.[pkg.name]) {
          throw new Error(
            `Server "${pkg.name}" already exists. Remove it first or use am_remove_server.`,
          );
        }

        // Build env from provided values + defaults
        const env: Record<string, string> = {};
        const providedEnv = (args.env as Record<string, string>) ?? {};
        for (const envVar of pkg.server.env ?? []) {
          if (providedEnv[envVar.name]) {
            env[envVar.name] = providedEnv[envVar.name];
          } else if (envVar.default) {
            env[envVar.name] = envVar.default;
          } else if (envVar.required) {
            env[envVar.name] = `\${${envVar.name}}`;
          }
        }

        if (!config.servers) config.servers = {};
        config.servers[pkg.name] = {
          command: pkg.server.command,
          ...(pkg.server.args ? { args: pkg.server.args } : {}),
          ...(Object.keys(env).length > 0 ? { env } : {}),
          transport: pkg.server.transport ?? "stdio",
          enabled: true,
          description: pkg.description,
          tags: pkg.tags,
          _registry: {
            source: "mcp-registry",
            package: pkg.name,
            version: pkg.version,
            installed_at: new Date().toISOString(),
          },
        } as any;

        await writeConfig(configPath, config);
        try {
          await commitAll(configDir, `registry install: ${pkg.name}`);
        } catch {
          // Nothing to commit
        }
        return {
          action: "install",
          package: pkg.name,
          version: pkg.version,
        };
      },
    },
    {
      def: {
        name: "am_registry_list_installed",
        description:
          "List all MCP servers that were installed from the registry, including their provenance metadata (package name, version, install date).",
        inputSchema: { type: "object", properties: {} },
      },
      tier: "read-only",
      handler: async () => {
        const { config } = await loadConfigAndProfile();
        const servers = config.servers ?? {};
        const installed: Array<{
          name: string;
          command: string;
          package: string;
          version: string;
          installed_at: string;
          enabled: boolean;
        }> = [];

        for (const [name, srv] of Object.entries(servers)) {
          const provenance = (srv as any)._registry as
            | { source: string; package: string; version: string; installed_at: string }
            | undefined;
          if (provenance?.source === "mcp-registry") {
            installed.push({
              name,
              command: srv.command,
              package: provenance.package,
              version: provenance.version,
              installed_at: provenance.installed_at,
              enabled: srv.enabled ?? true,
            });
          }
        }

        return { servers: installed, total: installed.length };
      },
    },

    // ── Write-remote tier ─────────────────────────────────────
    {
      def: {
        name: "am_apply",
        description:
          "Generate native IDE/tool configs from the agent-manager catalog. Writes config files for detected tools (Claude Code, Cursor, etc.).",
        inputSchema: {
          type: "object",
          properties: {
            target: {
              type: "string",
              description: "Apply to a specific adapter only (e.g., 'claude-code')",
            },
            dryRun: {
              type: "boolean",
              description: "Preview changes without writing files",
            },
          },
        },
      },
      tier: "write-local",
      handler: async (args) => {
        const { config, configDir, profileName } = await loadConfigAndProfile();

        // Decrypt encrypted values before applying
        const encryptionKey = await loadKey(configDir);
        const { config: decrypted } = await interpolateEnvAsync(config, {
          encryptionKey: encryptionKey ?? undefined,
        });
        const resolved = buildResolvedConfig(decrypted, profileName, configDir);
        const projectFile = resolveProjectConfig(process.cwd());

        let adapters;
        if (args.target) {
          const adapter = await getAdapter(args.target as string);
          if (!adapter) {
            throw new Error(
              `Adapter "${args.target}" not found. Available: ${listAdapters().join(", ")}`,
            );
          }
          adapters = [adapter];
        } else {
          adapters = await getDetectedAdapters();
        }

        const results: Array<{ adapter: string; files: number; warnings: string[] }> = [];
        for (const adapter of adapters) {
          try {
            const result = adapter.export(resolved, {
              projectPath: projectFile ? join(projectFile, "..") : undefined,
              dryRun: !!args.dryRun,
            });
            results.push({
              adapter: adapter.meta.name,
              files: result.files.filter((f) => f.written).length,
              warnings: result.warnings,
            });
          } catch (e: any) {
            results.push({
              adapter: adapter.meta.name,
              files: 0,
              warnings: [e?.message ?? "export failed"],
            });
          }
        }

        return { action: "apply", profile: profileName, dryRun: !!args.dryRun, results };
      },
    },
    {
      def: {
        name: "am_sync_push",
        description: "Push agent-manager config changes to the git remote.",
        inputSchema: { type: "object", properties: {} },
      },
      tier: "write-remote",
      handler: async () => {
        const { configDir } = await loadConfigAndProfile();

        const status = await getStatus(configDir);
        if (status.remotes.length === 0) {
          throw new Error("No remote configured. Add a remote URL to your config repo.");
        }

        await push(configDir);
        return { action: "push", remote: status.remotes[0].url, branch: status.branch };
      },
    },
    {
      def: {
        name: "am_sync_pull",
        description: "Pull agent-manager config changes from the git remote.",
        inputSchema: { type: "object", properties: {} },
      },
      tier: "write-remote",
      handler: async () => {
        const { configDir } = await loadConfigAndProfile();

        const status = await getStatus(configDir);
        if (status.remotes.length === 0) {
          throw new Error("No remote configured. Add a remote URL to your config repo.");
        }

        await pull(configDir);
        return { action: "pull", remote: status.remotes[0].url, branch: status.branch };
      },
    },

    // ── A2A Agent tools (ADR-0017) ──────────────────────────────
    {
      def: {
        name: "am_agent_discover",
        description:
          "Discover an A2A agent by fetching its Agent Card from a URL. Returns the agent's name, description, skills, and capabilities.",
        inputSchema: {
          type: "object",
          properties: {
            url: { type: "string", description: "Base URL of the A2A agent to discover" },
          },
          required: ["url"],
        },
      },
      tier: "read-only",
      handler: async (args) => {
        const { discoverFromUrl } = await import("../protocols/a2a/discovery");
        const url = args.url as string;
        const card = await discoverFromUrl(url);
        if (!card) {
          return { error: `No A2A Agent Card found at ${url}` };
        }
        return { card };
      },
    },
    {
      def: {
        name: "am_agent_list",
        description: "List all registered A2A agents from the local agent roster.",
        inputSchema: { type: "object", properties: {} },
      },
      tier: "read-only",
      handler: async () => {
        const { loadRoster } = await import("../protocols/a2a/discovery");
        const configDir = resolveConfigDir();
        const roster = await loadRoster(configDir);
        return {
          agents: roster.map((r) => ({
            name: r.name,
            url: r.url,
            description: r.description,
            addedAt: r.addedAt,
            lastSeen: r.lastSeen,
          })),
          total: roster.length,
        };
      },
    },
    {
      def: {
        name: "am_agent_delegate",
        description:
          "Send a task to a registered A2A agent. The agent must be in the local roster (use am_agent_list to see available agents).",
        inputSchema: {
          type: "object",
          properties: {
            name: { type: "string", description: "Agent name from the roster" },
            message: { type: "string", description: "Task message to send to the agent" },
          },
          required: ["name", "message"],
        },
      },
      tier: "write-remote",
      handler: async (args) => {
        const { loadRoster } = await import("../protocols/a2a/discovery");
        const { A2AClient } = await import("../protocols/a2a/client");
        const configDir = resolveConfigDir();
        const roster = await loadRoster(configDir);
        const name = args.name as string;
        const message = args.message as string;

        const entry = roster.find((r) => r.name === name);
        if (!entry) {
          throw new Error(
            `Agent "${name}" not found in roster. Available: ${roster.map((r) => r.name).join(", ") || "(none)"}`,
          );
        }

        const client = new A2AClient({ timeout: 60_000 });
        const taskId = `am-mcp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

        const result = await client.sendTask(entry.url, {
          id: taskId,
          message: {
            role: "user",
            parts: [{ type: "text", text: message }],
          },
        });

        return { agent: name, task: result };
      },
    },
    {
      def: {
        name: "am_agent_task_status",
        description: "Query the status of a previously delegated A2A task.",
        inputSchema: {
          type: "object",
          properties: {
            name: { type: "string", description: "Agent name from the roster" },
            taskId: { type: "string", description: "Task ID returned from am_agent_delegate" },
          },
          required: ["name", "taskId"],
        },
      },
      tier: "read-only",
      handler: async (args) => {
        const { loadRoster } = await import("../protocols/a2a/discovery");
        const { A2AClient } = await import("../protocols/a2a/client");
        const configDir = resolveConfigDir();
        const roster = await loadRoster(configDir);
        const name = args.name as string;
        const taskId = args.taskId as string;

        const entry = roster.find((r) => r.name === name);
        if (!entry) {
          throw new Error(`Agent "${name}" not found in roster.`);
        }

        const client = new A2AClient({ timeout: 30_000 });
        const result = await client.getTask(entry.url, { id: taskId });
        return { agent: name, task: result };
      },
    },

    // ── Wiki tools (ADR-0020) ─────────────────────────────────
    {
      def: {
        name: "am_wiki_search",
        description:
          "Search the LLM Wiki knowledge base. Returns matching entries ranked by relevance.",
        inputSchema: {
          type: "object",
          properties: {
            query: { type: "string", description: "Search query" },
            limit: {
              type: "number",
              description: "Maximum results to return (default: 20)",
            },
          },
          required: ["query"],
        },
      },
      tier: "read-only",
      handler: async (args) => {
        const { searchEntries } = await import("../wiki/storage");
        const query = args.query as string;
        const limit = (args.limit as number) ?? 20;
        const entries = await searchEntries(query);
        return { query, results: entries.slice(0, limit), total: entries.length };
      },
    },
    {
      def: {
        name: "am_wiki_add",
        description:
          "Add a knowledge entry to the LLM Wiki. Supports types: fact, procedure, preference, relationship, capability.",
        inputSchema: {
          type: "object",
          properties: {
            type: {
              type: "string",
              enum: ["fact", "procedure", "preference", "relationship", "capability"],
              description: "Entity type",
            },
            content: { type: "string", description: "Entry content" },
            context: { type: "string", description: "Optional context" },
            tags: {
              type: "array",
              items: { type: "string" },
              description: "Tags for categorization",
            },
            confidence: {
              type: "number",
              description: "Confidence score 0.0-1.0 (default: 0.7)",
            },
          },
          required: ["type", "content"],
        },
      },
      tier: "write-local",
      handler: async (args) => {
        const { addEntry } = await import("../wiki/storage");
        const now = new Date().toISOString();
        const entry = {
          id: crypto.randomUUID(),
          source: { type: "manual" as const, timestamp: now },
          extracted_at: now,
          confidence: (args.confidence as number) ?? 0.7,
          entity_type: args.type as
            | "fact"
            | "procedure"
            | "preference"
            | "relationship"
            | "capability",
          content: args.content as string,
          context: (args.context as string) ?? "",
          tags: (args.tags as string[]) ?? [],
          references: [],
          provenance: {
            created_by: "mcp",
            created_at: now,
            last_modified: now,
            modification_history: [
              {
                timestamp: now,
                action: "created" as const,
                by: "mcp",
                details: "Added via MCP tool",
              },
            ],
            verified: false,
          },
        };
        await addEntry(entry);
        return { action: "add", entry };
      },
    },
    {
      def: {
        name: "am_wiki_synthesize",
        description:
          "Generate a context block from the knowledge base for a given query. Returns relevant entries formatted as markdown.",
        inputSchema: {
          type: "object",
          properties: {
            query: { type: "string", description: "Topic or question" },
            agent_id: { type: "string", description: "Filter to a specific agent" },
            top_k: {
              type: "number",
              description: "Number of entries to include (default: 10)",
            },
          },
          required: ["query"],
        },
      },
      tier: "read-only",
      handler: async (args) => {
        const { synthesizeContext } = await import("../wiki/synthesizer");
        const context = await synthesizeContext(args.query as string, {
          agentId: args.agent_id as string | undefined,
          topK: (args.top_k as number) ?? 10,
        });
        return { query: args.query, context };
      },
    },
    {
      def: {
        name: "am_wiki_briefing",
        description:
          "Generate an agent briefing from the knowledge base. Returns a markdown document with facts, procedures, preferences, and gaps.",
        inputSchema: {
          type: "object",
          properties: {
            agent_id: { type: "string", description: "Agent/adapter ID" },
          },
          required: ["agent_id"],
        },
      },
      tier: "read-only",
      handler: async (args) => {
        const { getAllEntries } = await import("../wiki/storage");
        const { buildAgentBriefing } = await import("../wiki/synthesizer");
        const entries = await getAllEntries();
        const briefing = buildAgentBriefing(entries, args.agent_id as string);
        return { agent_id: args.agent_id, briefing };
      },
    },
    {
      def: {
        name: "am_wiki_harvest",
        description:
          "Trigger knowledge extraction from a specific session. Extracts facts, procedures, preferences, and capabilities.",
        inputSchema: {
          type: "object",
          properties: {
            adapter: {
              type: "string",
              description: "Adapter name (e.g., 'claude-code', 'codex-cli')",
            },
            session_id: { type: "string", description: "Session ID within the adapter" },
          },
          required: ["adapter", "session_id"],
        },
      },
      tier: "write-local",
      handler: async (args) => {
        const adapterName = args.adapter as string;
        const sessionId = args.session_id as string;

        const adapter = await getAdapter(adapterName);
        if (!adapter?.sessionReader) {
          throw new Error(`Adapter "${adapterName}" does not support session reading`);
        }

        const session = await adapter.sessionReader.loadSession(sessionId);
        if (!session) {
          throw new Error(`Session "${sessionId}" not found in ${adapterName}`);
        }

        const { harvestSession } = await import("../wiki/harvester");
        const { addEntry } = await import("../wiki/storage");
        const entries = await harvestSession(session);
        let added = 0;
        for (const entry of entries) {
          try {
            await addEntry(entry);
            added++;
          } catch {
            // Skip duplicates
          }
        }

        return {
          action: "harvest",
          adapter: adapterName,
          session_id: sessionId,
          entries_extracted: entries.length,
          entries_added: added,
        };
      },
    },
  ];
}

// ── MCP Server class ────────────────────────────────────────────

export class McpServer {
  private tools: ToolEntry[];
  private settings?: Settings;

  constructor() {
    this.tools = defineTools();
  }

  /** Re-read settings from config for fresh permission checks. */
  private async refreshSettings(): Promise<void> {
    try {
      const configDir = resolveConfigDir();
      const projectFile = resolveProjectConfig(process.cwd());
      const config = await loadResolvedConfig({ configDir, projectFile });
      this.settings = config.settings;
    } catch {
      // Keep existing settings if re-read fails
    }
  }

  /** Process a single JSON-RPC request and return a response. */
  async handleRequest(req: JsonRpcRequest): Promise<JsonRpcResponse | null> {
    const id = req.id ?? null;

    // Refresh settings before handling tool calls so permission checks are never stale
    if (req.method === "tools/call") {
      await this.refreshSettings();
    }

    switch (req.method) {
      case "initialize":
        return {
          jsonrpc: "2.0",
          id,
          result: {
            protocolVersion: "2024-11-05",
            capabilities: { tools: {} },
            serverInfo: {
              name: "agent-manager",
              version: "0.1.0",
            },
          },
        };

      case "notifications/initialized":
        // Client acknowledgement — no response needed
        return null;

      case "tools/list":
        return {
          jsonrpc: "2.0",
          id,
          result: {
            tools: this.tools.map((t) => t.def),
          },
        };

      case "tools/call": {
        const params = req.params ?? {};
        const toolName = params.name as string;
        const toolArgs = (params.arguments as Record<string, unknown>) ?? {};

        const tool = this.tools.find((t) => t.def.name === toolName);
        if (!tool) {
          return {
            jsonrpc: "2.0",
            id,
            error: {
              code: -32601,
              message: `Unknown tool: ${toolName}`,
            },
          };
        }

        // Permission check
        const perm = checkPermission(tool.tier, this.settings);
        if (!perm.allowed) {
          return {
            jsonrpc: "2.0",
            id,
            result: {
              content: [{ type: "text", text: JSON.stringify({ error: perm.reason }) }],
              isError: true,
            },
          };
        }

        try {
          const result = await tool.handler(toolArgs);
          return {
            jsonrpc: "2.0",
            id,
            result: {
              content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
            },
          };
        } catch (err: any) {
          return {
            jsonrpc: "2.0",
            id,
            result: {
              content: [
                { type: "text", text: JSON.stringify({ error: err?.message ?? String(err) }) },
              ],
              isError: true,
            },
          };
        }
      }

      default:
        // Unknown method
        if (req.id != null) {
          return {
            jsonrpc: "2.0",
            id,
            error: {
              code: -32601,
              message: `Method not found: ${req.method}`,
            },
          };
        }
        // Notifications (no id) get no response
        return null;
    }
  }

  /** Run the server on stdio, reading newline-delimited JSON-RPC from stdin. */
  async serve(): Promise<void> {
    // Load settings once at startup for permission checks
    try {
      const configDir = resolveConfigDir();
      const projectFile = resolveProjectConfig(process.cwd());
      const config = await loadResolvedConfig({ configDir, projectFile });
      this.settings = config.settings;
    } catch {
      // No config yet — all write-remote tools will be denied
    }

    const decoder = new TextDecoder();
    let buffer = "";

    for await (const chunk of Bun.stdin.stream()) {
      buffer += decoder.decode(chunk, { stream: true });

      let newlineIdx: number = buffer.indexOf("\n");
      while (newlineIdx !== -1) {
        const line = buffer.substring(0, newlineIdx).trim();
        buffer = buffer.substring(newlineIdx + 1);

        if (!line) continue;

        let req: JsonRpcRequest;
        try {
          req = JSON.parse(line);
        } catch {
          const errResp: JsonRpcResponse = {
            jsonrpc: "2.0",
            id: null,
            error: { code: -32700, message: "Parse error" },
          };
          process.stdout.write(`${JSON.stringify(errResp)}\n`);
          continue;
        }

        if (Array.isArray(req)) {
          const responses = await Promise.all(
            req.map((r: JsonRpcRequest) => this.handleRequest(r)),
          );
          const filtered = responses.filter(Boolean);
          if (filtered.length > 0) {
            process.stdout.write(`${JSON.stringify(filtered)}\n`);
          }
          continue;
        }

        const resp = await this.handleRequest(req);
        if (resp) {
          process.stdout.write(`${JSON.stringify(resp)}\n`);
        }
        newlineIdx = buffer.indexOf("\n");
      }
    }
  }

  /** Expose tools for testing. */
  getTools(): ToolEntry[] {
    return this.tools;
  }

  /** Set settings for permission checks (useful for testing). */
  setSettings(settings: Settings): void {
    this.settings = settings;
  }
}
