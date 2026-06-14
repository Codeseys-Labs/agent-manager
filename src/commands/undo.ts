import { defineCommand } from "citty";
import { resolveConfigDir } from "../core/config";
import { getStatus, log as gitLog, revertHead } from "../core/git";
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

    // ws4-6fd2: `am undo` reverts COMMITTED history (git revert). Any
    // uncommitted working-tree edits in the config repo are NOT part of that
    // revert — and `revertHead` can fail outright when the tree is dirty. Warn
    // BEFORE reverting so the operator understands the scope and isn't
    // surprised by a failure or by edits that survive untouched.
    let dirtyFiles: string[] = [];
    try {
      const status = await getStatus(configDir);
      if (!status.clean) {
        dirtyFiles = status.dirty;
        const dirtyMsg = `Uncommitted edits in the config repo (${dirtyFiles.length} file(s): ${dirtyFiles.join(", ")}). \`am undo\` reverts COMMITTED history only — these working-tree edits are left untouched (and may block the revert). Commit or discard them first if you want a clean undo.`;
        warn(dirtyMsg, opts);
      }
    } catch {
      // Non-fatal: if status can't be read we still attempt the revert, which
      // will surface its own error below.
    }

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
      // ws4-6fd2: be honest about what `--apply` does. The revert restored the
      // PREVIOUS catalog, but `am apply` runs WITHOUT --force (the fail-closed
      // drift gate is on), so if the native config was hand-edited since the
      // reverted change, apply will REFUSE to overwrite the drifted adapter and
      // report a skip — it will NOT silently re-introduce the reverted state on
      // top of local edits. Surface that expectation up front rather than
      // letting the user assume `--apply` always rewrites every tool.
      info(
        "Regenerating native configs (drift gate stays on — drifted adapters are skipped, not force-overwritten)...",
        opts,
      );
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
      output(
        { action: "undo", reverted: headMsg, oid, applied, dirtyBeforeUndo: dirtyFiles },
        opts,
      );
    }
  },
});
