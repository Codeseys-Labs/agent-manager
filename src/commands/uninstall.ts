import * as clack from "@clack/prompts";
import { defineCommand } from "citty";
import { resolveConfigDir } from "../core/config";
import { withConfig } from "../core/controller";
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

      // REV-1 MEDIUM-2: serialize RMW via withConfig (was raw read → writeConfig).
      await withConfig(configDir, async (config) => {
        requireConfig(config);

        const name = args.name;
        const server = config.servers?.[name];

        if (!server) {
          error(`Server "${name}" not found in config.`, opts);
          process.exitCode = 1;
          return { result: undefined, changed: false };
        }

        const provenance: RegistryProvenance | undefined = server._registry;

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
          return { result: undefined, changed: false };
        }

        // Confirm removal.
        // FAIL CLOSED: a destructive removal must never proceed unconfirmed.
        // When confirmation is required (no --yes) but we cannot interactively
        // prompt (non-TTY stdin: scripts, CI, piped input) and --json was not
        // passed (the structured/automation contract), REFUSE rather than
        // silently deleting. The previous `&& process.stdin.isTTY` guard failed
        // OPEN — under a non-TTY it skipped the prompt and removed the server
        // without consent. Operators in non-TTY contexts must pass --yes.
        if (!skipConfirm && !args.json) {
          if (!process.stdin.isTTY) {
            error(
              `Refusing to remove server "${name}" without confirmation. stdin is not a TTY — pass --yes to confirm non-interactively.`,
              opts,
            );
            process.exitCode = 1;
            return { result: undefined, changed: false };
          }
          const confirm = await clack.confirm({
            message: `Remove server "${name}"?`,
            initialValue: false,
          });
          if (clack.isCancel(confirm) || !confirm) {
            info("Cancelled.", opts);
            return { result: undefined, changed: false };
          }
        }

        delete config.servers![name];

        info(`Removed server "${name}".`, opts);
        if (args.json) {
          output({ action: "uninstall", server: name, provenance: provenance ?? null }, opts);
        }

        if (!args.json && !args.quiet) {
          info("Run `am apply` to update native configs.", opts);
        }

        return {
          result: undefined,
          changed: true,
          commitMessage: `uninstall server: ${name}`,
        };
      });
    } catch (err) {
      amError(err, opts);
      process.exitCode = 1;
    }
  },
});
