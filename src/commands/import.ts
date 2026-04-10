import { join } from "node:path";
import { defineCommand } from "citty";
import { getAdapter, getDetectedAdapters, listAdapters } from "../adapters/registry";
import type { ImportedServer } from "../adapters/types";
import { readConfig, resolveConfigDir, writeConfig } from "../core/config";
import { commitAll } from "../core/git";
import {
  type SecretScanResult,
  formatScanReport,
  redactSecret,
  scanConfigForSecrets,
  substituteSecret,
} from "../core/secret-detection";
import { encryptValue, loadKey } from "../core/secrets";
import { errorMessage } from "../lib/errors";
import { debug, error, info, output } from "../lib/output";

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
    "auto-encrypt": {
      type: "boolean",
      description: "Auto-substitute and encrypt detected secrets",
      default: false,
    },
    json: { type: "boolean", description: "JSON output", default: false },
    quiet: { type: "boolean", alias: "q", default: false },
    verbose: { type: "boolean", alias: "v", default: false },
  },
  async run({ args }) {
    const opts = { json: args.json, quiet: args.quiet, verbose: args.verbose };
    const configDir = resolveConfigDir();
    const configPath = join(configDir, "config.toml");

    let config;
    try {
      config = await readConfig(configPath);
    } catch {
      error("Config not found. Run `am init` first.", opts);
      process.exitCode = 1;
      return;
    }

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
        if (args.json) {
          console.error(
            JSON.stringify({
              error: `Adapter "${args.source}" not found`,
              suggestion: `Available adapters: ${available.join(", ")}`,
            }),
          );
        } else {
          console.error(`error: Adapter "${args.source}" not found`);
          console.error(`  available: ${available.join(", ")}`);
        }
        process.exitCode = 1;
        return;
      }
      adapters = [adapter];
    }

    let totalImported = 0;
    let totalDuplicates = 0;
    const allWarnings: string[] = [];

    for (const adapter of adapters) {
      debug(`Importing from ${adapter.meta.displayName}...`, opts);

      let result;
      try {
        result = adapter.import({});
      } catch (e: unknown) {
        const msg = errorMessage(e) || "import failed";
        info(`${adapter.meta.displayName}: ${msg}`, opts);
        allWarnings.push(`${adapter.meta.name}: ${msg}`);
        continue;
      }

      allWarnings.push(...result.warnings.map((w) => `${adapter.meta.name}: ${w}`));

      if (!config.servers) config.servers = {};

      // Build identity map of existing servers for dedup
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

    // Scan imported servers for potential secrets
    let scanResults: SecretScanResult[] = [];
    if (config.servers && totalImported > 0) {
      scanResults = scanConfigForSecrets(config.servers);

      if (scanResults.length > 0) {
        const totalSecrets = scanResults.reduce((sum, r) => sum + r.secrets.length, 0);

        if (!args.json) {
          info("", opts);
          info(`Warning: ${totalSecrets} potential secret(s) detected in imported servers.`, opts);
          info(formatScanReport(scanResults), opts);
          info("", opts);
        }

        if (args["auto-encrypt"]) {
          const key = await loadKey(configDir);
          if (!key) {
            info(
              "Cannot auto-encrypt: no encryption key. Run `am secret generate-key` first.",
              opts,
            );
          } else {
            let substituted = 0;
            for (const result of scanResults) {
              const server = config.servers[result.serverName];
              if (!server) continue;
              for (const secret of result.secrets) {
                if (secret.confidence === "low") continue;
                substituteSecret(server, secret, secret.suggestedEnvVar);

                // Store the original value encrypted in settings.env
                if (!config.settings) config.settings = {};
                if (!config.settings.env) config.settings.env = {};
                config.settings.env[secret.suggestedEnvVar] = await encryptValue(secret.value, key);
                substituted++;
              }
            }
            info(`Auto-encrypted ${substituted} secret(s). Values stored in settings.env.`, opts);
          }
        } else if (!args.json) {
          info(
            "Run `am secret scan --fix` to substitute and encrypt, or re-import with --auto-encrypt.",
            opts,
          );
          info("", opts);
          info(
            "Security recommendation: secrets should be stored as encrypted ${VAR} references.",
            opts,
          );
          info(
            "  am secret scan --fix    — auto-substitute and encrypt all detected secrets",
            opts,
          );
          info("  am import --auto-encrypt — auto-encrypt on import", opts);
        }
      }
    }

    await writeConfig(configPath, config);

    // Auto-commit
    if (totalImported > 0) {
      const sourceStr =
        args.source === "auto" ? adapters.map((a) => a.meta.name).join(", ") : args.source;
      try {
        await commitAll(configDir, `import: ${sourceStr} (${totalImported} servers)`);
      } catch {
        // Nothing new to commit
      }
    }

    const summary = `Imported ${totalImported} server(s)${totalDuplicates > 0 ? `, ${totalDuplicates} duplicate(s) skipped` : ""}`;
    info(summary, opts);

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
          imported: totalImported,
          duplicates: totalDuplicates,
          warnings: allWarnings,
          detectedSecrets: scanResults.map((r) => ({
            server: r.serverName,
            secrets: r.secrets.map((s) => ({
              location: s.location,
              key: s.key,
              value: redactSecret(s.value),
              confidence: s.confidence,
              pattern: s.patternName,
            })),
          })),
        },
        opts,
      );
    }
  },
});
