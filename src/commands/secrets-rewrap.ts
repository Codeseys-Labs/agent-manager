/**
 * `am secrets rewrap` — re-encrypt every `enc:v2:age:...` envelope in
 * the local TOML config files to the CURRENT recipient set
 * (ADR-0051 §"`am secrets rewrap`"). Identical to the pre-ADR-0051
 * `am secrets rotate` behaviour: walk the configs, call
 * `AgeSecretsBackend.rewrap()` on each envelope, atomically write the
 * file back. Use this verb after editing the recipient list (adding
 * or removing `.pub` files), or any time you want to bring envelopes
 * in sync with `recipients/`.
 *
 * Does NOT touch the local identity. To rotate the identity itself
 * use `am secrets rotate`. To remove a peer recipient and rewrap in
 * one step use `am secrets revoke <fingerprint>`.
 *
 * ADR-0042 / ADR-0051 verb taxonomy:
 *   rewrap → sync envelopes to recipients (no identity change)
 *   rotate → replace local identity (with grace period)
 *   rotate --finalize → drop the old identity at end of grace
 *   revoke <fp> → drop a specific recipient and rewrap
 */

import { defineCommand } from "citty";
import { resolveConfigDir } from "../core/config";
import { getDefaultBackend } from "../core/secrets";
import type { AgeSecretsBackend } from "../core/secrets-age";
import { amError, info, output } from "../lib/output";
import { bestEffortCommitSecretsChanges } from "./secrets-commit-helper";
import { discoverTomlFiles, resolveSingleFile, rewrapMany } from "./secrets-rewrap-helpers";

export const secretsRewrapCommand = defineCommand({
  meta: {
    name: "rewrap",
    description: "Rewrap age envelopes in TOML configs for the current recipient set.",
  },
  args: {
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

      const configDir = resolveConfigDir();
      const backend = await getDefaultBackend(configDir);

      if (backend.name !== "age") {
        const msg = `am secrets rewrap requires the \`age\` backend; current backend is \`${backend.name}\`.`;
        if (args.json) {
          output({ action: "rewrap", error: msg, backend: backend.name }, opts);
        } else {
          info(msg, opts);
        }
        process.exitCode = 1;
        return;
      }

      const ageBackend = backend as AgeSecretsBackend;
      if (typeof ageBackend.rewrap !== "function") {
        throw new Error(
          "Active age backend does not expose rewrap() — upgrade core/secrets-age.ts.",
        );
      }

      const targets = args.file
        ? [resolveSingleFile(args.file)]
        : await discoverTomlFiles(configDir, process.cwd());

      const stats = await rewrapMany(targets, ageBackend, { dryRun, noBackup });

      const totalFound = stats.reduce((n, s) => n + s.found, 0);
      const totalRewrapped = stats.reduce((n, s) => n + s.rewrapped, 0);

      if (!dryRun) {
        await bestEffortCommitSecretsChanges(
          configDir,
          targets,
          `secrets(rewrap): re-encrypt ${stats.filter((s) => s.rewrapped > 0).length} file(s) to current recipients`,
          opts,
        );
      }

      if (args.json) {
        if (dryRun) {
          // ADR-0038 DryRunEnvelope shape.
          output(
            {
              action: "rewrap",
              reads_only: true,
              would_do: stats
                .filter((s) => s.found > 0)
                .map((s) => `would rewrap ${s.rewrapped}/${s.found} envelope(s) in ${s.file}`),
              mutations_prevented: ["TOML config writes", "envelope re-encryption"],
              warnings: [],
              explanation: {
                backend: backend.name,
                files: stats,
                totals: { found: totalFound, rewrapped: totalRewrapped },
              },
            },
            opts,
          );
        } else {
          output(
            {
              action: "rewrap",
              dryRun,
              backend: backend.name,
              files: stats,
              totals: { found: totalFound, rewrapped: totalRewrapped },
            },
            opts,
          );
        }
        return;
      }

      if (stats.length === 0) {
        info("No TOML config files found to scan.", opts);
        return;
      }

      for (const s of stats) {
        if (s.found === 0) continue;
        const action = dryRun ? "would rewrap" : "rewrapped";
        info(`${s.file}: ${action} ${s.rewrapped}/${s.found} envelope(s).`, opts);
        if (s.backupPath) info(`  backup: ${s.backupPath}`, opts);
      }
      info("", opts);
      info(
        `Total: ${totalRewrapped}/${totalFound} envelope(s) ${dryRun ? "would be " : ""}rewrapped.`,
        opts,
      );
    } catch (err) {
      amError(err, opts);
      process.exitCode = 1;
    }
  },
});
