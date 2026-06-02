/**
 * `am pair accept <name>` — ADR-0047 sub-task T1.
 *
 * Run on the NEW device that is receiving access to the config repo.
 * Generates a local age identity if none exists yet, then exports the
 * corresponding `age1...` recipient to `recipients/<name>.pub` so the
 * ORIGINAL device can pick it up (via `am pair finalize`) and rewrap
 * every existing ciphertext to include the new machine.
 *
 * Scope boundaries (per Wave T plan T1):
 *   - This verb only touches the local identity, the `.pub` file, and
 *     the `[age].recipients` array in `.am-secrets.toml` (DWL-T4 #1
 *     deferred-item closeout). The TOML edit is idempotent — re-running
 *     `accept --force` does not duplicate the entry.
 *   - It does NOT commit or push. Commit/push happen on the ORIGINAL
 *     device during `am pair finalize`.
 *   - No git operations — ADR-0047 §"Flow" has the original device do
 *     the rewrap+push, not this one.
 *
 * Flags:
 *   --dry-run           Describe the plan without writing anything.
 *   --json              Emit structured output (ADR-0038 envelope for
 *                       dry-run; success payload for live runs).
 *   --identity-dir <p>  Override the default identity directory.
 *                       Wired through `AM_AGE_IDENTITY_DIR` so the
 *                       backend resolver picks it up.
 *   --force             Overwrite an existing `recipients/<name>.pub`.
 *   --quiet / --verbose Standard output-level toggles.
 */

import { createHash } from "node:crypto";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { defineCommand } from "citty";
import { atomicWriteFile } from "../core/atomic-write";
import { resolveConfigDir } from "../core/config";
import { getDefaultBackend } from "../core/secrets";
import { type AgeSecretsBackend, resolveIdentityPath } from "../core/secrets-age";
import { appendAgeRecipientPath, resolveSecretsTomlPath } from "../core/secrets-toml";
import { AmError } from "../lib/errors";
import { amError, info, output } from "../lib/output";
import { validatePairName } from "./pair-name-validator";

/** Accept only filesystem-safe recipient names (no slashes, no ".."). */
const VALID_NAME_RE = /^[A-Za-z0-9._-]+$/;

async function pathExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

// validateName moved to ./pair-name-validator (Run-K Phase-8 review:
// shared by pair-accept + pair-finalize). The local re-export
// preserves the original call-site shape used elsewhere in this file.
function validateName(raw: unknown): string {
  return validatePairName(raw, "accept");
}

function renderPubFile(name: string, recipient: string, createdAt: string): string {
  return `# id: ${name}\n# added: ${createdAt}\n${recipient}\n`;
}

function shortFingerprint(recipient: string): string {
  return createHash("sha256").update(recipient).digest("hex").slice(0, 10);
}

export const pairAcceptCommand = defineCommand({
  meta: {
    name: "accept",
    description:
      "Generate a local age identity (if absent) and publish recipients/<name>.pub for the original device to consume (ADR-0047).",
  },
  args: {
    name: {
      type: "positional",
      required: true,
      description: "Device label used as the recipient filename (recipients/<name>.pub).",
    },
    "dry-run": {
      type: "boolean",
      description: "Report planned changes without writing any files.",
      default: false,
    },
    "identity-dir": {
      type: "string",
      description: "Override the default identity directory (AM_AGE_IDENTITY_DIR).",
    },
    force: {
      type: "boolean",
      description: "Overwrite an existing recipients/<name>.pub instead of failing.",
      default: false,
    },
    json: { type: "boolean", description: "JSON output", default: false },
    quiet: { type: "boolean", alias: "q", default: false },
    verbose: { type: "boolean", alias: "v", default: false },
  },
  async run({ args }) {
    const opts = { json: args.json, quiet: args.quiet, verbose: args.verbose };
    const prevIdentityDir = process.env.AM_AGE_IDENTITY_DIR;
    try {
      const name = validateName(args.name);
      const dryRun = !!args["dry-run"];
      const force = !!args.force;
      const identityDirOverride =
        typeof args["identity-dir"] === "string" && args["identity-dir"].length > 0
          ? args["identity-dir"]
          : undefined;

      if (identityDirOverride) {
        process.env.AM_AGE_IDENTITY_DIR = identityDirOverride;
      }

      const configDir = resolveConfigDir();
      const backend = await getDefaultBackend(configDir);
      if (backend.name !== "age") {
        throw new AmError(
          `am pair accept requires the \`age\` backend; current backend is \`${backend.name}\`.`,
          'Set settings.secrets.backend = "age" in config.toml and retry.',
          "PAIR_ACCEPT_WRONG_BACKEND",
        );
      }
      const ageBackend = backend as AgeSecretsBackend;
      const recipientsDir = ageBackend.getRecipientsDir();
      const identityPath = ageBackend.getIdentityPath?.() ?? resolveIdentityPath();
      const pubPath = join(recipientsDir, `${name}.pub`);

      const pubExisted = await pathExists(pubPath);
      if (pubExisted && !force) {
        throw new AmError(
          `recipients/${name}.pub already exists; use --force to overwrite.`,
          "Pick a different device label or re-run with --force if you intend to rotate the key.",
          "PAIR_ACCEPT_DUPLICATE_NAME",
        );
      }

      const identityExistedBefore = await pathExists(identityPath);

      const secretsTomlPath = resolveSecretsTomlPath(configDir);
      const recipientRelPath = `recipients/${name}.pub`;

      if (dryRun) {
        // Compute the projected ops without touching disk. Do NOT
        // invoke backend.initialize() — that would create identity.age.
        const wouldCreateIdentity = !identityExistedBefore;
        const wouldDo: string[] = [];
        const prevented: string[] = [];
        if (wouldCreateIdentity) {
          wouldDo.push(`generate new age identity at ${identityPath}`);
          prevented.push("identity file write");
        } else {
          wouldDo.push(`reuse existing age identity at ${identityPath}`);
        }
        wouldDo.push(
          pubExisted
            ? `overwrite recipients/${name}.pub at ${pubPath}`
            : `write recipients/${name}.pub at ${pubPath}`,
        );
        prevented.push("recipients/*.pub write");
        wouldDo.push(`append "${recipientRelPath}" to ${secretsTomlPath} [age].recipients`);
        prevented.push(".am-secrets.toml [age].recipients append");

        if (args.json) {
          output(
            {
              action: "pair-accept",
              reads_only: true,
              would_do: wouldDo,
              mutations_prevented: prevented,
              warnings: [],
              explanation: {
                name,
                pubPath,
                identityPath,
                secretsTomlPath,
                recipientRelPath,
                identityExisted: identityExistedBefore,
                pubExisted,
                force,
              },
            },
            opts,
          );
        } else {
          info(`Would write ${pubPath}`, opts);
          if (wouldCreateIdentity) info(`Would create ${identityPath}`, opts);
          info(`Would update ${secretsTomlPath} [age].recipients`, opts);
        }
        return;
      }

      // Live path: force identity creation / unlock, derive recipient,
      // write the .pub file atomically.
      await ageBackend.initialize();
      const recipient = await ageBackend.getRecipient();
      const createdAt = new Date().toISOString();
      const body = renderPubFile(name, recipient, createdAt);
      // mkdir is handled atomically by atomicWriteFile via its parent
      // directory creation; mirror addRecipient's behaviour so the two
      // code paths stay consistent.
      const { mkdir } = await import("node:fs/promises");
      await mkdir(recipientsDir, { recursive: true });
      await atomicWriteFile(pubPath, body, { mode: 0o644 });

      // ADR-0047 §"Flow" Step 2 — `[age].recipients` is the source-of-
      // truth covered set. Append idempotently so `accept --force`
      // doesn't duplicate the entry.
      const tomlResult = await appendAgeRecipientPath(configDir, recipientRelPath);

      const fingerprint = shortFingerprint(recipient);

      if (args.json) {
        output(
          {
            action: "pair-accept",
            name,
            pubPath,
            identityPath,
            recipient,
            fingerprint,
            identityCreated: !identityExistedBefore,
            overwritten: pubExisted,
            secretsTomlPath: tomlResult.path,
            secretsTomlChanged: tomlResult.changed,
            recipientRelPath,
          },
          opts,
        );
        return;
      }

      info(`Wrote ${pubPath}`, opts);
      info(`Recipient: ${recipient}`, opts);
      if (tomlResult.changed) {
        info(`Updated ${tomlResult.path} [age].recipients`, opts);
      }
      info(`Now run on the original device: am pair finalize ${name}`, opts);
    } catch (err) {
      amError(err, opts);
      process.exitCode = 1;
    } finally {
      // xplat: `process.env.X = undefined` coerces to the literal string
      // "undefined" on Windows (POSIX bun deletes the key), which would poison
      // subsequent in-process age operations. Reflect.deleteProperty truly
      // unsets on every platform.
      if (prevIdentityDir === undefined) Reflect.deleteProperty(process.env, "AM_AGE_IDENTITY_DIR");
      else process.env.AM_AGE_IDENTITY_DIR = prevIdentityDir;
    }
  },
});
