import * as fs from "node:fs";
import { relative, sep } from "node:path";
import git from "isomorphic-git";
import { type OutputOptions, warn } from "../lib/output";

const DEFAULT_AUTHOR = { name: "agent-manager", email: "am@localhost" };

function toRepoRelative(dir: string, path: string): string | null {
  const rel = relative(dir, path).split(sep).join("/");
  if (!rel || rel === "." || rel.startsWith("../") || rel === "..") return null;
  return rel;
}

function isMissingPath(err: unknown): boolean {
  const code = (err as { code?: unknown })?.code;
  return code === "ENOENT" || code === "NotFoundError";
}

/**
 * Best-effort commit helper for ADR-0051 secrets verbs.
 *
 * The command's secrets mutation is the source of truth; git is intentionally
 * advisory here. We stage only the caller-supplied paths (not the whole tree)
 * and warn instead of failing when the directory is not a git repo, has nothing
 * to commit, or is otherwise unable to commit.
 */
export async function bestEffortCommitSecretsChanges(
  dir: string,
  paths: readonly string[],
  message: string,
  opts: OutputOptions,
): Promise<string | null> {
  try {
    const unique = Array.from(
      new Set(paths.map((p) => toRepoRelative(dir, p)).filter(Boolean)),
    ) as string[];
    if (unique.length === 0) {
      warn("Skipped secrets auto-commit: no changed paths are inside the config repo.", opts);
      return null;
    }

    for (const filepath of unique) {
      try {
        await git.add({ fs, dir, filepath });
      } catch (err) {
        if (isMissingPath(err)) {
          try {
            await git.remove({ fs, dir, filepath });
          } catch (removeErr) {
            if (!isMissingPath(removeErr)) throw removeErr;
          }
        } else {
          throw err;
        }
      }
    }

    const matrix = await git.statusMatrix({ fs, dir, filepaths: unique });
    const hasStagedChanges = matrix.some(([_filepath, head, _workdir, stage]) => head !== stage);
    if (!hasStagedChanges) {
      warn("Skipped secrets auto-commit: nothing to commit.", opts);
      return null;
    }

    return await git.commit({ fs, dir, message, author: DEFAULT_AUTHOR });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    warn(`Secrets changes succeeded, but auto-commit failed: ${msg}`, opts);
    return null;
  }
}
