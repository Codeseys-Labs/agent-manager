/**
 * `am secrets rotate` — generate a NEW per-machine age identity and
 * dual-encrypt every envelope to BOTH the old and new recipient
 * (ADR-0051 §"`am secrets rotate`"). The grace window starts now;
 * follow up with `am secrets rotate --finalize` after the configured
 * `settings.secrets.rotation.grace_period_days` (default 14) to drop
 * the old identity.
 *
 * Distinct from `am secrets rewrap` (no-identity-change re-encryption)
 * and `am secrets revoke <fp>` (drop a peer recipient). See ADR-0051
 * §"Four-verb CLI surface" for the full taxonomy.
 *
 * Flags:
 *   --finalize  Drop the old identity (must come AFTER `rotate`).
 *               Refuses to run before grace expiry unless `--force`
 *               is passed.
 *   --force     Override the grace-window check on `--finalize`.
 *   --dry-run   Report planned changes; do not modify any files.
 *   --json      Machine-readable output (DryRunEnvelope on dry-run).
 *
 * Passphrase input: ADR-0051 prompts for a NEW passphrase at rotate
 * time. In CLI/CI mode this command reads `AM_AGE_NEW_PASSPHRASE` for
 * the new one (falling back to `AM_AGE_PASSPHRASE` on unlock).
 */

import { join } from "node:path";
import { defineCommand } from "citty";
import { resolveConfigDir, tryReadConfig } from "../core/config";
import { getDefaultBackend } from "../core/secrets";
import type { AgeSecretsBackend, RotationState } from "../core/secrets-age";
import { amError, info, output } from "../lib/output";
import { bestEffortCommitSecretsChanges } from "./secrets-commit-helper";
import {
  discoverTomlFiles,
  readGracePeriodDays,
  resolveSingleFile,
  rewrapMany,
} from "./secrets-rewrap-helpers";

/**
 * Combined passphrase provider: returns AM_AGE_NEW_PASSPHRASE for
 * "create" calls (new identity) and AM_AGE_PASSPHRASE for "unlock"
 * calls (old identity), so a single rotate invocation can carry two
 * distinct passphrases via env vars in CI mode. Tests inject custom
 * providers directly via the backend.
 */
function rotatePassphraseProvider(): (kind: "create" | "unlock") => Promise<string> {
  return async (kind) => {
    if (kind === "create") {
      const v = process.env.AM_AGE_NEW_PASSPHRASE;
      if (!v || v.length === 0) {
        // Fall back to the regular passphrase if no NEW one was set —
        // operator wants to keep the same passphrase across rotation.
        const fallback = process.env.AM_AGE_PASSPHRASE;
        if (!fallback || fallback.length === 0) {
          throw new Error(
            "am secrets rotate: AM_AGE_NEW_PASSPHRASE is unset — provide a new passphrase for the rotated identity (or set AM_AGE_PASSPHRASE to keep the same one).",
          );
        }
        return fallback;
      }
      return v;
    }
    const v = process.env.AM_AGE_PASSPHRASE;
    if (!v || v.length === 0) {
      throw new Error("am secrets rotate: AM_AGE_PASSPHRASE is unset for identity unlock.");
    }
    return v;
  };
}

export const secretsRotateCommand = defineCommand({
  meta: {
    name: "rotate",
    description:
      "Rotate the local age identity (ADR-0051): generate a new key, dual-encrypt during the grace window, then `--finalize` to drop the old.",
  },
  args: {
    finalize: {
      type: "boolean",
      description: "Drop the old identity after grace expiry. Use with --force to override.",
      default: false,
    },
    force: {
      type: "boolean",
      description: "With --finalize, override the grace-window check.",
      default: false,
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
      const finalize = args.finalize;
      const force = args.force;
      const dryRun = args["dry-run"];
      const noBackup = args["no-backup"];

      const configDir = resolveConfigDir();
      const config = await tryReadConfig(join(configDir, "config.toml"));
      const gracePeriodDays = readGracePeriodDays(config);

      const backend = await getDefaultBackend(configDir, {
        passphraseProvider: rotatePassphraseProvider(),
      });

      if (backend.name !== "age") {
        const msg = `am secrets rotate requires the \`age\` backend; current backend is \`${backend.name}\`.`;
        if (args.json) output({ action: "rotate", error: msg }, opts);
        else info(msg, opts);
        process.exitCode = 1;
        return;
      }

      const ageBackend = backend as AgeSecretsBackend;

      if (finalize) {
        await runFinalize(ageBackend, {
          dryRun,
          force,
          noBackup,
          configDir,
          file: args.file,
          opts,
          json: args.json,
        });
        return;
      }

      await runRotate(ageBackend, {
        dryRun,
        noBackup,
        configDir,
        file: args.file,
        gracePeriodDays,
        opts,
        json: args.json,
      });
    } catch (err) {
      amError(err, opts);
      process.exitCode = 1;
    }
  },
});

interface CommonRunOpts {
  dryRun: boolean;
  noBackup: boolean;
  configDir: string;
  file: string | undefined;
  opts: { json: boolean; quiet: boolean; verbose: boolean };
  json: boolean;
}

async function runRotate(
  backend: AgeSecretsBackend,
  ctx: CommonRunOpts & { gracePeriodDays: number },
): Promise<void> {
  // Already-in-progress rotation: refuse to start a second one.
  const existing = await backend.readRotationState();
  if (existing) {
    const msg = `Rotation already in progress (started ${existing.started_at}, grace until ${existing.grace_until}). Run \`am secrets rotate --finalize\` first.`;
    if (ctx.json) output({ action: "rotate", error: msg, state: existing }, ctx.opts);
    else info(msg, ctx.opts);
    process.exitCode = 1;
    return;
  }

  // Pre-rotate envelope discovery for accurate dry-run + final report.
  const targets = ctx.file
    ? [resolveSingleFile(ctx.file)]
    : await discoverTomlFiles(ctx.configDir, process.cwd());

  if (ctx.dryRun) {
    // Count envelopes without doing anything.
    const stats = await rewrapMany(targets, backend, { dryRun: true, noBackup: ctx.noBackup });
    const totalFound = stats.reduce((n, s) => n + s.found, 0);
    const oldRecipient = await backend.getRecipient();
    if (ctx.json) {
      output(
        {
          action: "rotate",
          reads_only: true,
          would_do: [
            "generate a new age identity",
            "archive the current identity to identities/identity.age.old",
            ctx.gracePeriodDays > 0
              ? `register OLD recipient as sidecar for ${ctx.gracePeriodDays}-day grace window`
              : "skip dual-encryption (immediate cutover, grace_period_days=0)",
            `dual-encrypt ${totalFound} envelope(s) across ${stats.length} file(s)`,
          ],
          mutations_prevented: [
            "identity file write",
            "recipient sidecar write",
            "TOML config rewrites",
          ],
          warnings: [],
          explanation: {
            old_recipient: oldRecipient,
            grace_period_days: ctx.gracePeriodDays,
            files: stats,
            totals: { found: totalFound },
          },
        },
        ctx.opts,
      );
    } else {
      info(`Would generate a new age identity (current: ${oldRecipient.slice(0, 16)}…).`, ctx.opts);
      info(
        ctx.gracePeriodDays > 0
          ? `Would dual-encrypt ${totalFound} envelope(s) for a ${ctx.gracePeriodDays}-day grace window.`
          : "grace_period_days=0 → would do immediate cutover, dropping old recipient.",
        ctx.opts,
      );
    }
    return;
  }

  // Live rotation: generate new identity + sidecar.
  const state = await backend.rotateIdentity({ gracePeriodDays: ctx.gracePeriodDays });

  // Now rewrap every envelope to the new (potentially dual) recipient set.
  const stats = await rewrapMany(targets, backend, { dryRun: false, noBackup: ctx.noBackup });
  const totalRewrapped = stats.reduce((n, s) => n + s.rewrapped, 0);
  const totalFound = stats.reduce((n, s) => n + s.found, 0);

  if (ctx.gracePeriodDays === 0) {
    // Immediate cutover: drop the old identity + state file. The
    // sidecar `_rotation-old.pub` was never written for grace=0, so
    // finalizeRotation only cleans up `identity.age.old` + state.
    await backend.finalizeRotation();
  }

  const isImmediateCutover = ctx.gracePeriodDays === 0;
  const stagedPaths = isImmediateCutover
    ? [
        ...targets,
        backend.getIdentityPath(),
        // identity.age.old already deleted by finalizeRotation() above
        // _rotation-old.pub was never written for grace=0
        backend.getRotationStatePath(),
      ]
    : [
        ...targets,
        backend.getIdentityPath(),
        `${backend.getIdentityPath()}.old`,
        join(backend.getRecipientsDir(), "_rotation-old.pub"),
        backend.getRotationStatePath(),
      ];
  await bestEffortCommitSecretsChanges(
    ctx.configDir,
    stagedPaths,
    isImmediateCutover
      ? "secrets(rotate): generate new identity (immediate cutover, grace_period_days=0)"
      : `secrets(rotate): generate new identity + dual-encrypt for grace_period_days=${ctx.gracePeriodDays}`,
    ctx.opts,
  );

  if (ctx.json) {
    output(
      {
        action: "rotate",
        phase: ctx.gracePeriodDays === 0 ? "finalized" : "dual-encrypt",
        old_recipient: state.old_recipient,
        new_recipient: state.new_recipient,
        grace_period_until: state.grace_until,
        grace_period_days: ctx.gracePeriodDays,
        files: stats.length,
        envelopes: totalFound,
        rewrapped: totalRewrapped,
      },
      ctx.opts,
    );
    return;
  }

  info(`Rotated identity. New recipient: ${state.new_recipient}`, ctx.opts);
  info(`Old recipient: ${state.old_recipient}`, ctx.opts);
  if (ctx.gracePeriodDays > 0) {
    info(
      `Grace period: ${ctx.gracePeriodDays} day(s) — both identities can decrypt until ${state.grace_until}.`,
      ctx.opts,
    );
    info(
      "Run `am secrets rotate --finalize` after the grace window to drop the old identity.",
      ctx.opts,
    );
  } else {
    info("grace_period_days=0 → immediate cutover. Old identity dropped.", ctx.opts);
  }
  info(
    `Rewrapped ${totalRewrapped}/${totalFound} envelope(s) across ${stats.length} file(s).`,
    ctx.opts,
  );
}

async function runFinalize(
  backend: AgeSecretsBackend,
  ctx: CommonRunOpts & { force: boolean },
): Promise<void> {
  const state = await backend.readRotationState();
  if (!state) {
    const msg = "No rotation in progress — nothing to finalize.";
    if (ctx.json) output({ action: "rotate-finalize", error: msg }, ctx.opts);
    else info(msg, ctx.opts);
    process.exitCode = 1;
    return;
  }

  // Grace-window check.
  const now = Date.now();
  const expiry = Date.parse(state.grace_until);
  const inGrace = Number.isFinite(expiry) && now < expiry;
  if (inGrace && !ctx.force) {
    const remainingMs = expiry - now;
    const remainingDays = Math.ceil(remainingMs / 86_400_000);
    const msg = `Grace period not elapsed: ${remainingDays} day(s) remain (until ${state.grace_until}). Use --force to override.`;
    if (ctx.json) {
      output({ action: "rotate-finalize", error: msg, state }, ctx.opts);
    } else {
      info(msg, ctx.opts);
    }
    process.exitCode = 1;
    return;
  }

  const targets = ctx.file
    ? [resolveSingleFile(ctx.file)]
    : await discoverTomlFiles(ctx.configDir, process.cwd());

  if (ctx.dryRun) {
    const stats = await rewrapMany(targets, backend, { dryRun: true, noBackup: ctx.noBackup });
    const totalFound = stats.reduce((n, s) => n + s.found, 0);
    if (ctx.json) {
      output(
        {
          action: "rotate-finalize",
          reads_only: true,
          would_do: [
            "remove old recipient sidecar (_rotation-old.pub)",
            "delete identities/identity.age.old",
            "clear .am-rotation-state.json",
            `re-encrypt ${totalFound} envelope(s) to new-only recipient`,
          ],
          mutations_prevented: [
            "old recipient deletion",
            "old identity deletion",
            "TOML config rewrites",
          ],
          warnings: inGrace
            ? [
                `grace period still active until ${state.grace_until} (would be overridden by --force)`,
              ]
            : [],
          explanation: {
            state,
            files: stats,
            totals: { found: totalFound },
          },
        },
        ctx.opts,
      );
    } else {
      info(
        `Would finalize rotation: drop old recipient ${state.old_recipient.slice(0, 16)}… and re-encrypt ${totalFound} envelope(s).`,
        ctx.opts,
      );
    }
    return;
  }

  // ADR-0051 §Phase-1 / gpt-5.5 Phase-8 must-fix #1 — safe finalize
  // ordering. The OLD ordering ("delete sidecar+archive+state, THEN
  // rewrap") could orphan envelopes if rewrap failed: dual-encrypted
  // ciphertext targeting a now-deleted recipient with no archived
  // identity to fall back on. The fix is a 3-stage commit:
  //
  //   1. Prepare    — drop ONLY the OLD recipient sidecar.
  //   2. Rewrap     — re-encrypt every envelope to the NEW-only set.
  //   3. Commit     — delete archive + state file ONLY if step 2
  //                   succeeded for every envelope.
  //
  // If step 2 reports any failure, we restore the sidecar (revert to
  // dual-encrypt grace state) and exit non-zero. The archived identity
  // and state file are still on disk, so the operator can retry once
  // the underlying issue (corrupt envelope, disk full, …) is resolved.

  // 1. Stage 1 of finalize — drop only the OLD recipient sidecar.
  const prepared = await backend.finalizeRotationPrepare();
  if (!prepared) {
    // Should not happen: we already verified state above. Defensive.
    const msg = "Internal error: rotation state vanished between read and prepare.";
    if (ctx.json) output({ action: "rotate-finalize", error: msg }, ctx.opts);
    else info(msg, ctx.opts);
    process.exitCode = 1;
    return;
  }

  // 2. Rewrap every envelope to the now-only-new recipient set.
  const stats = await rewrapMany(targets, backend, { dryRun: false, noBackup: ctx.noBackup });
  const totalRewrapped = stats.reduce((n, s) => n + s.rewrapped, 0);
  const totalFound = stats.reduce((n, s) => n + s.found, 0);
  const totalSkipped = stats.reduce((n, s) => n + s.skipped, 0);

  // Any rewrap failure → restore the OLD recipient sidecar and abort.
  // The archived identity + state file are untouched, so the rotation
  // is left in the same dual-encrypt state it was in before finalize.
  if (totalSkipped > 0 || totalRewrapped < totalFound) {
    try {
      await backend.restoreOldRecipient(prepared);
    } catch (restoreErr) {
      const reason = restoreErr instanceof Error ? restoreErr.message : String(restoreErr);
      const hint = `WARN: failed to restore OLD recipient sidecar (${reason}). Manual recovery: run 'age-keygen -y identity.age.old > recipients/_rotation-old.pub' to reconstruct it.`;
      if (ctx.json) {
        output({ action: "rotate-finalize", error: hint, state: prepared }, ctx.opts);
      } else {
        info(hint, ctx.opts);
      }
    }
    const msg = `Finalize aborted: rewrap reported ${totalSkipped} skipped and ${totalFound - totalRewrapped} unrewrapped envelope(s) across ${stats.length} file(s). Old recipient restored; rotation remains in dual-encrypt grace state. Inspect the offending envelopes and retry.`;
    if (ctx.json) {
      output(
        {
          action: "rotate-finalize",
          error: msg,
          state: prepared,
          files: stats,
          envelopes: totalFound,
          rewrapped: totalRewrapped,
          skipped: totalSkipped,
        },
        ctx.opts,
      );
    } else {
      info(msg, ctx.opts);
    }
    process.exitCode = 1;
    return;
  }

  // 3. Stage 2 of finalize — drop the archive + state file. Only
  //    runs once we're certain every envelope is NEW-only.
  await backend.finalizeRotationCommit();
  const finalized = prepared;

  await bestEffortCommitSecretsChanges(
    ctx.configDir,
    [
      ...targets,
      backend.getIdentityPath(),
      `${backend.getIdentityPath()}.old`,
      join(backend.getRecipientsDir(), "_rotation-old.pub"),
      backend.getRotationStatePath(),
    ],
    `secrets(rotate --finalize): drop old recipient + identity, ${totalFound} envelope(s) to new-only`,
    ctx.opts,
  );

  if (ctx.json) {
    output(
      {
        action: "rotate-finalize",
        phase: "finalized",
        old_recipient: finalized.old_recipient,
        new_recipient: finalized.new_recipient,
        files: stats.length,
        envelopes: totalFound,
        rewrapped: totalRewrapped,
      },
      ctx.opts,
    );
    return;
  }

  info(`Finalized rotation. Old recipient ${state.old_recipient.slice(0, 16)}… dropped.`, ctx.opts);
  info(
    `Rewrapped ${totalRewrapped}/${totalFound} envelope(s) across ${stats.length} file(s).`,
    ctx.opts,
  );
}

// Re-export RotationState for downstream callers that import this
// module (mirrors the previous shape where rotate-related types lived
// alongside the command).
export type { RotationState };
