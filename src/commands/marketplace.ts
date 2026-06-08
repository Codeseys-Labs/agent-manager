/**
 * Marketplace is DEFERRED to v2 (it pairs with the hosted web platform), NOT
 * deleted — ADR-0039 (retire) and ADR-0052 (deletion) are superseded by that
 * product decision (see AGENTS.md pillar 4 / ROADMAP.md). The command surface
 * is retained but kept out of the v1 CLI's advertised path. For v1, use the MCP
 * Registry (`am search`/`am install`) for servers and git submodule/subtree
 * bundles for skills/instructions/agents.
 */
import { defineCommand } from "citty";
import { type OutputOptions, amError, debug, error, info, output, warn } from "../lib/output";
import {
  addMarketplace,
  deriveMarketplaceName,
  listMarketplaces,
  removeMarketplace,
  updateMarketplace,
} from "../marketplace/client";
import { installPlugin, listInstalled, uninstallPlugin } from "../marketplace/installer";
import { scanAllMarketplaces, searchPlugins } from "../marketplace/scanner";
import { formatValidateSummary, validateMarketplace } from "../marketplace/validate";

// ADR-0039/0052 are SUPERSEDED: marketplace is DEFERRED to v2 (it pairs with the
// hosted web platform), NOT deleted. The runtime notice must match that product
// decision — "deprecated, will be removed" was a stale message that contradicted
// AGENTS.md / ROADMAP.md and read as the feature dying.
const MARKETPLACE_DEFERRED_NOTICE =
  "am marketplace is deferred to v2 (it pairs with the hosted web platform). " +
  "For v1, use `am search` / `am install` for MCP servers and a git submodule/subtree " +
  "(`am add skill --path …`) to vendor skills and agents.";

let marketplaceDeferredNoticeShown = false;

// Route through the output helper (not console.error) so the notice respects
// --quiet / --json output modes (CLI convention; CodeRabbit MD on #44).
function warnMarketplaceDeprecated(opts: OutputOptions): void {
  if (marketplaceDeferredNoticeShown) return;
  marketplaceDeferredNoticeShown = true;
  warn(MARKETPLACE_DEFERRED_NOTICE, opts);
}

// ── Subcommands ──────────────────────────────────────────────────

const addCommand = defineCommand({
  meta: { name: "add", description: "Add a marketplace by cloning a git repo" },
  args: {
    url: { type: "positional", description: "Git URL or local path to clone", required: true },
    name: { type: "string", description: "Alias for the marketplace (defaults to repo name)" },
    yes: {
      type: "boolean",
      alias: "y",
      description: "Skip trust-on-first-use prompt",
      default: false,
    },
    "allow-http": {
      type: "boolean",
      description: "Allow http:// URLs (insecure)",
      default: false,
    },
    "allow-file": {
      type: "boolean",
      description: "Allow file:// URLs (for local testing)",
      default: false,
    },
    "allow-nonstandard-port": {
      type: "boolean",
      description: "Allow ports other than 443/80",
      default: false,
    },
    "max-clone-bytes": {
      type: "string",
      description: "Maximum clone size in bytes (default 100MiB)",
    },
    "clone-timeout": {
      type: "string",
      description: "Clone timeout in milliseconds (default 60000)",
    },
    json: { type: "boolean", default: false },
    quiet: { type: "boolean", alias: "q", default: false },
    verbose: { type: "boolean", alias: "v", default: false },
  },
  async run({ args }) {
    const opts = { json: args.json, quiet: args.quiet, verbose: args.verbose };
    warnMarketplaceDeprecated(opts);
    try {
      debug(`Adding marketplace from ${args.url}`, opts);
      const maxBytes = args["max-clone-bytes"]
        ? Number.parseInt(args["max-clone-bytes"] as string, 10)
        : undefined;
      const timeoutMs = args["clone-timeout"]
        ? Number.parseInt(args["clone-timeout"] as string, 10)
        : undefined;
      const entry = await addMarketplace(args.url, args.name, {
        yes: args.yes,
        allowHttp: args["allow-http"],
        allowFile: args["allow-file"],
        allowNonstandardPort: args["allow-nonstandard-port"],
        maxCloneBytes: maxBytes,
        cloneTimeoutMs: timeoutMs,
      });
      info(`Added marketplace "${entry.name}" from ${entry.url}`, opts);
      if (entry.commit) {
        info(`  Pinned commit: ${entry.commit.slice(0, 12)}`, opts);
      }
      output({ action: "add", marketplace: entry }, opts);
    } catch (err) {
      amError(err, opts);
      process.exitCode = 1;
    }
  },
});

const listCommand = defineCommand({
  meta: { name: "list", description: "List marketplaces and available plugins" },
  args: {
    installed: {
      type: "boolean",
      description: "Show only installed plugins",
      default: false,
    },
    json: { type: "boolean", default: false },
    quiet: { type: "boolean", alias: "q", default: false },
    verbose: { type: "boolean", alias: "v", default: false },
  },
  async run({ args }) {
    const opts = { json: args.json, quiet: args.quiet, verbose: args.verbose };
    warnMarketplaceDeprecated(opts);
    try {
      if (args.installed) {
        const installed = await listInstalled();
        if (args.json) {
          output({ installed }, opts);
          return;
        }
        if (installed.length === 0) {
          info("No plugins installed from marketplaces.", opts);
          return;
        }
        info("Installed marketplace plugins:", opts);
        for (const entry of installed) {
          info(
            `  ${entry.plugin} (${entry.servers.length} server${entry.servers.length === 1 ? "" : "s"})`,
            opts,
          );
        }
        return;
      }

      const marketplaces = await listMarketplaces();
      if (marketplaces.length === 0) {
        info("No marketplaces added. Run `am marketplace add <git-url>` to add one.", opts);
        if (args.json) output({ marketplaces: [], plugins: [] }, opts);
        return;
      }

      const plugins = await scanAllMarketplaces();

      if (args.json) {
        output(
          {
            marketplaces,
            plugins: plugins.map((p) => ({
              name: p.manifest.name,
              description: p.manifest.description,
              version: p.manifest.version,
              marketplace: p.marketplace,
              servers: p.manifest.servers ? Object.keys(p.manifest.servers) : [],
              skills: p.manifest.skills ?? [],
              agents: p.manifest.agents ? Object.keys(p.manifest.agents) : [],
              adapter: p.manifest.adapter ? { command: p.manifest.adapter.command } : undefined,
            })),
          },
          opts,
        );
        return;
      }

      info("Marketplaces:", opts);
      for (const m of marketplaces) {
        info(`  ${m.name} (${m.source}) — ${m.url}`, opts);
      }

      if (plugins.length > 0) {
        info("\nAvailable plugins:", opts);
        for (const p of plugins) {
          const servers = p.manifest.servers ? Object.keys(p.manifest.servers).length : 0;
          const extras: string[] = [`servers: ${servers}`];
          if (p.manifest.adapter) extras.push("adapter: yes");
          info(`  ${p.manifest.name.padEnd(30)} ${p.manifest.description}`, opts);
          info(`    marketplace: ${p.marketplace}, ${extras.join(", ")}`, opts);
        }
      } else {
        info("\nNo plugins found in any marketplace.", opts);
      }
    } catch (err) {
      amError(err, opts);
      process.exitCode = 1;
    }
  },
});

const installCommand = defineCommand({
  meta: { name: "install", description: "Install a plugin from a marketplace" },
  args: {
    plugin: { type: "positional", description: "Plugin name to install", required: true },
    yes: { type: "boolean", alias: "y", description: "Skip confirmation", default: false },
    json: { type: "boolean", default: false },
    quiet: { type: "boolean", alias: "q", default: false },
    verbose: { type: "boolean", alias: "v", default: false },
  },
  async run({ args }) {
    const opts = { json: args.json, quiet: args.quiet, verbose: args.verbose };
    warnMarketplaceDeprecated(opts);
    try {
      const result = await installPlugin(args.plugin, { yes: args.yes });
      info(`Installed plugin "${result.plugin}" from marketplace "${result.marketplace}"`, opts);
      if (result.servers.length > 0) info(`  Servers: ${result.servers.join(", ")}`, opts);
      if (result.skills.length > 0) info(`  Skills: ${result.skills.join(", ")}`, opts);
      if (result.agents.length > 0) info(`  Agents: ${result.agents.join(", ")}`, opts);
      if (result.adapter) info(`  Adapter: ${result.adapter} (registered in adapters.toml)`, opts);
      info("\nRun `am apply` to generate native configs for your tools.", opts);
      output({ action: "install", ...result }, opts);
    } catch (err) {
      amError(err, opts);
      process.exitCode = 1;
    }
  },
});

const updateCommand = defineCommand({
  meta: { name: "update", description: "Update marketplace repos (git pull)" },
  args: {
    name: {
      type: "positional",
      description: "Marketplace name (omit to update all)",
      required: false,
    },
    yes: {
      type: "boolean",
      alias: "y",
      description: "Auto-accept new commit SHAs on pinned marketplaces",
      default: false,
    },
    json: { type: "boolean", default: false },
    quiet: { type: "boolean", alias: "q", default: false },
    verbose: { type: "boolean", alias: "v", default: false },
  },
  async run({ args }) {
    const opts = { json: args.json, quiet: args.quiet, verbose: args.verbose };
    warnMarketplaceDeprecated(opts);
    try {
      const updated = await updateMarketplace(args.name as string | undefined, { yes: args.yes });
      for (const entry of updated) {
        info(`Updated "${entry.name}"`, opts);
      }
      if (updated.length === 0) {
        info("No marketplaces to update.", opts);
      }
      output({ action: "update", updated }, opts);
    } catch (err) {
      amError(err, opts);
      process.exitCode = 1;
    }
  },
});

const removeCommand = defineCommand({
  meta: { name: "remove", description: "Remove a marketplace repo" },
  args: {
    name: { type: "positional", description: "Marketplace name to remove", required: true },
    json: { type: "boolean", default: false },
    quiet: { type: "boolean", alias: "q", default: false },
    verbose: { type: "boolean", alias: "v", default: false },
  },
  async run({ args }) {
    const opts = { json: args.json, quiet: args.quiet, verbose: args.verbose };
    warnMarketplaceDeprecated(opts);
    try {
      await removeMarketplace(args.name);
      info(`Removed marketplace "${args.name}"`, opts);
      output({ action: "remove", name: args.name }, opts);
    } catch (err) {
      amError(err, opts);
      process.exitCode = 1;
    }
  },
});

const searchCommand = defineCommand({
  meta: { name: "search", description: "Search across all marketplace plugins" },
  args: {
    query: { type: "positional", description: "Search query", required: true },
    json: { type: "boolean", default: false },
    quiet: { type: "boolean", alias: "q", default: false },
    verbose: { type: "boolean", alias: "v", default: false },
  },
  async run({ args }) {
    const opts = { json: args.json, quiet: args.quiet, verbose: args.verbose };
    warnMarketplaceDeprecated(opts);
    try {
      const results = await searchPlugins(args.query);
      if (args.json) {
        output(
          {
            query: args.query,
            results: results.map((p) => ({
              name: p.manifest.name,
              description: p.manifest.description,
              version: p.manifest.version,
              marketplace: p.marketplace,
            })),
          },
          opts,
        );
        return;
      }

      if (results.length === 0) {
        info(`No plugins found matching "${args.query}".`, opts);
        return;
      }

      info(
        `Found ${results.length} plugin${results.length === 1 ? "" : "s"} matching "${args.query}":`,
        opts,
      );
      for (const p of results) {
        info(`  ${p.manifest.name.padEnd(30)} ${p.manifest.description}`, opts);
        info(`    marketplace: ${p.marketplace}`, opts);
      }
    } catch (err) {
      amError(err, opts);
      process.exitCode = 1;
    }
  },
});

const uninstallCommand = defineCommand({
  meta: { name: "uninstall", description: "Uninstall a marketplace plugin" },
  args: {
    plugin: { type: "positional", description: "Plugin name to uninstall", required: true },
    json: { type: "boolean", default: false },
    quiet: { type: "boolean", alias: "q", default: false },
    verbose: { type: "boolean", alias: "v", default: false },
  },
  async run({ args }) {
    const opts = { json: args.json, quiet: args.quiet, verbose: args.verbose };
    warnMarketplaceDeprecated(opts);
    try {
      const result = await uninstallPlugin(args.plugin);
      info(`Uninstalled plugin "${result.plugin}"`, opts);
      if (result.removedServers.length > 0)
        info(`  Removed servers: ${result.removedServers.join(", ")}`, opts);
      if (result.removedSkills.length > 0)
        info(`  Removed skills: ${result.removedSkills.join(", ")}`, opts);
      if (result.removedAgents.length > 0)
        info(`  Removed agents: ${result.removedAgents.join(", ")}`, opts);
      if (result.removedAdapter) info(`  Removed adapter: ${result.removedAdapter}`, opts);
      output({ action: "uninstall", ...result }, opts);
    } catch (err) {
      amError(err, opts);
      process.exitCode = 1;
    }
  },
});

// ── Root marketplace command ─────────────────────────────────────

const validateCommand = defineCommand({
  meta: {
    name: "validate",
    description: "Validate a marketplace repo's plugin manifests without installing",
  },
  args: {
    path: { type: "positional", description: "Path to marketplace repo root", required: true },
    json: { type: "boolean", default: false },
    quiet: { type: "boolean", alias: "q", default: false },
    verbose: { type: "boolean", alias: "v", default: false },
  },
  async run({ args }) {
    const opts = { json: args.json, quiet: args.quiet, verbose: args.verbose };
    warnMarketplaceDeprecated(opts);
    try {
      const result = await validateMarketplace(args.path);
      if (args.json) {
        output(result, opts);
      } else {
        info(formatValidateSummary(result), opts);
      }
      if (!result.valid) {
        process.exitCode = 1;
      }
    } catch (err) {
      amError(err, opts);
      process.exitCode = 1;
    }
  },
});

export const marketplaceCommand = defineCommand({
  meta: { name: "marketplace", description: "Manage git-based plugin marketplaces" },
  args: {
    json: { type: "boolean", default: false },
    quiet: { type: "boolean", alias: "q", default: false },
    verbose: { type: "boolean", alias: "v", default: false },
  },
  subCommands: {
    add: addCommand,
    list: listCommand,
    install: installCommand,
    update: updateCommand,
    remove: removeCommand,
    search: searchCommand,
    uninstall: uninstallCommand,
    validate: validateCommand,
  },
});
