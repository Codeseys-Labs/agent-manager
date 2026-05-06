/**
 * `am pair finalize <name>` — run on the ORIGINAL device to register a
 * new device's public key and rewrap all envelopes so the new device can
 * decrypt them (ADR-0047 §"Flow" Step 2).
 *
 * Reads recipients/<name>.pub (created by the new device via
 * `am pair accept` and pulled into this repo), validates the contained
 * age1... public key, registers it as a recipient if not already present,
 * and rewraps every enc:v2:age envelope so the new device's key is a
 * valid recipient.
 *
 * Flags:
 *   --dry-run      Report planned changes; do not modify any files.
 *   --json         Machine-readable output (DryRunEnvelope on dry-run).
 *   --identity-dir <path>  Override the identity directory (default ~/.config/agent-manager/identities).
 *   --no-rewrap    Register the recipient, skip the rewrap pass.
 *   --force        Re-rewrap even when the recipient is already registered.
 *   --quiet, --verbose     Output verbosity.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { defineCommand } from "citty";
import { resolveConfigDir, tryReadConfig } from "../core/config";
import { getDefaultBackend } from "../core/secrets";
import type { AgeSecretsBackend } from "../core/secrets-age";
import { amError, info, output, warn } from "../lib/output";
import { bestEffortCommitSecretsChanges } from "./secrets-commit-helper";
import { discoverTomlFiles, resolveSingleFile, rewrapMany } from "./secrets-rewrap-helpers";

/** Validate an age1... recipient string. Reuses the same prefix check as the backend. */
function validateAgeRecipient(r: string): void {
  if (typeof r !== "string" || !r.startsWith("age1")) {
    throw new Error(
      `Invalid age recipient — expected an "age1..." public key, got "${String(r).slice(0, 20)}".`,
    );
  }
}

/**
 * Read a recipient .pub file and extract the first age1... line.
 * Throws a descriptive error on missing file or malformed content.
 */
async function readPubFile(filePath: string): Promise<string> {
  let raw: string;
  try {
    raw = await readFile(filePath, "utf-8");
  } catch {
    throw new Error(
      `Recipient public-key file not found: ${filePath}. Has the new device run 'am pair accept <name>' and pushed its .pub file?`,
    );
  }

  let publicKey = "";
  for (const rawLine of raw.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0) continue;
    if (line.startsWith("#")) continue;
    if (line.startsWith("age1")) {
      publicKey = line;
      break;
    }
    // First non-comment, non-age1 line we encounter — treat as suspicious.
    if (!publicKey) {
      throw new Error(
        `Invalid recipient file at ${filePath}: expected an "age1..." line, found "${line.slice(0, 20)}".`,
      );
    }
  }

  if (!publicKey) {
    throw new Error(`No age1... public key found in ${filePath}.`);
  }

  validateAgeRecipient(publicKey);
  return publicKey;
}

export const pairFinalizeCommand = defineCommand({
  meta: {
    name: "finalize",
    description:
      "Register a new device's public key and rewrap envelopes so it can decrypt (ADR-0047).",
  },
  args: {
    name: {
      type: "positional",
      required: true,
      description: "Device name matching recipients/<name>.pub from pair accept.",
    },
    "dry-run": {
      type: "boolean",
      description: "Report planned changes; do not modify any files.",
      default: false,
    },
    json: { type: "boolean", description: "JSON output", default: false },
    "identity-dir": {
      type: "string",
      description: "Override the identity directory (default ~/.config/agent-manager/identities).",
    },
    "no-rewrap": {
      type: "boolean",
      description: "Register the recipient; skip the rewrap pass.",
      default: false,
    },
    file: {
      type: "string",
      description:
        "Restrict the rewrap pass to a single TOML file (default: discover config.toml + project config).",
    },
    force: {
      type: "boolean",
      description: "Re-rewrap even when the recipient is already registered.",
      default: false,
    },
    quiet: { type: "boolean", alias: "q", default: false },
    verbose: { type: "boolean", alias: "v", default: false },
  },
  async run({ args }) {
    const opts = { json: args.json, quiet: args.quiet, verbose: args.verbose };
    try {
      const name = args.name;
      const dryRun = args["dry-run"];
      const noRewrap = args["no-rewrap"];
      const force = args.force;

      if (!name || name.length === 0) {
        const msg = "am pair finalize: <name> argument is required.";
        if (args.json) output({ action: "pair-finalize", error: msg }, opts);
        else info(msg, opts);
        process.exitCode = 1;
        return;
      }

      // If --identity-dir was passed, override the env var so the backend
      // resolves from the custom directory.
      if (args["identity-dir"]) {
        process.env.AM_AGE_IDENTITY_DIR = args["identity-dir"];
      }

      const configDir = resolveConfigDir();
      const config = await tryReadConfig(join(configDir, "config.toml"));
      const backend = await getDefaultBackend(configDir, { config });

      if (backend.name !== "age") {
        const msg = `am pair finalize requires the \`age\` backend; current backend is \`${backend.name}\`.`;
        if (args.json) output({ action: "pair-finalize", error: msg }, opts);
        else info(msg, opts);
        process.exitCode = 1;
        return;
      }

      const ageBackend = backend as AgeSecretsBackend;
      const recipientsDir = ageBackend.getRecipientsDir();
      const pubFilePath = join(recipientsDir, `${name}.pub`);

      // 1. Read and validate the .pub file.
      const publicKey = await readPubFile(pubFilePath);

      // 2. Sanity-check that the .pub on disk has the expected ID. The
      //    "already registered" semantics from secrets-revoke do NOT
      //    apply here: `pair accept` on the NEW device is what writes
      //    recipients/<name>.pub, so by the time `pair finalize <name>`
      //    runs, the .pub IS already in the recipients dir — that's the
      //    happy path, not an error. The point of finalize is to rewrap
      //    existing envelopes against the now-active recipient set.
      const existing = await ageBackend.listRecipients();
      const matchedById = existing.find((r) => r.id === name);
      if (!matchedById) {
        // Listed recipients is derived from the same dir we just read
        // — if the file existed and parsed but isn't in the list,
        // something is structurally off.
        const msg = `recipients/${name}.pub parsed but is not in the active recipient set. The file may be corrupt or the listRecipients impl drifted.`;
        if (args.json) output({ action: "pair-finalize", error: msg }, opts);
        else info(msg, opts);
        process.exitCode = 1;
        return;
      }
      if (matchedById.publicKey !== publicKey) {
        const msg = `recipients/${name}.pub on disk (${publicKey.slice(0, 16)}…) does not match the registered recipient ${matchedById.publicKey.slice(0, 16)}… for id "${name}". This usually means the .pub was tampered with after pair accept ran. Refusing to finalize.`;
        if (args.json) output({ action: "pair-finalize", error: msg }, opts);
        else info(msg, opts);
        process.exitCode = 1;
        return;
      }

      // Discover target files for the rewrap pass.
      const targets = args.file
        ? [resolveSingleFile(args.file as string)]
        : await discoverTomlFiles(configDir, process.cwd());

      if (dryRun) {
        const stats = await rewrapMany(targets, ageBackend, { dryRun: true, noBackup: true });
        const totalFound = stats.reduce((n, s) => n + s.found, 0);

        if (args.json) {
          output(
            {
              action: "pair-finalize",
              reads_only: true,
              would_do: [
                `confirm recipient ${name} is registered from ${pubFilePath}`,
                ...(noRewrap ? [] : [`rewrap ${totalFound} envelope(s) to include ${name}`]),
              ],
              mutations_prevented: [
                "recipient registration",
                ...(noRewrap ? [] : ["TOML config rewrites"]),
              ],
              warnings: [],
              explanation: {
                name,
                publicKey,
                no_rewrap: noRewrap,
                files: stats,
                totals: { found: totalFound },
              },
            },
            opts,
          );
        } else {
          info(`Would rewrap ${totalFound} envelope(s) to include recipient "${name}".`, opts);
        }
        return;
      }

      // 3. Recipient is already on disk (written by `pair accept`); no
      //    addRecipient() call is required. The fingerprint validation
      //    above ensured it matches the listed recipient.

      // 4. Rewrap (unless --no-rewrap).
      let totalRewrapped = 0;
      let totalFound = 0;
      let stats: Awaited<ReturnType<typeof rewrapMany>> = [];

      if (!noRewrap) {
        stats = await rewrapMany(targets, ageBackend, { dryRun: false, noBackup: true });
        totalRewrapped = stats.reduce((n, s) => n + s.rewrapped, 0);
        totalFound = stats.reduce((n, s) => n + s.found, 0);
      }

      // 5. Commit the change.
      await bestEffortCommitSecretsChanges(
        configDir,
        [...targets, pubFilePath],
        `am: pair finalize ${name}${noRewrap ? " (no-rewrap)" : ""}`,
        opts,
      );

      if (args.json) {
        output(
          {
            action: "pair-finalize",
            name,
            publicKey,
            no_rewrap: noRewrap,
            files: stats.length,
            envelopes: totalFound,
            rewrapped: totalRewrapped,
          },
          opts,
        );
        return;
      }

      info(
        `Paired with ${name}. The new device can now decrypt envelopes encrypted from this point forward.`,
        opts,
      );
      if (!noRewrap && totalFound > 0) {
        info(
          `Rewrapped ${totalRewrapped}/${totalFound} envelope(s) across ${stats.length} file(s).`,
          opts,
        );
      } else if (noRewrap) {
        warn(
          `Recipient registered but NOT rewrapped. Run 'am secrets rewrap' or re-run without --no-rewrap to grant access to existing secrets.`,
          opts,
        );
      }
    } catch (err) {
      amError(err, opts);
      process.exitCode = 1;
    }
  },
});
