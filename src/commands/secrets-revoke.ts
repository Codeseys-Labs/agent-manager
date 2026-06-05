/**
 * `am secrets revoke <fingerprint>` — remove a recipient `.pub` file
 * from the local recipients/ directory and rewrap every envelope so
 * the revoked identity can no longer decrypt new ciphertext
 * (ADR-0051 §"`am secrets revoke`").
 *
 * The `<fingerprint>` argument is matched against (in order):
 *   1. The recipient `id` (the basename of the `.pub` file).
 *   2. The full `age1...` public key inside the file.
 *   3. The 10-hex-char SHA-256 fingerprint that `addRecipient`
 *      derives by default.
 *
 * NOTE on forward secrecy: revoking a recipient and rewrapping does
 * NOT prevent that identity from decrypting historical ciphertext
 * that was encrypted to it before revocation. The only complete
 * mitigation after a confirmed key compromise is to rotate the
 * underlying secret values themselves. See ADR-0051 §"No forward
 * secrecy — documented explicitly".
 */

import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { defineCommand } from "citty";
import { atomicWriteFile } from "../core/atomic-write";
import { resolveConfigDir } from "../core/config";
import { getDefaultBackend } from "../core/secrets";
import type { AgeSecretsBackend } from "../core/secrets-age";
import { amError, info, output, warn } from "../lib/output";
import { bestEffortCommitSecretsChanges } from "./secrets-commit-helper";
import {
  type RewrapStat,
  discoverTomlFiles,
  resolveSingleFile,
  rewrapMany,
} from "./secrets-rewrap-helpers";

interface RecipientMatch {
  filePath: string;
  fileName: string;
  publicKey: string;
  id: string;
  fingerprint: string;
}

function shortFingerprint(publicKey: string): string {
  return createHash("sha256").update(publicKey).digest("hex").slice(0, 10);
}

/**
 * Restore each file that the live rewrap mutated back to its pre-revoke
 * contents from the `.bak` snapshot `rewrapTomlFile` wrote. Returns the
 * list of files that could NOT be restored (no backup recorded, or the
 * restore itself failed) so the caller can warn about residual mutation.
 *
 * A `.bak` is only present when a file was actually rewritten (rewrapped > 0)
 * AND `--no-backup` was not passed. Files whose envelopes were all skipped
 * (rewrapped === 0) were never written, so they need no restoration.
 */
async function rollbackMutatedFiles(stats: readonly RewrapStat[]): Promise<string[]> {
  const failed: string[] = [];
  for (const s of stats) {
    if (s.rewrapped === 0) continue; // file was never written → nothing to undo.
    if (!s.backupPath) {
      // --no-backup: no snapshot to restore from.
      failed.push(s.file);
      continue;
    }
    try {
      const original = await readFile(s.backupPath, "utf-8");
      await atomicWriteFile(s.file, original);
    } catch {
      failed.push(s.file);
    }
  }
  return failed;
}

/**
 * Rollback variant used when `rewrapMany` THREW (R4-BUG1): it never returned
 * stats, so we don't know which files were rewritten. Defensively try to
 * restore every target from its `${file}.bak` snapshot — tolerating files that
 * were never written (no `.bak`) or already-good files. Returns the targets
 * that could NOT be restored. Skips entirely under `--no-backup` (no snapshots
 * exist), reporting all targets as unrestored so the operator is warned.
 */
async function rollbackTargets(targets: readonly string[], noBackup: boolean): Promise<string[]> {
  if (noBackup) return [...targets];
  const failed: string[] = [];
  for (const file of targets) {
    const backupPath = `${file}.bak`;
    try {
      const original = await readFile(backupPath, "utf-8");
      await atomicWriteFile(file, original);
    } catch {
      // No `.bak` (file was never mutated) OR the restore failed. We cannot
      // distinguish cheaply; report it so the operator can verify. A file that
      // was never written is already correct, so this is conservative.
      failed.push(file);
    }
  }
  return failed;
}

/**
 * Re-add the recipient that was removed at the start of the live revoke, so an
 * aborted/rolled-back revoke leaves the recipient set intact. Fault-tolerant:
 * a failing re-add must NOT abort the (already-completed) file rollback
 * (R4-BUG2) — we report it via the returned boolean instead of throwing.
 */
async function safeReAddRecipient(
  ageBackend: AgeSecretsBackend,
  match: RecipientMatch,
): Promise<boolean> {
  try {
    await ageBackend.addRecipient({
      id: match.id,
      publicKey: match.publicKey,
      addedAt: new Date().toISOString(),
    });
    return true;
  } catch {
    return false;
  }
}

/** Build the single human-readable abort message for a rolled-back revoke. */
function buildAbortMessage(
  match: RecipientMatch,
  parts: { reason: string; reAddOk: boolean; unrestored: string[] },
): string {
  const head = `Aborted revoke of ${match.id} (${match.fingerprint}): ${parts.reason}.`;
  const reAdd = parts.reAddOk
    ? " Recipient re-added."
    : " WARNING: recipient could NOT be re-added — re-add it manually (the .pub is missing from recipients/).";
  const files =
    parts.unrestored.length === 0
      ? " All modified files were rolled back to their pre-revoke contents."
      : ` WARNING: ${parts.unrestored.length} file(s) could NOT be rolled back (no backup — re-run WITHOUT --no-backup, or restore from version control): ${parts.unrestored.join(", ")}.`;
  return head + reAdd + files;
}

/**
 * Emit exactly ONE final result for an aborted revoke: a single JSON document
 * on stdout (--json) OR a single stderr warning (R2-BUG3 — never both, never
 * two JSON docs).
 */
function emitAbort(
  json: boolean,
  opts: { json: boolean; quiet: boolean; verbose: boolean },
  msg: string,
  match: RecipientMatch,
  extra: Record<string, unknown>,
): void {
  if (json) {
    output(
      {
        action: "revoke",
        aborted: true,
        recipient: { id: match.id, publicKey: match.publicKey, fingerprint: match.fingerprint },
        ...extra,
      },
      opts,
    );
  } else {
    warn(msg, opts);
  }
}

async function findRecipient(
  recipientsDir: string,
  needle: string,
): Promise<RecipientMatch | null> {
  let files: string[];
  try {
    files = await readdir(recipientsDir);
  } catch {
    return null;
  }
  for (const fileName of files) {
    if (!fileName.endsWith(".pub")) continue;
    const filePath = join(recipientsDir, fileName);
    let body: string;
    try {
      body = await readFile(filePath, "utf8");
    } catch {
      continue;
    }
    let publicKey = "";
    let id = fileName.slice(0, -".pub".length);
    for (const rawLine of body.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (line.length === 0) continue;
      if (line.startsWith("#")) {
        const m = /^id\s*:\s*(.+)$/i.exec(line.slice(1).trim());
        if (m) id = m[1]!.trim();
        continue;
      }
      if (line.startsWith("age1")) {
        publicKey = line;
        break;
      }
    }
    if (!publicKey) continue;
    const fingerprint = shortFingerprint(publicKey);
    if (needle === id || needle === publicKey || needle === fingerprint || needle === fileName) {
      return { filePath, fileName, publicKey, id, fingerprint };
    }
  }
  return null;
}

export const secretsRevokeCommand = defineCommand({
  meta: {
    name: "revoke",
    description: "Revoke a recipient by id/fingerprint/pubkey and rewrap envelopes (ADR-0051).",
  },
  args: {
    fingerprint: {
      type: "positional",
      required: true,
      description: "Recipient id, age1 public key, or 10-hex fingerprint to revoke.",
    },
    "dry-run": {
      type: "boolean",
      description: "Report planned changes; do not modify any files.",
      default: false,
    },
    file: {
      type: "string",
      description: "Target a specific TOML file instead of auto-discovering.",
    },
    "no-backup": {
      type: "boolean",
      description: "Do not write a `.bak` copy of each modified file.",
      default: false,
    },
    json: { type: "boolean", description: "JSON output", default: false },
    quiet: { type: "boolean", alias: "q", default: false },
    verbose: { type: "boolean", alias: "v", default: false },
  },
  async run({ args }) {
    const opts = { json: args.json, quiet: args.quiet, verbose: args.verbose };
    try {
      const dryRun = args["dry-run"];
      const noBackup = args["no-backup"];
      const needle = args.fingerprint;

      if (!needle || needle.length === 0) {
        const msg = "am secrets revoke: <fingerprint> argument is required.";
        if (args.json) output({ action: "revoke", error: msg }, opts);
        else info(msg, opts);
        process.exitCode = 1;
        return;
      }

      const configDir = resolveConfigDir();
      const backend = await getDefaultBackend(configDir);

      if (backend.name !== "age") {
        const msg = `am secrets revoke requires the \`age\` backend; current backend is \`${backend.name}\`.`;
        if (args.json) output({ action: "revoke", error: msg, backend: backend.name }, opts);
        else info(msg, opts);
        process.exitCode = 1;
        return;
      }

      const ageBackend = backend as AgeSecretsBackend;
      const recipientsDir = ageBackend.getRecipientsDir();

      const match = await findRecipient(recipientsDir, needle);
      if (!match) {
        const msg = `No recipient matching \`${needle}\` in ${recipientsDir}.`;
        if (args.json) output({ action: "revoke", error: msg }, opts);
        else info(msg, opts);
        process.exitCode = 1;
        return;
      }

      const targets = args.file
        ? [resolveSingleFile(args.file)]
        : await discoverTomlFiles(configDir, process.cwd());

      if (dryRun) {
        const stats = await rewrapMany(targets, ageBackend, { dryRun: true, noBackup });
        const totalFound = stats.reduce((n, s) => n + s.found, 0);
        if (args.json) {
          output(
            {
              action: "revoke",
              reads_only: true,
              would_do: [
                `remove recipient file ${match.fileName}`,
                `rewrap ${totalFound} envelope(s) without ${match.fingerprint}`,
              ],
              mutations_prevented: ["recipient file deletion", "TOML config rewrites"],
              warnings: [
                "Forward secrecy NOT provided: prior ciphertext encrypted to the revoked recipient remains decryptable by them. Rotate underlying secret values if the key is compromised.",
              ],
              explanation: {
                recipient: {
                  id: match.id,
                  publicKey: match.publicKey,
                  fingerprint: match.fingerprint,
                },
                files: stats,
                totals: { found: totalFound },
              },
            },
            opts,
          );
        } else {
          info(
            `Would revoke ${match.id} (${match.fingerprint}) and rewrap ${totalFound} envelope(s).`,
            opts,
          );
        }
        return;
      }

      // Live revoke must be all-or-nothing. Removing the recipient and then
      // rewrapping leaves on-disk state half-mutated if any envelope is
      // skipped (the local identity can't decrypt it): `rewrapTomlFile`
      // PERSISTS any file with rewrapped > 0 — so a file with both rewrapped
      // and skipped envelopes is written with the good envelopes re-encrypted
      // WITHOUT the revoked recipient (de-facto partial revoke), while we'd
      // claim the recipient was NOT revoked. (R2-BUG1.)
      //
      // SAFE-ABORT: scan first (a read-only dry-run). Whether an envelope is
      // skipped depends only on whether the LOCAL identity can decrypt it —
      // removing a *peer* recipient never changes that — so a pre-removal scan
      // faithfully predicts post-removal skips. If the scan is not perfectly
      // clean (any skip, or not every found envelope would rewrap) we abort
      // BEFORE touching the recipient set or any file: nothing is mutated, the
      // recipient stays registered, exit non-zero, and (in --json) exactly ONE
      // JSON document is emitted. This also makes the abort safe under
      // `--no-backup`, where there would be no `.bak` to roll back from.
      const scan = await rewrapMany(targets, ageBackend, { dryRun: true, noBackup });
      const scanFound = scan.reduce((n, s) => n + s.found, 0);
      const scanSkipped = scan.reduce((n, s) => n + s.skipped, 0);

      if (scanSkipped > 0) {
        const skippedFiles = scan.filter((s) => s.skipped > 0).map((s) => s.file);
        const msg = `Aborting revoke of ${match.id} (${match.fingerprint}): ${scanSkipped} of ${scanFound} envelope(s) cannot be rewrapped (the local identity cannot decrypt them). No files were modified and the recipient remains registered. Rotate the underlying secret values, then retry.`;
        if (args.json) {
          output(
            {
              action: "revoke",
              aborted: true,
              error: msg,
              recipient: {
                id: match.id,
                publicKey: match.publicKey,
                fingerprint: match.fingerprint,
              },
              files: scan.length,
              envelopes: scanFound,
              skipped: scanSkipped,
              skipped_files: skippedFiles,
            },
            opts,
          );
        } else {
          info(msg, opts);
        }
        process.exitCode = 1;
        return;
      }

      // Scan is clean → commit to the mutation. Drop the .pub file, then rewrap.
      // The whole mutation window (removeRecipient + the file rewrites) is
      // wrapped so that EITHER a per-envelope skip (TOCTOU) OR a thrown write
      // error (ENOSPC/EACCES/EIO mid-walk — R4-BUG1) triggers the SAME full
      // rollback. Without this, an exception during rewrapMany would bypass the
      // skip-only rollback below and hit the outer catch, leaving the recipient
      // removed and files half-mutated.
      let stats: Awaited<ReturnType<typeof rewrapMany>> = [];
      await ageBackend.removeRecipient(match.id);
      try {
        stats = await rewrapMany(targets, ageBackend, { dryRun: false, noBackup });
      } catch (rewrapErr) {
        // A write threw partway through. rewrapMany does not surface partial
        // stats on throw, so we roll back EVERY target's `.bak` defensively
        // (rollbackTargets tolerates files that were never written / have no
        // .bak), then re-add the recipient. This restores pre-revoke state.
        const unrestored = await rollbackTargets(targets, noBackup);
        const reAddOk = await safeReAddRecipient(ageBackend, match);
        const why = rewrapErr instanceof Error ? rewrapErr.message : String(rewrapErr);
        const msg = buildAbortMessage(match, {
          reason: `the rewrap pass threw before completing (${why})`,
          reAddOk,
          unrestored,
        });
        emitAbort(args.json, opts, msg, match, {
          error: msg,
          reAdded: reAddOk,
          unrestored_files: unrestored,
        });
        process.exitCode = 1;
        return;
      }
      const totalRewrapped = stats.reduce((n, s) => n + s.rewrapped, 0);
      const totalFound = stats.reduce((n, s) => n + s.found, 0);
      const totalSkipped = stats.reduce((n, s) => n + s.skipped, 0);

      // Defensive TRUE ROLLBACK: the clean scan should guarantee a complete
      // rewrap, but a file could change on disk between scan and live pass
      // (TOCTOU). If anything was skipped, undo every mutation so on-disk state
      // matches pre-revoke. Restore FILES FIRST (the de-facto-revoke is the file
      // mutation), THEN re-add the recipient — and a failing re-add must not
      // abort the file rollback (R4-BUG2).
      if (totalSkipped > 0) {
        const unrestored = await rollbackMutatedFiles(stats);
        const reAddOk = await safeReAddRecipient(ageBackend, match);
        const msg = buildAbortMessage(match, {
          reason: `${totalSkipped} of ${totalFound} envelope(s) could not be rewrapped after the recipient set changed`,
          reAddOk,
          unrestored,
        });
        // R2-BUG3: emit exactly ONE JSON document; human warning to stderr.
        emitAbort(args.json, opts, msg, match, {
          error: msg,
          files: stats.length,
          envelopes: totalFound,
          skipped: totalSkipped,
          reAdded: reAddOk,
          rolled_back: stats.filter((s) => s.rewrapped > 0).length - unrestored.length,
          unrestored_files: unrestored,
        });
        process.exitCode = 1;
        return;
      }

      await bestEffortCommitSecretsChanges(
        configDir,
        [...targets, match.filePath],
        `secrets(revoke): remove recipient ${match.fingerprint}, rewrap ${stats.filter((s) => s.rewrapped > 0).length} file(s)`,
        opts,
      );

      if (args.json) {
        output(
          {
            action: "revoke",
            recipient: {
              id: match.id,
              publicKey: match.publicKey,
              fingerprint: match.fingerprint,
            },
            files: stats.length,
            envelopes: totalFound,
            rewrapped: totalRewrapped,
          },
          opts,
        );
        return;
      }

      info(`Revoked recipient ${match.id} (${match.fingerprint}).`, opts);
      info(
        `Rewrapped ${totalRewrapped}/${totalFound} envelope(s) across ${stats.length} file(s).`,
        opts,
      );
    } catch (err) {
      amError(err, opts);
      process.exitCode = 1;
    }
  },
});
