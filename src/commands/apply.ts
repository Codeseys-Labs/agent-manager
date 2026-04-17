import { join } from "node:path";
import { defineCommand } from "citty";
import { getAdapter, getDetectedAdapters, listAdapters } from "../adapters/registry";
import {
  buildResolvedConfig,
  loadResolvedConfig,
  resolveConfigDir,
  resolveProjectConfig,
} from "../core/config";
import { interpolateEnvAsync, loadKey } from "../core/secrets";
import { AmError, errorMessage } from "../lib/errors";
import { amError, debug, error, info, output, warn } from "../lib/output";
import { readActiveProfile } from "./use";

export const applyCommand = defineCommand({
  meta: { name: "apply", description: "Generate native configs for detected tools" },
  args: {
    "dry-run": { type: "boolean", description: "Preview changes without writing", default: false },
    diff: { type: "boolean", description: "Show diff before applying", default: false },
    force: { type: "boolean", description: "Overwrite even if drifted", default: false },
    target: { type: "string", description: "Apply to specific adapter only" },
    profile: { type: "string", description: "Override active profile" },
    json: { type: "boolean", description: "JSON output", default: false },
    quiet: { type: "boolean", alias: "q", default: false },
    verbose: { type: "boolean", alias: "v", default: false },
  },
  async run({ args }) {
    const opts = { json: args.json, quiet: args.quiet, verbose: args.verbose };
    try {
      const configDir = resolveConfigDir();
      const projectFile = resolveProjectConfig(process.cwd());

      let config;
      try {
        config = await loadResolvedConfig({ configDir, projectFile });
      } catch {
        throw new AmError(
          "Config not found",
          "Run `am init` to initialize agent-manager",
          "CONFIG_NOT_FOUND",
        );
      }

      // Determine profile
      const profileName =
        args.profile ??
        (await readActiveProfile(configDir)) ??
        config.settings?.default_profile ??
        "default";

      // Decrypt encrypted values before building resolved config
      const encryptionKey = await loadKey(configDir);
      const { config: interpolated, warnings: interpWarnings } = await interpolateEnvAsync(config, {
        encryptionKey: encryptionKey ?? undefined,
      });
      for (const w of interpWarnings) {
        debug(`interpolation: ${w}`, opts);
      }

      const resolved = buildResolvedConfig(interpolated, profileName, configDir);

      // Find adapters to apply
      let adapters;
      if (args.target) {
        const adapter = await getAdapter(args.target);
        if (!adapter) {
          const available = listAdapters();
          throw new AmError(
            `Adapter "${args.target}" not found`,
            `Available adapters: ${available.join(", ")}`,
            "ADAPTER_NOT_FOUND",
          );
        }
        adapters = [adapter];
      } else {
        adapters = await getDetectedAdapters();
      }

      if (adapters.length === 0) {
        info("No tools detected. Nothing to apply.", opts);
        return;
      }

      const results: Array<{
        adapter: string;
        files: Array<{ path: string; written: boolean }>;
        warnings: string[];
      }> = [];
      const succeeded: string[] = [];
      const failed: Array<{ adapter: string; error: string }> = [];
      const skipped: string[] = [];

      for (const adapter of adapters) {
        debug(`Applying to ${adapter.meta.displayName}...`, opts);

        if (args.diff) {
          try {
            const diffResult = await adapter.diff(resolved);
            if (diffResult.status === "in-sync") {
              info(`${adapter.meta.displayName}: in sync`, opts);
            } else {
              info(`${adapter.meta.displayName}: ${diffResult.changes.length} change(s)`, opts);
              for (const change of diffResult.changes) {
                info(`  ${change.type}: ${change.entity} "${change.name}"`, opts);
              }
            }
          } catch {
            debug(`${adapter.meta.displayName}: diff not available`, opts);
          }
        }

        try {
          const result = await adapter.export(resolved, {
            projectPath: projectFile ? join(projectFile, "..") : undefined,
            dryRun: args["dry-run"],
          });

          results.push({
            adapter: adapter.meta.name,
            files: result.files.map((f) => ({ path: f.path, written: f.written })),
            warnings: result.warnings,
          });
          succeeded.push(adapter.meta.name);

          if (!args["dry-run"]) {
            info(
              `${adapter.meta.displayName}: wrote ${result.files.filter((f) => f.written).length} file(s)`,
              opts,
            );
          } else {
            info(`${adapter.meta.displayName}: would write ${result.files.length} file(s)`, opts);
            for (const f of result.files) {
              info(`  ${f.path}`, opts);
            }
          }

          for (const w of result.warnings) {
            warn(`${adapter.meta.displayName}: ${w}`, opts);
          }
        } catch (e: unknown) {
          const msg = errorMessage(e) || "export failed";
          warn(`${adapter.meta.displayName}: ${msg}`, opts);
          results.push({ adapter: adapter.meta.name, files: [], warnings: [msg] });
          failed.push({ adapter: adapter.meta.name, error: msg });
        }
      }

      // Final summary line — always visible (stdout when non-JSON, included
      // in the JSON envelope under --json).
      const total = adapters.length;
      if (failed.length > 0) {
        const failedNames = failed.map((f) => f.adapter).join(", ");
        info(
          `Applied to ${succeeded.length} of ${total} adapters. ${failed.length} failed: [${failedNames}].`,
          opts,
        );
        // Partial failures must surface to scripting callers — set a non-zero
        // exit code even though individual per-adapter failures were caught.
        process.exitCode = 1;
      } else {
        info(`Applied to ${succeeded.length} of ${total} adapters.`, opts);
      }

      if (args.json) {
        output(
          {
            action: "apply",
            profile: profileName,
            dryRun: args["dry-run"],
            results,
            succeeded: succeeded.length,
            failed,
            skipped,
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
