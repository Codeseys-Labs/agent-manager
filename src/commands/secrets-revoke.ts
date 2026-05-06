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
import { resolveConfigDir } from "../core/config";
import { getDefaultBackend } from "../core/secrets";
import type { AgeSecretsBackend } from "../core/secrets-age";
import { amError, info, output } from "../lib/output";
import { bestEffortCommitSecretsChanges } from "./secrets-commit-helper";
import { discoverTomlFiles, resolveSingleFile, rewrapMany } from "./secrets-rewrap-helpers";

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

      // Live revoke: drop the .pub file, then rewrap.
      await ageBackend.removeRecipient(match.id);
      const stats = await rewrapMany(targets, ageBackend, { dryRun: false, noBackup });
      const totalRewrapped = stats.reduce((n, s) => n + s.rewrapped, 0);
      const totalFound = stats.reduce((n, s) => n + s.found, 0);

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
