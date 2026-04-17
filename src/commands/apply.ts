import { defineCommand } from "citty";
import { resolveConfigDir } from "../core/config";
import { applyResolved } from "../core/controller";
import { AmError } from "../lib/errors";
import { amError, info, output, warn } from "../lib/output";

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

      let applyResult;
      try {
        applyResult = await applyResolved(configDir, {
          dryRun: args["dry-run"],
          target: args.target,
          profile: args.profile,
        });
      } catch (err) {
        if (err instanceof Error && err.message.includes("not found")) {
          // Adapter-not-found bubbles up from `applyResolved`.
          throw new AmError(err.message, err.message, "ADAPTER_NOT_FOUND");
        }
        throw new AmError(
          "Config not found",
          "Run `am init` to initialize agent-manager",
          "CONFIG_NOT_FOUND",
        );
      }

      const total = applyResult.results.length;
      if (total === 0) {
        info("No tools detected. Nothing to apply.", opts);
        return;
      }

      // Per-adapter reporting stays at the surface — controller returns the
      // structured result, CLI formats it for the terminal.
      for (const res of applyResult.results) {
        const written = res.files.filter((f) => f.written).length;
        if (res.error) {
          warn(`${res.adapter}: ${res.error}`, opts);
          continue;
        }
        if (!args["dry-run"]) {
          info(`${res.adapter}: wrote ${written} file(s)`, opts);
        } else {
          info(`${res.adapter}: would write ${res.files.length} file(s)`, opts);
          for (const f of res.files) {
            info(`  ${f.path}`, opts);
          }
        }
        for (const w of res.warnings) {
          warn(`${res.adapter}: ${w}`, opts);
        }
      }

      if (applyResult.failed.length > 0) {
        const failedNames = applyResult.failed.map((f) => f.adapter).join(", ");
        info(
          `Applied to ${applyResult.succeeded.length} of ${total} adapters. ${applyResult.failed.length} failed: [${failedNames}].`,
          opts,
        );
        process.exitCode = 1;
      } else {
        info(`Applied to ${applyResult.succeeded.length} of ${total} adapters.`, opts);
      }

      if (args.json) {
        output(
          {
            action: "apply",
            profile: applyResult.profile,
            dryRun: args["dry-run"],
            results: applyResult.results.map((r) => ({
              adapter: r.adapter,
              files: r.files,
              warnings: r.warnings,
            })),
            succeeded: applyResult.succeeded.length,
            failed: applyResult.failed,
            skipped: applyResult.skipped,
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
