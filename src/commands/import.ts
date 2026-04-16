import { join } from "node:path";
import { defineCommand } from "citty";
import { getAdapter, getDetectedAdapters, listAdapters } from "../adapters/registry";
import type { Adapter, ImportedServer, MarketplaceItem } from "../adapters/types";
import { resolveConfigDir, tryReadConfig, writeConfig } from "../core/config";
import { commitAll } from "../core/git";
import { type MergeStrategy, type ServerConflict, runMergePipeline } from "../core/merge";
import type { MarketplaceProvenance } from "../core/schema";
import {
  type SecretScanResult,
  formatScanReport,
  redactSecret,
  scanConfigForSecrets,
  substituteSecret,
} from "../core/secret-detection";
import { encryptValue, generateKey, importKey, loadKey, saveKey } from "../core/secrets";
import { AmError, errorMessage, requireConfig } from "../lib/errors";
import { amError, debug, error, info, output } from "../lib/output";

/**
 * Extract a canonical identity from a server command+args for dedup.
 * Uses the ranked signal chain from the design spec:
 * 1. Package identity — strip npx/bunx/uvx/pipx prefixes and @version suffixes
 * 2. Endpoint identity — extract upstream URL from proxy args
 * 3. Command basename — last resort
 */
export function extractServerIdentity(command: string, args?: string[]): string {
  const allParts = [command, ...(args ?? [])];

  // Strip runner prefixes
  const runners = ["npx", "bunx", "uvx", "pipx", "run", "-y"];
  const pkgParts = [...allParts];
  while (pkgParts.length > 0 && runners.includes(pkgParts[0])) {
    pkgParts.shift();
  }

  // Check for proxy endpoint (signal 2 — endpoint identity)
  const endpointIdx = allParts.indexOf("--endpoint");
  if (endpointIdx !== -1 && allParts[endpointIdx + 1]) {
    try {
      const url = new URL(allParts[endpointIdx + 1]);
      return url.hostname;
    } catch {
      // Not a valid URL, fall through
    }
  }

  // Extract package name (signal 1 — package identity)
  if (pkgParts.length > 0) {
    const pkg = pkgParts[0];
    // Strip @version suffix: "tavily-mcp@latest" -> "tavily-mcp"
    const atIdx = pkg.lastIndexOf("@");
    if (atIdx > 0) {
      return pkg.substring(0, atIdx);
    }
    // Strip path prefix: "/usr/local/bin/aws-outlook-mcp" -> "aws-outlook-mcp"
    const slashIdx = pkg.lastIndexOf("/");
    if (slashIdx >= 0) {
      return pkg.substring(slashIdx + 1);
    }
    return pkg;
  }

  return command;
}

export const importCommand = defineCommand({
  meta: { name: "import", description: "Import servers from a tool's native config" },
  args: {
    source: {
      type: "positional",
      description: "Adapter name or 'auto' for all detected",
      required: true,
    },
    auto: {
      type: "boolean",
      description: "Auto-resolve conflicts without prompting (brownfield merge)",
      default: false,
    },
    report: {
      type: "boolean",
      description: "Show brownfield conflict report without making changes",
      default: false,
    },
    marketplace: {
      type: "boolean",
      description: "Include marketplace items (plugins, extensions)",
      default: false,
    },
    "no-encrypt": {
      type: "boolean",
      description: "Skip auto-encryption of detected secrets",
      default: false,
    },
    json: { type: "boolean", description: "JSON output", default: false },
    quiet: { type: "boolean", alias: "q", default: false },
    verbose: { type: "boolean", alias: "v", default: false },
  },
  async run({ args }) {
    const opts = { json: args.json, quiet: args.quiet, verbose: args.verbose };
    try {
      const configDir = resolveConfigDir();
      const configPath = join(configDir, "config.toml");

      const config = await tryReadConfig(configPath);
      requireConfig(config);

      // Determine which adapters to import from
      let adapters;
      if (args.source === "auto") {
        adapters = await getDetectedAdapters();
        if (adapters.length === 0) {
          info("No tools detected to import from.", opts);
          return;
        }
      } else {
        const adapter = await getAdapter(args.source);
        if (!adapter) {
          const available = listAdapters();
          throw new AmError(
            `Adapter "${args.source}" not found`,
            `Available adapters: ${available.join(", ")}`,
            "ADAPTER_NOT_FOUND",
          );
        }
        adapters = [adapter];
      }

      let totalImported = 0;
      let totalDuplicates = 0;
      let totalMerged = 0;
      const allWarnings: string[] = [];
      const allConflicts: ServerConflict[] = [];

      if (!config.servers) config.servers = {};
      const isBrownfield = Object.keys(config.servers).length > 0;
      const mergeStrategy: MergeStrategy = args.auto ? "auto" : "auto";

      for (const adapter of adapters) {
        debug(`Importing from ${adapter.meta.displayName}...`, opts);

        let result;
        try {
          result = await adapter.import({ projectPath: process.cwd() });
        } catch (e: unknown) {
          const msg = errorMessage(e) || "import failed";
          info(`${adapter.meta.displayName}: ${msg}`, opts);
          allWarnings.push(`${adapter.meta.name}: ${msg}`);
          continue;
        }

        allWarnings.push(...result.warnings.map((w) => `${adapter.meta.name}: ${w}`));

        if (isBrownfield) {
          // Brownfield: run merge pipeline (ADR-0028)
          const mergeResult = runMergePipeline(
            config.servers,
            result.servers,
            mergeStrategy,
            adapter.meta.name,
          );

          // Report mode — collect but don't apply
          if (args.report) {
            allConflicts.push(...mergeResult.conflicts);
            totalDuplicates += mergeResult.skipped.length;
            totalImported += mergeResult.added.length;
            totalMerged += mergeResult.merged.length;
            continue;
          }

          // Apply merged servers
          for (const m of mergeResult.merged) {
            config.servers[m.name] = m.server;
            totalMerged++;
          }

          // Add new servers
          for (const srv of mergeResult.added) {
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

          // Track skipped (identical)
          for (const s of mergeResult.skipped) {
            debug(
              `Skipping "${s.incomingServer.name}" — identical to "${s.existingName}" (identity: ${s.identity})`,
              opts,
            );
            totalDuplicates++;
          }

          // Track unresolved conflicts (fuzzy matches in auto mode)
          for (const c of mergeResult.conflicts) {
            const reason = c.match.fuzzyReason ? ` (fuzzy: ${c.match.fuzzyReason})` : "";
            allWarnings.push(
              `${adapter.meta.name}: conflict skipped — "${c.match.incomingServer.name}" vs "${c.match.existingName}"${reason}`,
            );
            allConflicts.push(c);
          }
        } else {
          // Greenfield: original append behavior (no merge phase)
          const existingIdentities = new Map<string, string>();
          for (const [name, srv] of Object.entries(config.servers)) {
            const identity = extractServerIdentity(srv.command, srv.args);
            existingIdentities.set(identity, name);
          }

          for (const srv of result.servers) {
            const identity = extractServerIdentity(srv.command, srv.args);
            const existingName = existingIdentities.get(identity);

            if (existingName) {
              debug(
                `Skipping "${srv.name}" — duplicate of "${existingName}" (identity: ${identity})`,
                opts,
              );
              totalDuplicates++;
              continue;
            }

            config.servers[srv.name] = {
              command: srv.command,
              args: srv.args,
              env: srv.env,
              transport: srv.transport ?? "stdio",
              description: srv.description,
              tags: srv.tags,
              enabled: srv.enabled ?? true,
            };
            existingIdentities.set(identity, srv.name);
            totalImported++;
          }
        }
      }

      // Marketplace scanning (--marketplace flag)
      let totalMarketplaceServers = 0;
      let totalMarketplaceSkills = 0;
      const allMarketplaceItems: MarketplaceItem[] = [];
      if (args.marketplace) {
        for (const adapter of adapters) {
          if (!adapter.scanMarketplace) continue;

          debug(`Scanning marketplace for ${adapter.meta.displayName}...`, opts);
          let mpResult;
          try {
            mpResult = adapter.scanMarketplace();
          } catch (e: unknown) {
            const msg = errorMessage(e) || "marketplace scan failed";
            allWarnings.push(`${adapter.meta.name} marketplace: ${msg}`);
            continue;
          }

          allWarnings.push(
            ...mpResult.warnings.map((w) => `${adapter.meta.name} marketplace: ${w}`),
          );

          for (const item of mpResult.items) {
            allMarketplaceItems.push(item);

            // Build identity map of existing servers for dedup
            const existingIdentities = new Map<string, string>();
            for (const [name, srv] of Object.entries(config.servers!)) {
              const identity = extractServerIdentity(srv.command, srv.args);
              existingIdentities.set(identity, name);
            }

            for (const srv of item.servers) {
              const identity = extractServerIdentity(srv.command, srv.args);
              const existingName = existingIdentities.get(identity);

              if (existingName) {
                debug(
                  `Skipping marketplace server "${srv.name}" from ${item.id} — duplicate of "${existingName}"`,
                  opts,
                );
                totalDuplicates++;
                continue;
              }

              const provenance: MarketplaceProvenance = {
                source: item.source,
                package: item.id,
                version: item.version,
                imported_at: new Date().toISOString(),
                install_path: item.metadata.installPath,
              };

              config.servers![srv.name] = {
                command: srv.command,
                args: srv.args,
                env: srv.env,
                transport: srv.transport ?? "stdio",
                description: srv.description,
                tags: srv.tags,
                enabled: srv.enabled ?? true,
                _marketplace: provenance,
              };
              existingIdentities.set(identity, srv.name);
              totalImported++;
              totalMarketplaceServers++;
            }

            totalMarketplaceSkills += item.skills.length;
          }
        }

        if (allMarketplaceItems.length > 0 && !args.json) {
          info("", opts);
          for (const adapter of adapters) {
            const items = allMarketplaceItems.filter(
              (i) =>
                (i.source === "claude-plugin" && adapter.meta.name === "claude-code") ||
                i.source === `${adapter.meta.name}-extension` ||
                (i.source === "vscode-extension" && adapter.meta.name === "copilot"),
            );
            if (items.length === 0) continue;

            info(`Marketplace Scan: ${adapter.meta.displayName}`, opts);
            info("─".repeat(30), opts);
            for (const item of items) {
              const serverNames = item.servers.map((s) => s.name).join(", ") || "(none)";
              const skillNames = item.skills.map((s) => s.name).join(", ") || "(none)";
              info(`  ${item.id} (v${item.version})`, opts);
              info(`    Servers: ${serverNames}`, opts);
              if (item.skills.length > 0) {
                info(`    Skills: ${skillNames}`, opts);
              }
            }
            info("", opts);
          }
        }
      }

      // Report mode — show report and exit without writing
      if (args.report) {
        const reportData = {
          brownfield: isBrownfield,
          existingServers: Object.keys(config.servers).length,
          newServers: totalImported,
          identicalSkipped: totalDuplicates,
          merged: totalMerged,
          conflicts: allConflicts.map((c) => ({
            existing: c.match.existingName,
            incoming: c.match.incomingServer.name,
            source: c.match.incomingSource,
            matchType: c.match.type,
            fuzzyReason: c.match.fuzzyReason,
            classification: c.classification,
            diffs: c.diffs.map((d) => ({
              field: d.field,
              existing: d.existing,
              incoming: d.incoming,
            })),
          })),
        };

        if (args.json) {
          output({ action: "import-report", ...reportData }, opts);
        } else {
          info("Brownfield Import Report", opts);
          info("────────────────────────", opts);
          info(`  config.toml:  ${reportData.existingServers} servers`, opts);
          info(`  New:          ${reportData.newServers} servers to add`, opts);
          info(`  Identical:    ${reportData.identicalSkipped} (would skip)`, opts);
          info(`  Mergeable:    ${reportData.merged} (would auto-merge)`, opts);
          info(`  Conflicts:    ${reportData.conflicts.length} (need resolution)`, opts);
          if (reportData.conflicts.length > 0) {
            info("", opts);
            for (const c of reportData.conflicts) {
              info(
                `  ${c.existing} vs ${c.incoming} [${c.matchType}${c.fuzzyReason ? `: ${c.fuzzyReason}` : ""}]`,
                opts,
              );
              for (const d of c.diffs) {
                info(
                  `    ${d.field}: ${JSON.stringify(d.existing)} → ${JSON.stringify(d.incoming)}`,
                  opts,
                );
              }
            }
          }
        }
        return;
      }

      // Scan imported servers for secrets and auto-encrypt (default behavior)
      let scanResults: SecretScanResult[] = [];
      let totalEncrypted = 0;
      if (config.servers && totalImported > 0) {
        scanResults = await scanConfigForSecrets(config.servers);
        const actionableSecrets = scanResults.flatMap((r) => r.secrets);

        if (actionableSecrets.length > 0 && !args["no-encrypt"]) {
          // Ensure encryption key exists — auto-generate if missing
          let key = await loadKey(configDir);
          if (!key) {
            debug("No encryption key found — generating one automatically", opts);
            const base64Key = await generateKey();
            await saveKey(configDir, base64Key);
            key = await importKey(base64Key);
            if (!args.json) {
              info("Generated encryption key (stored in .agent-manager/key.txt)", opts);
            }
          }

          // Substitute and encrypt each detected secret
          for (const result of scanResults) {
            const server = config.servers[result.serverName];
            if (!server) continue;
            for (const secret of result.secrets) {
              // All detected secrets are actionable in the tiered model
              substituteSecret(server, secret, secret.suggestedEnvVar);

              // Store the original value encrypted in settings.env
              if (!config.settings) config.settings = {};
              if (!config.settings.env) config.settings.env = {};
              config.settings.env[secret.suggestedEnvVar] = await encryptValue(secret.value, key);
              totalEncrypted++;
            }
          }

          if (!args.json && totalEncrypted > 0) {
            info(
              `Encrypted ${totalEncrypted} secret(s) — values stored in settings.env, configs use \${VAR} references.`,
              opts,
            );
          }
        } else if (actionableSecrets.length > 0 && args["no-encrypt"]) {
          // User explicitly opted out of encryption
          if (!args.json) {
            const totalSecrets = actionableSecrets.length;
            info("", opts);
            info(
              `Warning: ${totalSecrets} potential secret(s) left unencrypted (--no-encrypt).`,
              opts,
            );
            info(formatScanReport(scanResults), opts);
          }
        }
      }

      await writeConfig(configPath, config);

      // Auto-commit
      const totalChanges = totalImported + totalMerged;
      if (totalChanges > 0) {
        const sourceStr =
          args.source === "auto" ? adapters.map((a) => a.meta.name).join(", ") : args.source;
        const parts = [`${totalImported} new`];
        if (totalMerged > 0) parts.push(`${totalMerged} merged`);
        try {
          await commitAll(configDir, `import: ${sourceStr} (${parts.join(", ")})`);
        } catch {
          // Nothing new to commit
        }
      }

      const summaryParts: string[] = [`Imported ${totalImported} server(s)`];
      if (totalMerged > 0) summaryParts.push(`${totalMerged} merged`);
      if (totalDuplicates > 0) summaryParts.push(`${totalDuplicates} duplicate(s) skipped`);
      if (allConflicts.length > 0) summaryParts.push(`${allConflicts.length} conflict(s) skipped`);
      info(summaryParts.join(", "), opts);

      if (allWarnings.length > 0) {
        for (const w of allWarnings) {
          info(`  warning: ${w}`, opts);
        }
      }

      if (args.json) {
        output(
          {
            action: "import",
            source: args.source,
            brownfield: isBrownfield,
            imported: totalImported,
            merged: totalMerged,
            duplicates: totalDuplicates,
            unresolvedConflicts: allConflicts.length,
            marketplace: args.marketplace
              ? {
                  items: allMarketplaceItems.map((i) => ({
                    id: i.id,
                    name: i.name,
                    version: i.version,
                    source: i.source,
                    servers: i.servers.length,
                    skills: i.skills.length,
                  })),
                  servers: totalMarketplaceServers,
                  skills: totalMarketplaceSkills,
                }
              : undefined,
            warnings: allWarnings,
            detectedSecrets: scanResults.map((r) => ({
              server: r.serverName,
              secrets: r.secrets.map((s) => ({
                location: s.location,
                key: s.key,
                value: redactSecret(s.value),
                source: s.source,
              })),
            })),
          },
          opts,
        );
      }
    } catch (err) {
      amError(err, opts);
      process.exitCode = 1;
    }
  },
});
