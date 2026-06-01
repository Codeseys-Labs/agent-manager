import * as clack from "@clack/prompts";
import { defineCommand } from "citty";
import { resolveConfigDir } from "../core/config";
import { withConfig } from "../core/controller";
import type { Server } from "../core/schema";
import { encryptValue, loadKey } from "../core/secrets";
import { requireConfig } from "../lib/errors";
import { amError, error, info, output } from "../lib/output";
import { RegistryError, getPackage } from "../registry/client";
import type { RegistryPackage, RegistryProvenance } from "../registry/types";

export const installCommand = defineCommand({
  meta: { name: "install", description: "Install MCP server packages from the registry" },
  args: {
    packages: { type: "positional", description: "Package name(s) to install", required: true },
    version: { type: "string", description: "Version to install (applies to all packages)" },
    "dry-run": { type: "boolean", description: "Preview changes without writing", default: false },
    yes: { type: "boolean", alias: "y", description: "Skip confirmation prompts", default: false },
    "no-cache": { type: "boolean", description: "Bypass cache", default: false },
    json: { type: "boolean", description: "JSON output", default: false },
    quiet: { type: "boolean", alias: "q", default: false },
    verbose: { type: "boolean", alias: "v", default: false },
  },
  async run({ args }) {
    const opts = { json: args.json, quiet: args.quiet, verbose: args.verbose };
    try {
      const dryRun = args["dry-run"] ?? false;
      const skipConfirm = args.yes ?? false;
      const skipCache = args["no-cache"] ?? false;
      const configDir = resolveConfigDir();

      // Parse package names: citty delivers a single positional as a string
      const packageNames: string[] =
        typeof args.packages === "string"
          ? args.packages.split(",").map((s) => s.trim())
          : [args.packages];

      // REV-1 MEDIUM-2 (2026-04-18): serialize RMW through the controller's
      // withConfig() instead of raw tryReadConfig → writeConfig. This closes
      // the MCP-vs-CLI race that was exactly the hazard Wave B's mutex was
      // built to prevent (the Wave B fix closed MCP-vs-MCP only).
      await withConfig(configDir, async (config) => {
        requireConfig(config);

        // Load encryption key for env var secrets
        const encryptionKey = await loadKey(configDir);

        const results: Array<{
          package: string;
          action: "installed" | "skipped" | "replaced" | "failed";
          version?: string;
          reason?: string;
        }> = [];

        for (const pkgName of packageNames) {
          let pkg: RegistryPackage | null;
          try {
            pkg = await getPackage(pkgName, { skipCache });
          } catch (err) {
            const msg = err instanceof RegistryError ? err.message : (err as Error).message;
            error(`Failed to fetch "${pkgName}": ${msg}`, opts);
            results.push({ package: pkgName, action: "failed", reason: msg });
            continue;
          }

          if (!pkg) {
            error(`Package "${pkgName}" not found in the registry.`, opts);
            results.push({ package: pkgName, action: "failed", reason: "not found" });
            continue;
          }

          // Check if server already exists
          const existing = config.servers?.[pkg.name];
          if (existing) {
            // Check if it's a registry-installed server
            const existingProvenance = existing._registry;
            if (existingProvenance) {
              if (existingProvenance.version === pkg.version) {
                info(`"${pkg.name}" is already installed at version ${pkg.version}.`, opts);
                results.push({
                  package: pkg.name,
                  action: "skipped",
                  version: pkg.version,
                  reason: "already installed",
                });
                continue;
              }
            }

            // Server exists — prompt to replace
            if (!skipConfirm && !args.json && process.stdin.isTTY) {
              const replace = await clack.confirm({
                message: `Server "${pkg.name}" already exists. Replace it?`,
                initialValue: false,
              });
              if (clack.isCancel(replace) || !replace) {
                info(`Skipped "${pkg.name}".`, opts);
                results.push({ package: pkg.name, action: "skipped", reason: "user declined" });
                continue;
              }
            } else if (!skipConfirm) {
              info(`Server "${pkg.name}" already exists. Use --yes to replace.`, opts);
              results.push({ package: pkg.name, action: "skipped", reason: "already exists" });
              continue;
            }
          }

          // Collect env vars
          const env: Record<string, string> = {};
          const requiredEnvVars = pkg.server.env?.filter((e) => e.required) ?? [];
          const optionalEnvVars = pkg.server.env?.filter((e) => !e.required) ?? [];

          if (requiredEnvVars.length > 0 && !args.json && process.stdin.isTTY && !dryRun) {
            info(`\n"${pkg.name}" requires the following environment variables:`, opts);
            for (const envVar of requiredEnvVars) {
              const value = await clack.text({
                message: `${envVar.name}${envVar.description ? ` (${envVar.description})` : ""}`,
                placeholder: envVar.default ?? "",
                validate: (v) => {
                  if (!v.trim()) return `${envVar.name} is required`;
                },
              });
              if (clack.isCancel(value)) {
                info(`Installation of "${pkg.name}" cancelled.`, opts);
                results.push({ package: pkg.name, action: "skipped", reason: "cancelled" });
                continue;
              }
              // Encrypt if key is available
              if (encryptionKey) {
                env[envVar.name] = await encryptValue(value as string, encryptionKey);
              } else {
                env[envVar.name] = value as string;
              }
            }
          } else if (requiredEnvVars.length > 0 && !dryRun) {
            // Non-interactive: set placeholder values
            for (const envVar of requiredEnvVars) {
              env[envVar.name] = envVar.default ?? `\${${envVar.name}}`;
            }
          }

          // Set defaults for optional env vars
          for (const envVar of optionalEnvVars) {
            if (envVar.default) {
              env[envVar.name] = envVar.default;
            }
          }

          // Build server entry
          const server: Server & { _registry?: RegistryProvenance } = {
            command: pkg.server.command,
            args: pkg.server.args,
            transport: pkg.server.transport ?? "stdio",
            enabled: true,
            description: pkg.description,
            tags: pkg.tags,
            ...(Object.keys(env).length > 0 ? { env } : {}),
            _registry: {
              source: "mcp-registry",
              package: pkg.name,
              version: pkg.version,
              installed_at: new Date().toISOString(),
            },
          };

          // Add URL for remote transports
          if (pkg.server.url && pkg.server.transport !== "stdio") {
            server.url = pkg.server.url;
          }

          if (dryRun) {
            info(`[dry-run] Would install "${pkg.name}" v${pkg.version}`, opts);
            info(`  command: ${pkg.server.command}`, opts);
            if (pkg.server.args?.length) info(`  args: ${pkg.server.args.join(" ")}`, opts);
            if (requiredEnvVars.length) {
              info(`  env vars: ${requiredEnvVars.map((e) => e.name).join(", ")}`, opts);
            }
            results.push({ package: pkg.name, action: "installed", version: pkg.version });
            continue;
          }

          // Write to config
          if (!config.servers) config.servers = {};
          const action = existing ? "replaced" : "installed";
          config.servers[pkg.name] = server;

          results.push({ package: pkg.name, action, version: pkg.version });
          info(
            `${action === "replaced" ? "Replaced" : "Installed"} "${pkg.name}" v${pkg.version}`,
            opts,
          );
        }

        // Defer write + commit to withConfig (single point of RMW).
        const shouldWrite =
          !dryRun && results.some((r) => r.action === "installed" || r.action === "replaced");
        const names = results
          .filter((r) => r.action === "installed" || r.action === "replaced")
          .map((r) => r.package);

        // BUG fix (Wave QW): a not-found / fetch-fail package previously left
        // the process exit code at 0, so `am install bogus-pkg` looked like a
        // success to callers and CI. Any "failed" result is a non-zero exit.
        if (results.some((r) => r.action === "failed")) {
          process.exitCode = 1;
        }

        if (args.json) {
          output({ action: "install", dryRun, results }, opts);
        }

        // Post-install hint
        if (!args.json && !args.quiet && !dryRun) {
          const installed = results.filter(
            (r) => r.action === "installed" || r.action === "replaced",
          );
          if (installed.length > 0) {
            info("\nRun `am apply` to generate native configs for your tools.", opts);
          }
        }

        return {
          result: undefined,
          changed: shouldWrite,
          commitMessage: shouldWrite ? `registry install: ${names.join(", ")}` : undefined,
        };
      });
    } catch (err) {
      amError(err, opts);
      process.exitCode = 1;
    }
  },
});
