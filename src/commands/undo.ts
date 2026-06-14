import * as clack from "@clack/prompts";
import { defineCommand } from "citty";
import { resolveConfigDir } from "../core/config";
import { getStatus, log as gitLog, revertHead } from "../core/git";
import { errorMessage } from "../lib/errors";
import { error, info, output, warn } from "../lib/output";
import { applyCommand } from "./apply";

/**
 * The subset of `@clack/prompts` the dirty-tree confirmation path uses. Pulled
 * into a named type so a test can inject a deterministic, non-blocking double
 * for the TTY confirm branch WITHOUT a process-global
 * `mock.module("@clack/prompts", …)` — that approach leaks into every other
 * parallel test file that imports clack (see the same seam in
 * commands/apply.ts and commands/setup.ts).
 */
export type ClackLike = Pick<typeof clack, "confirm" | "isCancel">;

let clackOverride: ClackLike | null = null;

/** @internal test seam — inject a clack double for the dirty-tree confirm path. */
export function __setUndoClackForTests(impl: ClackLike | null): void {
  clackOverride = impl;
}

/** Resolve the clack implementation (real module, or a test-injected double). */
function getClack(): ClackLike {
  return clackOverride ?? clack;
}

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
    force: {
      type: "boolean",
      description:
        "Revert even when the config repo has uncommitted edits. The revert " +
        "overwrites the working tree with the parent commit, so uncommitted " +
        "changes to reverted files are DISCARDED. Without this flag a dirty " +
        "tree is refused (or, in a TTY, prompted) to prevent silent data loss.",
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

    // c47a CLEAN GATE: `am undo` reverts via `revertHead`, which fs.writeFile's
    // every parent-commit blob over the working tree (and removes files absent
    // from the parent). That UNCONDITIONALLY clobbers any uncommitted edits to
    // a file present in the parent tree (e.g. config.toml) with NO recovery —
    // the edits were never committed, so they are simply gone. The old code
    // only WARNED then proceeded. We now refuse (fail closed) unless the
    // operator opts in. The gate runs AFTER the "Nothing to undo" check above
    // and BEFORE revertHead / --apply below, so neither side effect fires when
    // we refuse.
    let dirtyFiles: string[] = [];
    let dirty = false;
    try {
      const status = await getStatus(configDir);
      if (!status.clean) {
        dirty = true;
        dirtyFiles = status.dirty;
      }
    } catch {
      // Non-fatal: if status can't be read we cannot prove the tree is clean,
      // but failing closed here would block every undo on an unreadable repo.
      // Fall through to the revert, which surfaces its own error below.
    }

    if (dirty) {
      const fileList = dirtyFiles.join(", ");
      // Static body kept as a plain-string constant so the dynamic prefix below
      // is the ONLY interpolation — biome's useTemplate rule rejects mixing a
      // `${…}` template literal with `+` string concatenation, so we join the
      // dynamic head and the static tail with a single template literal instead.
      const dirtyBody =
        "`am undo` overwrites the working tree with the previous commit, which would " +
        "PERMANENTLY DISCARD these uncommitted changes (they were never committed, so " +
        "they cannot be recovered).";
      const dirtyMsg = `Uncommitted edits in the config repo (${dirtyFiles.length} file(s): ${fileList}). ${dirtyBody}`;
      const cleanupHint =
        "Commit or discard them first " +
        "(e.g. `git -C <config dir> commit` / `git -C <config dir> checkout -- .`), " +
        "or pass `--force` to undo and discard them.";

      if (args.force) {
        // Operator explicitly opted in; surface the data-loss warning but proceed.
        warn(`${dirtyMsg} Proceeding anyway because --force was passed.`, opts);
      } else {
        const interactive = !args.json && !args.quiet && Boolean(process.stdin.isTTY);
        if (interactive) {
          warn(dirtyMsg, opts);
          const prompt = getClack();
          const confirmed = await prompt.confirm({
            message: "Discard these uncommitted edits and undo anyway?",
            initialValue: false,
          });
          if (prompt.isCancel(confirmed) || !confirmed) {
            info("Undo aborted — working tree left untouched.", opts);
            return;
          }
        } else {
          // Non-interactive (scripts/CI, --json, --quiet, or no TTY): refuse.
          error(`${dirtyMsg} ${cleanupHint}`, opts);
          process.exitCode = 1;
          return;
        }
      }
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
