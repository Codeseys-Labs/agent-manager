import { defineCommand } from "citty";
import { getAdapter, getDetectedAdapters, listAdapters } from "../adapters/registry";
import type { Adapter, ImportedServer, MarketplaceItem } from "../adapters/types";
import { resolveConfigDir } from "../core/config";
import { withConfig } from "../core/controller";
import { extractServerIdentity } from "../core/identity";
import { type MergeStrategy, type ServerConflict, runMergePipeline } from "../core/merge";
import type { MarketplaceProvenance } from "../core/schema";

export { extractServerIdentity } from "../core/identity";
import {
  type SecretScanResult,
  formatScanReport,
  pickEnvVarName,
  redactSecret,
  scanConfigForSecrets,
  substituteSecret,
} from "../core/secret-detection";
import {
  encryptValue,
  generateKey,
  importKey,
  loadKey,
  resolveKeyPath,
  saveKey,
} from "../core/secrets";
import { AmError, errorMessage, requireConfig } from "../lib/errors";
import { amError, debug, error, info, output, warn } from "../lib/output";

interface ImportOutcome {
  totalImported: number;
  totalDuplicates: number;
  totalMerged: number;
  allWarnings: string[];
  allConflicts: ServerConflict[];
  totalEncrypted: number;
  isBrownfield: boolean;
  existingServerCount: number;
  scanResults: SecretScanResult[];
  totalMarketplaceServers: number;
  totalMarketplaceSkills: number;
  allMarketplaceItems: MarketplaceItem[];
  reportOnly: boolean;
  unencryptedScanReport?: string;
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

      // Determine which adapters to import from (validation, no config needed).
      let adapters: Adapter[];
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

      const outcome = await withConfig<ImportOutcome>(configDir, async (maybeConfig) => {
        requireConfig(maybeConfig);
        const config = maybeConfig;

        let totalImported = 0;
        let totalDuplicates = 0;
        let totalMerged = 0;
        const allWarnings: string[] = [];
        const allConflicts: ServerConflict[] = [];
        let totalEncrypted = 0;
        let totalMarketplaceServers = 0;
        let totalMarketplaceSkills = 0;
        const allMarketplaceItems: MarketplaceItem[] = [];
        let scanResults: SecretScanResult[] = [];
        let unencryptedScanReport: string | undefined;

        if (!config.servers) config.servers = {};
        const isBrownfield = Object.keys(config.servers).length > 0;
        const existingServerCount = Object.keys(config.servers).length;
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

            if (args.report) {
              allConflicts.push(...mergeResult.conflicts);
              totalDuplicates += mergeResult.skipped.length;
              totalImported += mergeResult.added.length;
              totalMerged += mergeResult.merged.length;
              continue;
            }

            for (const m of mergeResult.merged) {
              config.servers[m.name] = m.server;
              totalMerged++;
            }

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

            for (const s of mergeResult.skipped) {
              debug(
                `Skipping "${s.incomingServer.name}" — identical to "${s.existingName}" (identity: ${s.identity})`,
                opts,
              );
              totalDuplicates++;
            }

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
        }

        // Report mode — skip write, print report outside the lock.
        if (args.report) {
          return {
            result: {
              totalImported,
              totalDuplicates,
              totalMerged,
              allWarnings,
              allConflicts,
              totalEncrypted: 0,
              isBrownfield,
              existingServerCount,
              scanResults: [],
              totalMarketplaceServers,
              totalMarketplaceSkills,
              allMarketplaceItems,
              reportOnly: true,
            },
            changed: false,
          };
        }

        // Scan imported servers for secrets and auto-encrypt (default behavior)
        if (config.servers && totalImported > 0) {
          scanResults = await scanConfigForSecrets(config.servers);
          const actionableSecrets = scanResults.flatMap((r) => r.secrets);

          if (actionableSecrets.length > 0 && !args["no-encrypt"]) {
            let key = await loadKey(configDir);
            if (!key) {
              debug("No encryption key found — generating one automatically", opts);
              const base64Key = await generateKey();
              await saveKey(configDir, base64Key);
              key = await importKey(base64Key);
              if (!args.json) {
                info(`Generated encryption key (stored at ${resolveKeyPath()})`, opts);
              }
            }

            for (const result of scanResults) {
              const server = config.servers[result.serverName];
              if (!server) continue;
              for (const secret of result.secrets) {
                if (!config.settings) config.settings = {};
                if (!config.settings.env) config.settings.env = {};
                const envVarName =
                  secret.source === "url-credential"
                    ? pickEnvVarName(config.settings.env, secret.suggestedEnvVar, result.serverName)
                    : secret.suggestedEnvVar;
                // INVARIANT: never encrypt+count unless the plaintext was removed
                // (review A+F). If substitution can't rewrite the location, do
                // NOT store an encrypted copy beside surviving plaintext — leave
                // it for the apply guard to refuse loudly (fail-closed at apply).
                if (!substituteSecret(server, secret, envVarName)) {
                  continue;
                }
                config.settings.env[envVarName] = await encryptValue(secret.value, key);
                totalEncrypted++;
              }
            }
          } else if (actionableSecrets.length > 0 && args["no-encrypt"]) {
            unencryptedScanReport = formatScanReport(scanResults);
          }
        }

        const totalChanges = totalImported + totalMerged;
        const sourceStr =
          args.source === "auto" ? adapters.map((a) => a.meta.name).join(", ") : args.source;
        const parts = [`${totalImported} new`];
        if (totalMerged > 0) parts.push(`${totalMerged} merged`);
        const commitMessage =
          totalChanges > 0 ? `import: ${sourceStr} (${parts.join(", ")})` : undefined;

        return {
          result: {
            totalImported,
            totalDuplicates,
            totalMerged,
            allWarnings,
            allConflicts,
            totalEncrypted,
            isBrownfield,
            existingServerCount,
            scanResults,
            totalMarketplaceServers,
            totalMarketplaceSkills,
            allMarketplaceItems,
            reportOnly: false,
            unencryptedScanReport,
          },
          commitMessage,
          changed: true, // We always write when we get past report mode
        };
      });

      // ── Report mode output ─────────────────────────────────────
      if (outcome.reportOnly) {
        const reportData = {
          brownfield: outcome.isBrownfield,
          existingServers: outcome.existingServerCount,
          newServers: outcome.totalImported,
          identicalSkipped: outcome.totalDuplicates,
          merged: outcome.totalMerged,
          conflicts: outcome.allConflicts.map((c) => ({
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

      // ── Apply-mode output ──────────────────────────────────────
      if (!args.json && outcome.totalEncrypted > 0) {
        info(
          `Encrypted ${outcome.totalEncrypted} secret(s) — values stored in settings.env, configs use \${VAR} references.`,
          opts,
        );
      }

      if (!args.json && outcome.unencryptedScanReport) {
        info("", opts);
        info("Warning: potential secret(s) left unencrypted (--no-encrypt).", opts);
        info(outcome.unencryptedScanReport, opts);
      }

      // Marketplace scan report (console-only; no writes involved).
      if (args.marketplace && outcome.allMarketplaceItems.length > 0 && !args.json) {
        info("", opts);
        for (const adapter of adapters) {
          const items = outcome.allMarketplaceItems.filter(
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

      const summaryParts: string[] = [`Imported ${outcome.totalImported} server(s)`];
      if (outcome.totalMerged > 0) summaryParts.push(`${outcome.totalMerged} merged`);
      if (outcome.totalDuplicates > 0)
        summaryParts.push(`${outcome.totalDuplicates} duplicate(s) skipped`);
      if (outcome.allConflicts.length > 0)
        summaryParts.push(`${outcome.allConflicts.length} conflict(s) skipped`);
      info(summaryParts.join(", "), opts);

      if (outcome.allWarnings.length > 0) {
        for (const w of outcome.allWarnings) {
          warn(w, opts);
        }
      }

      if (args.json) {
        output(
          {
            action: "import",
            source: args.source,
            brownfield: outcome.isBrownfield,
            imported: outcome.totalImported,
            merged: outcome.totalMerged,
            duplicates: outcome.totalDuplicates,
            unresolvedConflicts: outcome.allConflicts.length,
            marketplace: args.marketplace
              ? {
                  items: outcome.allMarketplaceItems.map((i) => ({
                    id: i.id,
                    name: i.name,
                    version: i.version,
                    source: i.source,
                    servers: i.servers.length,
                    skills: i.skills.length,
                  })),
                  servers: outcome.totalMarketplaceServers,
                  skills: outcome.totalMarketplaceSkills,
                }
              : undefined,
            warnings: outcome.allWarnings,
            detectedSecrets: outcome.scanResults.map((r) => ({
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
