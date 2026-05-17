/**
 * `am pair finalize [name]` — run on the ORIGINAL device to register a
 * new device's public key and rewrap all envelopes so the new device can
 * decrypt them (ADR-0047 §"Flow" Step 2).
 *
 * Two forms:
 *
 *   - `am pair finalize <name>` — explicit single-device finalize. Reads
 *     `recipients/<name>.pub`, validates the contained age1... public
 *     key, runs the rewrap pass, syncs `.am-secrets.toml`'s
 *     `[age].recipients` array, and commits.
 *
 *   - `am pair finalize` (no positional) — autodetect mode. Optionally
 *     pulls the config repo (gated by `--no-pull`), then scans
 *     `recipients/*.pub` for files NOT yet listed in `.am-secrets.toml`
 *     `[age].recipients`. Each new recipient is finalized (rewrap +
 *     TOML sync) in stable order. Exits 0 with "no new recipients" when
 *     nothing is missing.
 *
 * Flags:
 *   --dry-run      Report planned changes; do not modify any files.
 *   --json         Machine-readable output (DryRunEnvelope on dry-run).
 *   --identity-dir <path>  Override the identity directory (default ~/.config/agent-manager/identities).
 *   --no-rewrap    Register the recipient, skip the rewrap pass.
 *   --force        Re-rewrap even when the recipient is already registered.
 *   --no-pull      Autodetect mode only — skip the best-effort `git pull`.
 *   --quiet, --verbose     Output verbosity.
 */

import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { defineCommand } from "citty";
import { resolveConfigDir, tryReadConfig } from "../core/config";
import { bestEffortPull } from "../core/git";
import { getDefaultBackend } from "../core/secrets";
import type { AgeSecretsBackend } from "../core/secrets-age";
import {
  appendAgeRecipientPaths,
  getAgeRecipients,
  readSecretsToml,
  resolveSecretsTomlPath,
} from "../core/secrets-toml";
import { amError, info, output, warn } from "../lib/output";
import { validatePairName } from "./pair-name-validator";
import { bestEffortCommitSecretsChanges } from "./secrets-commit-helper";
import { discoverTomlFiles, resolveSingleFile, rewrapMany } from "./secrets-rewrap-helpers";

const RECIPIENT_FILE_SUFFIX = ".pub";

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

/**
 * List recipient `.pub` filenames (without suffix) under `recipientsDir`,
 * filtering out the rotation sidecar. Sorted lexicographically for
 * stable iteration. Returns `[]` when the directory does not exist.
 */
async function listPubStems(recipientsDir: string): Promise<string[]> {
  let entries: string[];
  try {
    entries = await readdir(recipientsDir);
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const name of entries) {
    if (!name.endsWith(RECIPIENT_FILE_SUFFIX)) continue;
    const stem = name.slice(0, -RECIPIENT_FILE_SUFFIX.length);
    // Skip the ADR-0051 rotation sidecar — it's per-machine state, not
    // a paired device and must not appear in `[age].recipients`.
    if (stem.startsWith("_")) continue;
    out.push(stem);
  }
  out.sort();
  return out;
}

/**
 * Compute the set of `recipients/<name>.pub` paths that exist on disk
 * but are NOT yet present in `[age].recipients` (the covered set).
 * Returned in stable lexicographic order.
 */
async function findUncoveredPubStems(
  configDir: string,
  recipientsDir: string,
): Promise<{ stems: string[]; covered: Set<string>; secretsTomlPath: string }> {
  const doc = await readSecretsToml(configDir);
  const coveredArr = getAgeRecipients(doc);
  const covered = new Set<string>(coveredArr);
  const stems = await listPubStems(recipientsDir);
  const uncovered = stems.filter(
    (stem) => !covered.has(`recipients/${stem}${RECIPIENT_FILE_SUFFIX}`),
  );
  return {
    stems: uncovered,
    covered,
    secretsTomlPath: resolveSecretsTomlPath(configDir),
  };
}

/** Validate every stem; on the first invalid one, return a descriptive error. */
function validateStems(stems: string[]): { valid: string[]; warnings: string[] } {
  const valid: string[] = [];
  const warnings: string[] = [];
  for (const stem of stems) {
    try {
      valid.push(validatePairName(stem, "finalize"));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      warnings.push(`Skipping invalid recipient filename "${stem}.pub": ${msg}`);
    }
  }
  return { valid, warnings };
}

export const pairFinalizeCommand = defineCommand({
  meta: {
    name: "finalize",
    description:
      "Register a new device's public key and rewrap envelopes so it can decrypt (ADR-0047). With no <name>, auto-detects new recipients/*.pub files.",
  },
  args: {
    name: {
      type: "positional",
      required: false,
      description:
        "Device name matching recipients/<name>.pub from pair accept. Omit to auto-detect every uncovered recipient.",
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
    "no-pull": {
      type: "boolean",
      description:
        "Autodetect mode only: skip the best-effort `git pull` before scanning recipients.",
      default: false,
    },
    quiet: { type: "boolean", alias: "q", default: false },
    verbose: { type: "boolean", alias: "v", default: false },
  },
  async run({ args }) {
    const opts = { json: args.json, quiet: args.quiet, verbose: args.verbose };
    try {
      const dryRun = !!args["dry-run"];
      const noRewrap = !!args["no-rewrap"];

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

      // Branch on positional <name> presence: explicit single-device
      // finalize vs. autodetect mode. The explicit form preserves the
      // legacy semantics; autodetect mode is the DWL-T4 closeout.
      if (typeof args.name === "string" && args.name.length > 0) {
        await runExplicitFinalize({
          name: args.name,
          dryRun,
          noRewrap,
          fileArg: typeof args.file === "string" ? args.file : undefined,
          json: !!args.json,
          opts,
          configDir,
          ageBackend,
          recipientsDir,
        });
        return;
      }

      await runAutodetectFinalize({
        dryRun,
        noRewrap,
        noPull: !!args["no-pull"],
        fileArg: typeof args.file === "string" ? args.file : undefined,
        json: !!args.json,
        opts,
        configDir,
        ageBackend,
        recipientsDir,
      });
    } catch (err) {
      amError(err, opts);
      process.exitCode = 1;
    }
  },
});

interface ExplicitFinalizeArgs {
  name: string;
  dryRun: boolean;
  noRewrap: boolean;
  fileArg: string | undefined;
  json: boolean;
  opts: { json?: boolean; quiet?: boolean; verbose?: boolean };
  configDir: string;
  ageBackend: AgeSecretsBackend;
  recipientsDir: string;
}

async function runExplicitFinalize(a: ExplicitFinalizeArgs): Promise<void> {
  const { dryRun, noRewrap, fileArg, json, opts, configDir, ageBackend, recipientsDir } = a;
  let name: string;
  try {
    name = validatePairName(a.name, "finalize");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (json) output({ action: "pair-finalize", error: msg }, opts);
    else info(msg, opts);
    process.exitCode = 1;
    return;
  }

  const pubFilePath = join(recipientsDir, `${name}${RECIPIENT_FILE_SUFFIX}`);

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
    const msg = `recipients/${name}.pub parsed but is not in the active recipient set. The file may be corrupt or the listRecipients impl drifted.`;
    if (json) output({ action: "pair-finalize", error: msg }, opts);
    else info(msg, opts);
    process.exitCode = 1;
    return;
  }
  if (matchedById.publicKey !== publicKey) {
    const msg = `recipients/${name}.pub on disk (${publicKey.slice(0, 16)}…) does not match the registered recipient ${matchedById.publicKey.slice(0, 16)}… for id "${name}". This usually means the .pub was tampered with after pair accept ran. Refusing to finalize.`;
    if (json) output({ action: "pair-finalize", error: msg }, opts);
    else info(msg, opts);
    process.exitCode = 1;
    return;
  }

  // Discover target files for the rewrap pass.
  const targets = fileArg
    ? [resolveSingleFile(fileArg)]
    : await discoverTomlFiles(configDir, process.cwd());

  const recipientRelPath = `recipients/${name}${RECIPIENT_FILE_SUFFIX}`;
  const secretsTomlPath = resolveSecretsTomlPath(configDir);

  if (dryRun) {
    const stats = await rewrapMany(targets, ageBackend, { dryRun: true, noBackup: true });
    const totalFound = stats.reduce((n, s) => n + s.found, 0);

    if (json) {
      output(
        {
          action: "pair-finalize",
          reads_only: true,
          would_do: [
            `confirm recipient ${name} is registered from ${pubFilePath}`,
            ...(noRewrap ? [] : [`rewrap ${totalFound} envelope(s) to include ${name}`]),
            `append "${recipientRelPath}" to ${secretsTomlPath} [age].recipients (if not already present)`,
          ],
          mutations_prevented: [
            "recipient registration",
            ...(noRewrap ? [] : ["TOML config rewrites"]),
            ".am-secrets.toml [age].recipients append",
          ],
          warnings: [],
          explanation: {
            name,
            publicKey,
            no_rewrap: noRewrap,
            files: stats,
            totals: { found: totalFound },
            secretsTomlPath,
            recipientRelPath,
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

  // 5. Sync `.am-secrets.toml`'s `[age].recipients` covered-set so
  //    subsequent autodetect runs do NOT re-finalize this device.
  const tomlResult = await appendAgeRecipientPaths(configDir, [recipientRelPath]);

  // 6. Commit the change.
  const commitPaths = [...targets, pubFilePath];
  if (tomlResult.changed) commitPaths.push(tomlResult.path);
  await bestEffortCommitSecretsChanges(
    configDir,
    commitPaths,
    `am: pair finalize ${name}${noRewrap ? " (no-rewrap)" : ""}`,
    opts,
  );

  if (json) {
    output(
      {
        action: "pair-finalize",
        name,
        publicKey,
        no_rewrap: noRewrap,
        files: stats.length,
        envelopes: totalFound,
        rewrapped: totalRewrapped,
        secretsTomlPath: tomlResult.path,
        secretsTomlChanged: tomlResult.changed,
        recipientRelPath,
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
  if (tomlResult.changed) {
    info(`Updated ${tomlResult.path} [age].recipients`, opts);
  }
}

interface AutodetectArgs {
  dryRun: boolean;
  noRewrap: boolean;
  noPull: boolean;
  fileArg: string | undefined;
  json: boolean;
  opts: { json?: boolean; quiet?: boolean; verbose?: boolean };
  configDir: string;
  ageBackend: AgeSecretsBackend;
  recipientsDir: string;
}

async function runAutodetectFinalize(a: AutodetectArgs): Promise<void> {
  const { dryRun, noRewrap, noPull, fileArg, json, opts, configDir, ageBackend, recipientsDir } = a;
  const warnings: string[] = [];

  // 1. Best-effort pull (skipped on --no-pull, no remote, no repo).
  if (!noPull) {
    const pullResult = await bestEffortPull(configDir);
    if (pullResult.kind === "failed") {
      const msg = `git pull failed: ${pullResult.message}. Continuing with local recipients/*.pub state.`;
      warnings.push(msg);
      warn(msg, opts);
    }
    // no-repo / no-remote / ok — silent.
  }

  // 2. Compute the uncovered set.
  const { stems: uncoveredRaw, secretsTomlPath } = await findUncoveredPubStems(
    configDir,
    recipientsDir,
  );
  const { valid: uncovered, warnings: nameWarnings } = validateStems(uncoveredRaw);
  for (const w of nameWarnings) {
    warnings.push(w);
    warn(w, opts);
  }

  // 3. No-op short-circuit.
  if (uncovered.length === 0) {
    if (json) {
      output(
        {
          action: "pair-finalize",
          mode: "autodetect",
          new_recipients: [],
          reads_only: dryRun,
          message: "no new recipients",
          warnings,
          ...(dryRun
            ? {
                would_do: ["scan recipients/*.pub — nothing to finalize"],
                mutations_prevented: [],
                explanation: { uncovered: [], secretsTomlPath },
              }
            : {}),
        },
        opts,
      );
    } else {
      info("No new recipients to finalize.", opts);
    }
    return;
  }

  const recipientRelPaths = uncovered.map((s) => `recipients/${s}${RECIPIENT_FILE_SUFFIX}`);

  // 4. Resolve target TOML files for the rewrap pass — once for the
  //    whole batch (rewrapping is recipient-set-driven, not per-name).
  const targets = fileArg
    ? [resolveSingleFile(fileArg)]
    : await discoverTomlFiles(configDir, process.cwd());

  if (dryRun) {
    const stats = await rewrapMany(targets, ageBackend, { dryRun: true, noBackup: true });
    const totalFound = stats.reduce((n, s) => n + s.found, 0);

    const wouldDo = [
      "pull config repo (best-effort, skipped if --no-pull or no remote)",
      `scan ${recipientsDir} for uncovered .pub files`,
      `confirm ${uncovered.length} new recipient(s): ${uncovered.join(", ")}`,
      ...(noRewrap ? [] : [`rewrap ${totalFound} envelope(s) across discovered TOML files`]),
      `append ${recipientRelPaths.length} entry/entries to ${secretsTomlPath} [age].recipients`,
    ];

    if (json) {
      output(
        {
          action: "pair-finalize",
          mode: "autodetect",
          reads_only: true,
          would_do: wouldDo,
          mutations_prevented: [
            ...(noRewrap ? [] : ["TOML config rewrites"]),
            ".am-secrets.toml [age].recipients append",
            "git commit",
          ],
          warnings,
          explanation: {
            new_recipients: uncovered,
            recipient_paths: recipientRelPaths,
            secretsTomlPath,
            files: stats,
            totals: { found: totalFound },
            no_rewrap: noRewrap,
          },
        },
        opts,
      );
    } else {
      info(`Would finalize ${uncovered.length} new recipient(s): ${uncovered.join(", ")}`, opts);
      info(`Would rewrap ${totalFound} envelope(s).`, opts);
    }
    return;
  }

  // 5. Per-recipient validation (ensure each .pub parses + matches
  //    the registered recipient before we commit). Bail out on the
  //    first failure so we don't half-finalize.
  const validatedPubPaths: string[] = [];
  const existing = await ageBackend.listRecipients();
  const existingById = new Map(existing.map((r) => [r.id, r]));
  for (const name of uncovered) {
    const pubFilePath = join(recipientsDir, `${name}${RECIPIENT_FILE_SUFFIX}`);
    const publicKey = await readPubFile(pubFilePath);
    const matched = existingById.get(name);
    if (!matched) {
      const msg = `recipients/${name}.pub exists but is not in the active recipient set. Aborting autodetect to avoid half-finalize.`;
      if (json) output({ action: "pair-finalize", error: msg, warnings }, opts);
      else info(msg, opts);
      process.exitCode = 1;
      return;
    }
    if (matched.publicKey !== publicKey) {
      const msg = `recipients/${name}.pub on disk does not match the registered recipient. Refusing to finalize ${name}.`;
      if (json) output({ action: "pair-finalize", error: msg, warnings }, opts);
      else info(msg, opts);
      process.exitCode = 1;
      return;
    }
    validatedPubPaths.push(pubFilePath);
  }

  // 6. Rewrap once — the rewrap walk targets the union of all
  //    recipients (own + every recipients/*.pub), so a single pass
  //    covers all newly-uncovered devices.
  let totalRewrapped = 0;
  let totalFound = 0;
  let stats: Awaited<ReturnType<typeof rewrapMany>> = [];
  if (!noRewrap) {
    stats = await rewrapMany(targets, ageBackend, { dryRun: false, noBackup: true });
    totalRewrapped = stats.reduce((n, s) => n + s.rewrapped, 0);
    totalFound = stats.reduce((n, s) => n + s.found, 0);
  }

  // 7. Bulk-append to `.am-secrets.toml`.
  const tomlResult = await appendAgeRecipientPaths(configDir, recipientRelPaths);

  // 8. Single combined commit.
  const commitPaths = [...targets, ...validatedPubPaths];
  if (tomlResult.changed) commitPaths.push(tomlResult.path);
  const commitSummary = uncovered.join(", ");
  await bestEffortCommitSecretsChanges(
    configDir,
    commitPaths,
    `am: pair finalize (autodetect: ${commitSummary})${noRewrap ? " (no-rewrap)" : ""}`,
    opts,
  );

  if (json) {
    output(
      {
        action: "pair-finalize",
        mode: "autodetect",
        new_recipients: uncovered,
        recipient_paths: recipientRelPaths,
        no_rewrap: noRewrap,
        files: stats.length,
        envelopes: totalFound,
        rewrapped: totalRewrapped,
        secretsTomlPath: tomlResult.path,
        secretsTomlChanged: tomlResult.changed,
        warnings,
      },
      opts,
    );
    return;
  }

  info(`Finalized ${uncovered.length} new recipient(s): ${uncovered.join(", ")}.`, opts);
  if (!noRewrap && totalFound > 0) {
    info(
      `Rewrapped ${totalRewrapped}/${totalFound} envelope(s) across ${stats.length} file(s).`,
      opts,
    );
  } else if (noRewrap) {
    warn(
      `Recipients registered but NOT rewrapped. Run 'am secrets rewrap' or re-run without --no-rewrap to grant access to existing secrets.`,
      opts,
    );
  }
  if (tomlResult.changed) {
    info(`Updated ${tomlResult.path} [age].recipients`, opts);
  }
}
