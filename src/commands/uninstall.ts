import { join } from "node:path";
import * as clack from "@clack/prompts";
import { defineCommand } from "citty";
import { resolveConfigDir, tryReadConfig, writeConfig } from "../core/config";
import { commitAll } from "../core/git";
import { requireConfig } from "../lib/errors";
import { amError, error, info, output } from "../lib/output";
import type { RegistryProvenance } from "../registry/types";

export const uninstallCommand = defineCommand({
  meta: { name: "uninstall", description: "Remove an MCP server package from config" },
  args: {
    name: { type: "positional", description: "Server name to remove", required: true },
    "dry-run": { type: "boolean", description: "Preview changes without writing", default: false },
    yes: { type: "boolean", alias: "y", description: "Skip confirmation", default: false },
    json: { type: "boolean", description: "JSON output", default: false },
    quiet: { type: "boolean", alias: "q", default: false },
    verbose: { type: "boolean", alias: "v", default: false },
  },
  async run({ args }) {
    const opts = { json: args.json, quiet: args.quiet, verbose: args.verbose };
    try {
      const dryRun = args["dry-run"] ?? false;
      const skipConfirm = args.yes ?? false;
      const configDir = resolveConfigDir();
      const configPath = join(configDir, "config.toml");

      const config = await tryReadConfig(configPath);
      requireConfig(config);

      const name = args.name;
      const server = config.servers?.[name];

      if (!server) {
        error(`Server "${name}" not found in config.`, opts);
        process.exitCode = 1;
        return;
      }

      const provenance = server._registry;

      if (dryRun) {
        info(`[dry-run] Would remove server "${name}"`, opts);
        if (provenance) {
          info(`  registry package: ${provenance.package} v${provenance.version}`, opts);
        }
        if (args.json) {
          output(
            { action: "uninstall", dryRun: true, server: name, provenance: provenance ?? null },
            opts,
          );
        }
        return;
      }

      // Confirm removal
      if (!skipConfirm && !args.json && process.stdin.isTTY) {
        const confirm = await clack.confirm({
          message: `Remove server "${name}"?`,
          initialValue: false,
        });
        if (clack.isCancel(confirm) || !confirm) {
          info("Cancelled.", opts);
          return;
        }
      }

      delete config.servers![name];
      await writeConfig(configPath, config);

      try {
        await commitAll(configDir, `uninstall server: ${name}`);
      } catch {
        // Nothing to commit
      }

      info(`Removed server "${name}".`, opts);
      if (args.json) {
        output({ action: "uninstall", server: name, provenance: provenance ?? null }, opts);
      }

      if (!args.json && !args.quiet) {
        info("Run `am apply` to update native configs.", opts);
      }
    } catch (err) {
      amError(err, opts);
      process.exitCode = 1;
    }
  },
});
