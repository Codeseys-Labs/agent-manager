import { defineCommand } from "citty";
import { resolveConfigDir } from "../core/config";
import { log as gitLog, revertHead } from "../core/git";
import { errorMessage } from "../lib/errors";
import { error, info, output, warn } from "../lib/output";
import { applyCommand } from "./apply";

export const undoCommand = defineCommand({
  meta: { name: "undo", description: "Revert the last config change" },
  args: {
    apply: {
      type: "boolean",
      description:
        "Regenerate IDE configs after revert by running `am apply` automatically. " +
        "Without this flag, native configs remain stale until you run `am apply` manually.",
      default: false,
    },
    json: { type: "boolean", description: "JSON output", default: false },
    quiet: { type: "boolean", alias: "q", default: false },
    verbose: { type: "boolean", alias: "v", default: false },
  },
  async run({ args }) {
    const opts = { json: args.json, quiet: args.quiet, verbose: args.verbose };
    const configDir = resolveConfigDir();

    // Show what will be reverted
    let entries;
    try {
      entries = await gitLog(configDir, 2);
    } catch {
      error("Cannot read git log. Run `am init` first.", opts);
      process.exitCode = 1;
      return;
    }

    if (entries.length < 2) {
      error("Nothing to undo — only the initial commit exists", opts);
      process.exitCode = 1;
      return;
    }

    const headMsg = entries[0].message;

    let oid: string;
    try {
      oid = await revertHead(configDir);
      info(`Reverted: "${headMsg}"`, opts);
    } catch (e: unknown) {
      error(`Undo failed: ${errorMessage(e) || "unknown error"}`, opts);
      process.exitCode = 1;
      return;
    }

    // If --apply was passed, re-run `am apply` to regenerate IDE configs.
    // Otherwise, emit an unmissable warning about catalog/IDE drift.
    let applied = false;
    if (args.apply) {
      info("Regenerating native configs...", opts);
      try {
        // Delegate to the apply command with compatible flags. Only `args`
        // is read by the apply implementation; the remaining CommandContext
        // fields are placeholders.
        const applyArgs = {
          "dry-run": false,
          diff: false,
          force: false,
          target: undefined as unknown as string,
          profile: undefined as unknown as string,
          json: !!args.json,
          quiet: !!args.quiet,
          verbose: !!args.verbose,
          _: [] as string[],
        };
        await applyCommand.run?.({
          args: applyArgs,
          rawArgs: [],
          cmd: applyCommand,
        } as unknown as Parameters<NonNullable<typeof applyCommand.run>>[0]);
        applied = true;
      } catch (e: unknown) {
        warn(`--apply failed: ${errorMessage(e) || "unknown error"}`, opts);
        warn(
          "WARNING: catalog was reverted but IDE configs may be stale. " +
            "Re-run `am apply` once the underlying problem is resolved.",
          opts,
        );
      }
    } else {
      warn(
        "WARNING: catalog reverted but native IDE configs are now STALE. " +
          "Run `am apply` now to regenerate them (or use `am undo --apply` next time to do both in one step).",
        opts,
      );
    }

    if (args.json) {
      output({ action: "undo", reverted: headMsg, oid, applied }, opts);
    }
  },
});
