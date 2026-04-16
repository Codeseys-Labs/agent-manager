import { join } from "node:path";
import * as clack from "@clack/prompts";
import { defineCommand } from "citty";
import { resolveConfigDir, tryReadConfig, writeConfig } from "../core/config";
import { commitAll } from "../core/git";
import { requireConfig } from "../lib/errors";
import { amError, error, info, output } from "../lib/output";
import { RegistryError, getPackage } from "../registry/client";
import type { RegistryPackage, RegistryProvenance } from "../registry/types";

interface UpdateCandidate {
  name: string;
  currentVersion: string;
  latestVersion: string;
  pkg: RegistryPackage;
}

export const updateCommand = defineCommand({
  meta: { name: "update", description: "Check for and apply MCP registry updates" },
  args: {
    "dry-run": {
      type: "boolean",
      description: "Preview available updates without applying",
      default: false,
    },
    yes: {
      type: "boolean",
      alias: "y",
      description: "Auto-update all without confirmation",
      default: false,
    },
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
      const configPath = join(configDir, "config.toml");

      const config = await tryReadConfig(configPath);
      requireConfig(config);

      // Find servers installed from the registry
      const registryServers: Array<{ name: string; provenance: RegistryProvenance }> = [];
      for (const [name, server] of Object.entries(config.servers ?? {})) {
        const provenance = server._registry;
        if (provenance?.source === "mcp-registry") {
          registryServers.push({ name, provenance });
        }
      }

      if (registryServers.length === 0) {
        info(
          "No registry-installed servers found. Install packages with `am install <name>`.",
          opts,
        );
        if (args.json) {
          output({ action: "update", updates: [], total: 0 }, opts);
        }
        return;
      }

      info(`Checking ${registryServers.length} registry-installed server(s) for updates...`, opts);

      // Check each for updates
      const candidates: UpdateCandidate[] = [];
      const errors: Array<{ name: string; error: string }> = [];

      for (const { name, provenance } of registryServers) {
        try {
          const latest = await getPackage(provenance.package, { skipCache });
          if (!latest) {
            errors.push({ name, error: "Package no longer exists in registry" });
            continue;
          }
          if (latest.version !== provenance.version) {
            candidates.push({
              name,
              currentVersion: provenance.version,
              latestVersion: latest.version,
              pkg: latest,
            });
          }
        } catch (err) {
          const msg = err instanceof RegistryError ? err.message : (err as Error).message;
          errors.push({ name, error: msg });
        }
      }

      // Report errors
      for (const e of errors) {
        info(`  ⚠ ${e.name}: ${e.error}`, opts);
      }

      if (candidates.length === 0) {
        info("All registry-installed servers are up to date.", opts);
        if (args.json) {
          output({ action: "update", updates: [], errors, total: 0 }, opts);
        }
        return;
      }

      // Display available updates
      info(`\n${"Server".padEnd(25)} ${"Current".padEnd(12)} ${"Latest".padEnd(12)}`, opts);
      info(`${"─".repeat(25)} ${"─".repeat(12)} ${"─".repeat(12)}`, opts);
      for (const c of candidates) {
        info(
          `${c.name.padEnd(25)} ${c.currentVersion.padEnd(12)} ${c.latestVersion.padEnd(12)}`,
          opts,
        );
      }
      info("", opts);

      if (dryRun) {
        info(`${candidates.length} update(s) available.`, opts);
        if (args.json) {
          output(
            {
              action: "update",
              dryRun: true,
              updates: candidates.map((c) => ({
                name: c.name,
                currentVersion: c.currentVersion,
                latestVersion: c.latestVersion,
              })),
              errors,
              total: candidates.length,
            },
            opts,
          );
        }
        return;
      }

      // Confirm updates
      if (!skipConfirm && !args.json && process.stdin.isTTY) {
        const confirm = await clack.confirm({
          message: `Apply ${candidates.length} update(s)?`,
          initialValue: true,
        });
        if (clack.isCancel(confirm) || !confirm) {
          info("Cancelled.", opts);
          return;
        }
      }

      // Apply updates
      const updated: string[] = [];
      for (const c of candidates) {
        const existing = config.servers![c.name];
        const existingEnv = existing.env;

        config.servers![c.name] = {
          command: c.pkg.server.command,
          args: c.pkg.server.args,
          transport: c.pkg.server.transport ?? "stdio",
          enabled: existing.enabled ?? true,
          description: c.pkg.description,
          tags: c.pkg.tags,
          // Preserve user's env vars
          ...(existingEnv ? { env: existingEnv } : {}),
          _registry: {
            source: "mcp-registry" as const,
            package: c.pkg.name,
            version: c.pkg.version,
            installed_at: new Date().toISOString(),
          },
        };

        updated.push(c.name);
        info(`Updated "${c.name}" ${c.currentVersion} → ${c.latestVersion}`, opts);
      }

      if (updated.length > 0) {
        await writeConfig(configPath, config);
        try {
          await commitAll(configDir, `registry update: ${updated.join(", ")}`);
        } catch {
          // Nothing to commit
        }
      }

      if (args.json) {
        output(
          {
            action: "update",
            updates: candidates.map((c) => ({
              name: c.name,
              currentVersion: c.currentVersion,
              latestVersion: c.latestVersion,
            })),
            errors,
            total: updated.length,
          },
          opts,
        );
      }

      if (!args.json && !args.quiet && updated.length > 0) {
        info("\nRun `am apply` to regenerate native configs.", opts);
      }
    } catch (err) {
      amError(err, opts);
      process.exitCode = 1;
    }
  },
});
