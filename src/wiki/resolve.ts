/**
 * M5.3-lite: `am wiki resolve` — consume wiki-conflict.json sidecar
 * written by M5.2's syncWiki on divergence. For each file the user
 * picks keep-local / take-remote / edit; the chosen version is staged
 * and a manual-resolution commit lands. Sidecar is deleted on success.
 *
 * Pure-ish: all IO primitives are injected so tests can stub
 * @clack/prompts without forking the whole runtime. The CLI wrapper
 * in src/commands/wiki.ts provides the real prompt function.
 */

import * as fs from "node:fs";
import { join, resolve as resolvePath, sep } from "node:path";
import git from "isomorphic-git";
import { commitAll, stageWikiFiles } from "../core/git";
import { CONFLICT_SIDECAR, type ConflictSidecar, clearConflictSidecar } from "./sync";

/**
 * REV-M53-1 (2026-05-03-E): guard against path traversal from a crafted
 * sidecar. Every filepath that comes from conflictedFiles[] MUST resolve
 * to a location inside wikiDir. A hostile remote could write a commit
 * creating `../../evil` and cause M5.2 to record that in the sidecar.
 * We refuse any filepath whose resolved absolute form escapes wikiDir.
 */
function assertPathInside(wikiDir: string, filepath: string): string {
  const absWiki = resolvePath(wikiDir);
  const abs = resolvePath(absWiki, filepath);
  // Both paths come from node:path.resolve, which emits the NATIVE separator
  // (`\` on Windows, `/` on POSIX). Use `path.sep` for the containment check —
  // a hardcoded "/" makes `startsWith(absWiki + "/")` always false on Windows,
  // which previously rejected every legitimate in-tree file as a traversal.
  // When absWiki is a filesystem ROOT it already ends in sep (`/`, `C:\`), so
  // appending another would form `//`/`C:\\` and reject every in-tree path —
  // only add the boundary sep when it isn't already present.
  const prefix = absWiki.endsWith(sep) ? absWiki : absWiki + sep;
  if (abs !== absWiki && !abs.startsWith(prefix)) {
    throw new Error(`Unsafe path in sidecar rejected (traversal attempt?): "${filepath}"`);
  }
  return abs;
}

export type ResolveChoice = "keep-local" | "take-remote" | "edit" | "skip";

export interface ResolveIo {
  /**
   * Prompt the user for a per-file decision. Return "skip" to leave the
   * file unstaged (the sidecar will still be cleared only if every file
   * got a non-skip decision — callers check).
   */
  pickChoice(file: string, sidecar: ConflictSidecar): Promise<ResolveChoice>;
  /**
   * Interactive editor pass for the "edit" choice. Blocks until the user
   * finishes. Receives the absolute path to the file on disk (workdir
   * contains the user's local version; the user edits it and saves).
   */
  openEditor(absPath: string): Promise<void>;
  /**
   * Optional info hook (status line, progress, etc.). Defaults to
   * console.error in real CLI usage; tests pass a collecting fn.
   */
  info?: (msg: string) => void;
}

export interface ResolveResult {
  resolvedFiles: Array<{ file: string; choice: ResolveChoice }>;
  commitOid?: string;
  sidecarCleared: boolean;
  sidecarPath: string;
}

/**
 * Read the sidecar at wikiDir. Returns null if absent.
 */
export async function readConflictSidecar(wikiDir: string): Promise<ConflictSidecar | null> {
  const path = join(wikiDir, CONFLICT_SIDECAR);
  try {
    const text = await fs.promises.readFile(path, "utf-8");
    return JSON.parse(text) as ConflictSidecar;
  } catch {
    return null;
  }
}

/**
 * Write the remote version of a file into the workdir. Uses the
 * remote-tracking ref (FETCH_HEAD) if present; falls back to origin/<branch>.
 *
 * Implementation note (isomorphic-git): there's no direct
 * `git checkout <tree-ish> -- <file>` primitive. Instead we resolve the
 * commit oid, read the file's blob via readBlob, and write it to disk.
 * The caller then stages the result via stageWikiFiles.
 */
export async function writeRemoteVersionToWorkdir(
  wikiDir: string,
  filepath: string,
  sidecar: ConflictSidecar,
): Promise<void> {
  // REV-M53-1: reject traversal BEFORE any disk/git work.
  const abs = assertPathInside(wikiDir, filepath);
  // Best-effort: try FETCH_HEAD first (that's what pullFastForwardOnly's
  // fetch leaves behind), then fall back to origin/<branch>, then the
  // bare remote ref name.
  const branch = sidecar.branch ?? (await git.currentBranch({ fs, dir: wikiDir })) ?? "main";
  // FETCH_HEAD is a text file (one line per ref-spec with the first word
  // being the oid), NOT a ref that resolveRef can handle. Parse it
  // directly, then fall back to standard refs.
  let oid: string | null = null;
  try {
    const fetchHeadPath = join(wikiDir, ".git", "FETCH_HEAD");
    const content = await fs.promises.readFile(fetchHeadPath, "utf-8");
    // Prefer the line with "branch '<branch>'" if present; else first line.
    const lines = content.split("\n").filter(Boolean);
    const branchLine = lines.find((l) => l.includes(`branch '${branch}'`)) ?? lines[0];
    if (branchLine) {
      const firstWord = branchLine.split(/\s/)[0]?.trim();
      if (firstWord && /^[0-9a-f]{40}$/.test(firstWord)) oid = firstWord;
    }
  } catch {
    // FETCH_HEAD missing — fall through to remote refs
  }
  const candidates = [
    `refs/remotes/origin/${branch}`,
    `remotes/origin/${branch}`,
    `origin/${branch}`,
  ];
  if (!oid) {
    for (const ref of candidates) {
      try {
        oid = await git.resolveRef({ fs, dir: wikiDir, ref });
        if (oid) break;
      } catch {
        // try next
      }
    }
  }
  if (!oid) {
    throw new Error(
      `Cannot locate remote commit for branch "${branch}" — tried FETCH_HEAD + origin/${branch}. Run \`git -C ${wikiDir} fetch origin ${branch}\` and retry.`,
    );
  }

  // REV-M53-2 (2026-05-03-E): FETCH_HEAD may resolve to an annotated
  // tag object; readBlob needs a commit or tree oid. Dereference tag
  // chain before blob lookup. git.readObject with type='tag' returns
  // { object: { object: innerOid } } on hit; non-tags throw or return
  // a different type — fall through to use oid as-is.
  let commitOid = oid;
  try {
    const obj = await git.readObject({ fs, dir: wikiDir, oid });
    if (obj.type === "tag") {
      // The tag's .object field points at the tagged commit.
      const tag = obj.object as { object?: string } | string;
      commitOid = typeof tag === "object" && tag.object ? tag.object : oid;
    }
  } catch {
    // If readObject fails, defer to readBlob which will surface a better error.
  }

  const { blob } = await git.readBlob({ fs, dir: wikiDir, oid: commitOid, filepath });
  await fs.promises.mkdir(join(abs, ".."), { recursive: true });
  await fs.promises.writeFile(abs, Buffer.from(blob));
}

/**
 * Core resolve loop. For every conflictedFile in the sidecar:
 *   - keep-local: leave workdir as-is (the user's local commit that was
 *     rolled back via softResetHead in M5.2; the file content is the
 *     local edit the user made).
 *   - take-remote: overwrite workdir with the remote's version.
 *   - edit: call io.openEditor(absPath) and trust the user's output.
 *   - skip: do nothing, don't stage (sidecar not cleared unless every
 *     file was handled non-skip).
 *
 * After the loop, stage every non-skip file and commit. Clear sidecar.
 */
export async function resolveConflicts(wikiDir: string, io: ResolveIo): Promise<ResolveResult> {
  const sidecar = await readConflictSidecar(wikiDir);
  if (!sidecar) {
    return {
      resolvedFiles: [],
      sidecarCleared: false,
      sidecarPath: join(wikiDir, CONFLICT_SIDECAR),
    };
  }

  const resolvedFiles: Array<{ file: string; choice: ResolveChoice }> = [];
  const toStage: string[] = [];
  let anySkipped = false;

  for (const file of sidecar.conflictedFiles) {
    const choice = await io.pickChoice(file, sidecar);
    resolvedFiles.push({ file, choice });
    if (choice === "skip") {
      anySkipped = true;
      io.info?.(`skipped: ${file}`);
      continue;
    }
    if (choice === "take-remote") {
      await writeRemoteVersionToWorkdir(wikiDir, file, sidecar);
      io.info?.(`took remote: ${file}`);
    } else if (choice === "edit") {
      // REV-M53-1: assert path is inside wikiDir before spawning editor.
      const abs = assertPathInside(wikiDir, file);
      await io.openEditor(abs);
      io.info?.(`edited: ${file}`);
    } else {
      // keep-local: no workdir change needed
      io.info?.(`kept local: ${file}`);
    }
    // REV-M53-1: keep-local path had no path-check; stageWikiFiles passes the
    // relative filepath to git.add which itself refuses paths outside the
    // repo, but we assert here too for defense-in-depth.
    assertPathInside(wikiDir, file);
    toStage.push(file);
  }

  let commitOid: string | undefined;
  let sidecarCleared = false;
  if (toStage.length > 0) {
    await stageWikiFiles(wikiDir, toStage);
    try {
      commitOid = await commitAll(wikiDir, "wiki: resolve merge conflict (manual)");
    } catch (err) {
      // Nothing-to-commit → the user picked keep-local for every file
      // and none of them had changes relative to HEAD. That's fine;
      // still clear the sidecar.
      const msg = (err as { message?: string }).message;
      if (msg !== "Nothing to commit") throw err;
    }
  }
  // Only clear sidecar if we processed every entry (no skips leftover).
  if (!anySkipped) {
    await clearConflictSidecar(wikiDir);
    sidecarCleared = true;
  }

  return {
    resolvedFiles,
    commitOid,
    sidecarCleared,
    sidecarPath: join(wikiDir, CONFLICT_SIDECAR),
  };
}
