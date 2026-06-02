import * as clack from "@clack/prompts";
import { defineCommand } from "citty";
import { getDetectedAdapters } from "../adapters/registry";
import type { Adapter } from "../adapters/types";
import { pruneBackups } from "../core/apply-backup";
import { resolveConfigDir } from "../core/config";
import { APPLY_SAFE_DEFAULTS, type ApplyResolvedResult, applyResolved } from "../core/controller";
import type { DryRunEnvelope } from "../lib/dry-run-envelope";
import { AmError, errorMessage } from "../lib/errors";
import { amError, info, output, warn } from "../lib/output";

/**
 * Test-only adapter-detection seam (mirrors `__setDetectedAdaptersForTests`
 * in commands/setup.ts and `__setAdapterResolverForTests` in core/controller.ts).
 * When set, the interactive target-confirmation path resolves the detected list
 * through this override instead of the real registry, so command-level tests can
 * drive the multiselect branch WITHOUT detecting the host machine's tools. Never
 * set in prod.
 */
let detectedAdaptersOverride: (() => Promise<Adapter[]>) | null = null;

/** @internal test seam — see `detectedAdaptersOverride`. */
export function __setDetectedAdaptersForTests(fn: (() => Promise<Adapter[]>) | null): void {
  detectedAdaptersOverride = fn;
}

async function resolveDetectedAdapters(): Promise<Adapter[]> {
  return detectedAdaptersOverride ? detectedAdaptersOverride() : getDetectedAdapters();
}

/**
 * The subset of `@clack/prompts` the interactive target-confirmation path uses.
 * Pulled into a named type so a test can inject a deterministic, non-blocking
 * double for the multiselect branch WITHOUT a process-global
 * `mock.module("@clack/prompts", …)` — that approach leaks into every other
 * parallel test file that imports clack. This mirrors the `ClackLike` seam in
 * commands/setup.ts and is the only sanctioned way to exercise the prompt here.
 */
export type ClackLike = Pick<typeof clack, "multiselect" | "isCancel">;

let clackOverride: ClackLike | null = null;

/** @internal test seam — inject a clack double for the multiselect path. */
export function __setClackForTests(impl: ClackLike | null): void {
  clackOverride = impl;
}

/** Resolve the clack implementation (real module, or a test-injected double). */
function getClack(): ClackLike {
  return clackOverride ?? clack;
}

/**
 * The decision inputs that determine which tools an `am apply` run targets,
 * factored out of the command handler so the target-selection logic is unit
 * testable without driving a clack TTY prompt.
 */
export interface ResolveApplyTargetsInput {
  /** Explicit `--targets a,b` CSV, already parsed/trimmed/filtered. */
  explicitTargets: string[];
  /** `--target <one>` (single adapter). */
  target?: string;
  yes: boolean;
  json: boolean;
  quiet: boolean;
  dryRun: boolean;
  /** `process.stdin.isTTY` — whether we can interactively prompt. */
  isTTY: boolean;
}

/**
 * Outcome of the target-selection decision.
 *   - `apply`     → proceed; `targets` is the scoped subset, or `undefined`
 *                   meaning "apply to every detected tool" (prior fan-out).
 *   - `cancelled` → the operator cancelled the interactive multiselect; the
 *                   handler must short-circuit with the cancellation notice.
 */
export type ResolveApplyTargetsResult =
  | { action: "apply"; targets: string[] | undefined }
  | { action: "cancelled" };

/**
 * Decide which detected tools `am apply` should write to.
 *
 * P1-B per-target opt-in: apply historically fanned out to EVERY detected tool,
 * and detection is pure file-presence (over-reports). In an interactive live
 * apply we show the detected list and let the operator confirm/select which
 * tools to write. Explicit `--target`/`--targets`, `--yes`, `--json`,
 * `--quiet`, dry-run, and non-TTY all bypass the prompt and preserve the prior
 * fan-out-to-all behavior (contract for scripts/CI).
 *
 * The detected adapters are resolved lazily (only when an interactive prompt is
 * actually warranted) via the injected `detect` resolver, so non-interactive
 * callers never trigger host detection here.
 */
export async function resolveApplyTargets(
  input: ResolveApplyTargetsInput,
  detect: () => Promise<Adapter[]>,
  prompt: ClackLike = getClack(),
): Promise<ResolveApplyTargetsResult> {
  // Explicit `--targets a,b` always wins and never prompts.
  if (input.explicitTargets.length > 0) {
    return { action: "apply", targets: input.explicitTargets };
  }

  const wantsInteractiveSelection =
    !input.target && !input.yes && !input.json && !input.quiet && !input.dryRun && input.isTTY;

  if (!wantsInteractiveSelection) {
    // Non-interactive (scripts/CI, --json, --yes, dry-run, non-TTY) → fan out
    // to every detected tool, exactly as before.
    return { action: "apply", targets: undefined };
  }

  const detected = await detect();
  // Only prompt when there's a real choice to make. Zero detected tools falls
  // through to the existing "No tools detected" recovery path; a single tool is
  // applied without a needless one-option prompt.
  if (detected.length <= 1) {
    return { action: "apply", targets: undefined };
  }

  const selection = await prompt.multiselect({
    message: "Apply to which tools?",
    options: detected.map((a) => ({
      value: a.meta.name,
      label: a.meta.displayName ?? a.meta.name,
    })),
    initialValues: detected.map((a) => a.meta.name),
    required: true,
  });
  if (prompt.isCancel(selection)) {
    return { action: "cancelled" };
  }
  return { action: "apply", targets: selection as string[] };
}

/**
 * Classify why an adapter was skipped (apply-summary-line item).
 *
 * The controller funnels two distinct fail-closed paths into the same
 * `skipped[]` list:
 *   - SEC-4 drift gate: native config DRIFTED → warning starts "drift detected"
 *   - SEC-4b diff-error: `adapter.diff()` THREW (drift UNKNOWN) → warning
 *     starts "drift check failed"
 * The two need different operator guidance ("rerun --force to overwrite the
 * drift you saw" vs. "the drift state could not even be read"). We classify
 * off the controller's warning prefixes — the single source of truth for the
 * skip reason — rather than re-deriving state in the CLI.
 */
type SkipReason = "drift-detected" | "diff-error";

function classifySkip(warnings: string[]): SkipReason {
  const joined = warnings.join(" ");
  // "drift check failed (...)" is the diff-error (state unknown) path.
  if (joined.includes("drift check failed")) return "diff-error";
  // "drift detected (...)" — and any other gate — falls back to drift-detected.
  return "drift-detected";
}

/**
 * Render a byte count as a short human-readable string (base-1000).
 * Mirrors the helper in doctor.ts; kept inline so apply.ts has no
 * cross-command import.
 */
function formatBytes(bytes: number): string {
  if (bytes < 1000) return `${bytes} B`;
  if (bytes < 1000 * 1000) return `${(bytes / 1000).toFixed(1)} KB`;
  return `${(bytes / (1000 * 1000)).toFixed(1)} MB`;
}

/**
 * ADR-0038 explanation payload emitted by `am apply --dry-run --json`.
 * The shared envelope wrapper (`DryRunEnvelope<ApplyExplanation>`) lives
 * in `src/lib/dry-run-envelope.ts`; this is the action-specific body.
 */
interface ApplyExplanation {
  profile: string;
  results: Array<{
    adapter: string;
    status: "ok" | "failed" | "skipped";
    files: Array<{ path: string; written: boolean }>;
    warnings: string[];
    error?: string;
    diff?: { status: "in-sync" | "drifted" | "unmanaged"; changes: number };
  }>;
  succeeded: number;
  failed: ApplyResolvedResult["failed"];
  skipped: string[];
}

export const applyCommand = defineCommand({
  meta: { name: "apply", description: "Generate native configs for detected tools" },
  args: {
    "dry-run": { type: "boolean", description: "Preview changes without writing", default: false },
    diff: {
      type: "boolean",
      description:
        "Show the drift summary line per adapter (in-sync / drifted / unmanaged + change count). The drift GATE itself is on by default (fail-closed): a live apply without --force already refuses to overwrite a drifted adapter regardless of this flag.",
      default: false,
    },
    force: {
      type: "boolean",
      description:
        "Overwrite even if the native config has drifted from the catalog (bypasses the fail-closed drift gate). No-op in --dry-run.",
      default: false,
    },
    target: { type: "string", description: "Apply to specific adapter only" },
    targets: {
      type: "string",
      description:
        "Apply to a comma-separated subset of adapters (e.g. --targets claude-code,cursor). Bypasses the interactive target confirmation.",
    },
    yes: {
      type: "boolean",
      alias: "y",
      description:
        "Skip the interactive target confirmation and apply to every detected tool (non-interactive default).",
      default: false,
    },
    profile: { type: "string", description: "Override active profile" },
    json: { type: "boolean", description: "JSON output", default: false },
    quiet: { type: "boolean", alias: "q", default: false },
    verbose: { type: "boolean", alias: "v", default: false },
  },
  async run({ args }) {
    const opts = { json: args.json, quiet: args.quiet, verbose: args.verbose };
    try {
      const configDir = resolveConfigDir();

      // P1-B: parse the explicit `--targets a,b` list (CSV). Empty entries are
      // dropped; the controller also trims/dedupes defensively.
      const explicitTargets = (typeof args.targets === "string" ? args.targets : "")
        .split(",")
        .map((t) => t.trim())
        .filter((t) => t.length > 0);

      // P1-B: decide which detected tools to write to. The decision (explicit
      // targets win, who prompts, fan-out-to-all default) is factored into the
      // injectable `resolveApplyTargets` unit so it is testable without driving
      // a clack TTY prompt; here we just route its outcome.
      const targetDecision = await resolveApplyTargets(
        {
          explicitTargets,
          target: typeof args.target === "string" ? args.target : undefined,
          yes: Boolean(args.yes),
          json: Boolean(args.json),
          quiet: Boolean(args.quiet),
          dryRun: Boolean(args["dry-run"]),
          isTTY: Boolean(process.stdin.isTTY),
        },
        resolveDetectedAdapters,
      );
      if (targetDecision.action === "cancelled") {
        info("Apply cancelled.", opts);
        return;
      }
      const selectedTargets = targetDecision.targets;

      let applyResult: ApplyResolvedResult;
      try {
        applyResult = await applyResolved(configDir, {
          dryRun: args["dry-run"],
          // CLI-default decision (Wave B apply-follow): the drift GATE is on by
          // default (fail-closed) for consistency with MCP / web / TUI, derived
          // from the shared APPLY_SAFE_DEFAULTS so the safe posture lives in ONE
          // place. `--diff` is now only the inline drift-summary DISPLAY toggle;
          // it no longer controls whether the gate runs (it always does in live
          // mode). dry-run never overwrites, so the gate is moot there.
          diff: APPLY_SAFE_DEFAULTS.diff || args.diff,
          force: args.force,
          target: args.target,
          targets: selectedTargets,
          profile: args.profile,
        });
      } catch (err) {
        // silent-failure fix (Wave B apply-follow): the previous catch mapped
        // ANY non-'not found' error to CONFIG_NOT_FOUND, which masked a real
        // Windows crypto throw ('The string contains invalid characters' from
        // atob() on a malformed key) as a misleading 'Config not found' — costing
        // debugging time. `loadResolvedConfig` returns an EMPTY config (not a
        // throw) when the file is missing, so a genuine missing-config never even
        // reaches here. Narrow the mapping: only an adapter-not-found keeps its
        // dedicated code; everything else surfaces with its REAL message.
        //
        // Match the controller's exact adapter-not-found sentinel
        // (`Adapter "<name>" not found. Available: ...`) rather than a bare
        // "not found" substring, so an unrelated error that merely contains the
        // words "not found" is not mislabeled as an adapter problem.
        if (err instanceof Error && /Adapter ".*" not found/.test(err.message)) {
          // Adapter-not-found bubbles up from `applyResolved`.
          throw new AmError(err.message, err.message, "ADAPTER_NOT_FOUND");
        }
        const realMessage = errorMessage(err) || "apply failed";
        throw new AmError(
          `Apply failed: ${realMessage}`,
          "Re-run with --verbose for details",
          "APPLY_FAILED",
        );
      }

      const total = applyResult.results.length;
      if (total === 0) {
        // JSON consumers must always get a parseable envelope — even when no
        // tools are detected (e.g. a CI host with no IDEs installed). Without
        // this, `--json` mode would emit nothing here (info() is suppressed in
        // JSON mode), so callers parsing stdout hit "Unexpected EOF". Emit the
        // canonical (empty-results) envelope and return. (Wave CI / P0-5.)
        if (args.json) {
          if (args["dry-run"]) {
            const envelope: DryRunEnvelope<ApplyExplanation> = {
              action: "apply",
              reads_only: true,
              would_do: [],
              mutations_prevented: ["adapter file writes"],
              warnings: [],
              explanation: {
                profile: applyResult.profile,
                results: [],
                succeeded: 0,
                failed: [],
                skipped: [],
              },
            };
            output(
              {
                ...envelope,
                profile: applyResult.profile,
                dryRun: true,
                results: [],
                succeeded: 0,
                failed: [],
                skipped: [],
              },
              opts,
            );
          } else {
            output(
              {
                action: "apply",
                profile: applyResult.profile,
                dryRun: false,
                results: [],
                succeeded: 0,
                failed: [],
                skipped: [],
              },
              opts,
            );
          }
          return;
        }
        // Novice first-run recovery (2026-05-03-E, per Codex-B audit):
        // don't leave the user at a dead end. Point at the three commands
        // most likely to produce immediate value.
        info("No tools detected. Nothing to apply.", opts);
        info("Get started with one of:", opts);
        info("  am agent list --runnable     # see which built-in agents work now", opts);
        info("  am search <query>            # find an MCP server in the Registry", opts);
        info("  am add server <name> --command <cmd>   # add an MCP server by hand", opts);
        return;
      }

      // P1-H: surface the controller's advisory notices (e.g. the
      // unscoped-catalog signpost). The controller is I/O-free and returns
      // them in `notices`; the CLI renders them at info level (suppressed in
      // --json/--quiet, where they ride along in the JSON payload below).
      for (const notice of applyResult.notices ?? []) {
        info(notice, opts);
      }

      // Per-adapter reporting stays at the surface — controller returns the
      // structured result, CLI formats it for the terminal.
      for (const res of applyResult.results) {
        const written = res.files.filter((f) => f.written).length;
        if (res.error) {
          warn(`${res.adapter}: ${res.error}`, opts);
          continue;
        }
        // Adapter was skipped due to drift gate (diff + no force in live mode).
        if (applyResult.skipped.includes(res.adapter)) {
          for (const w of res.warnings) warn(`${res.adapter}: ${w}`, opts);
          continue;
        }
        if (!args["dry-run"]) {
          info(`${res.adapter}: wrote ${written} file(s)`, opts);
        } else {
          info(`${res.adapter}: would write ${res.files.length} file(s)`, opts);
          for (const f of res.files) {
            info(`  ${f.path}`, opts);
          }
        }
        // ADR-0038 (`--diff`): surface drift summary inline next to file
        // counts so operators see in-sync / drifted at a glance. The gate now
        // runs unconditionally (fail-closed default), so `res.diff` is populated
        // even without `--diff`; only show the inline summary when the operator
        // explicitly asked for it, to keep the default output uncluttered.
        if (args.diff && res.diff) {
          info(`${res.adapter}: drift=${res.diff.status} (${res.diff.changes} change(s))`, opts);
        }
        for (const w of res.warnings) {
          warn(`${res.adapter}: ${w}`, opts);
        }
      }

      if (applyResult.failed.length > 0) {
        const failedNames = applyResult.failed.map((f) => f.adapter).join(", ");
        info(
          `Applied to ${applyResult.succeeded.length} of ${total} adapters. ${applyResult.failed.length} failed: [${failedNames}].`,
          opts,
        );
        process.exitCode = 1;
      } else if (applyResult.skipped.length > 0 && !args["dry-run"]) {
        // Drift-gated skip (diff && !force) is also a non-zero exit so CI
        // catches the refusal — the operator must rerun with --force.
        //
        // apply-summary-line: a skip can fire for TWO reasons and they need
        // distinct guidance. Classify each skipped adapter off the controller's
        // warning so we never mislabel a diff-error (state UNKNOWN) skip as a
        // confirmed-drift skip.
        const skipResults = applyResult.results.filter((r) =>
          applyResult.skipped.includes(r.adapter),
        );
        const diffErrorNames = skipResults
          .filter((r) => classifySkip(r.warnings) === "diff-error")
          .map((r) => r.adapter);
        const driftNames = skipResults
          .filter((r) => classifySkip(r.warnings) === "drift-detected")
          .map((r) => r.adapter);

        const parts: string[] = [];
        if (driftNames.length > 0) {
          parts.push(
            `${driftNames.length} skipped (drift detected; rerun with --force) [${driftNames.join(", ")}]`,
          );
        }
        if (diffErrorNames.length > 0) {
          parts.push(
            `${diffErrorNames.length} skipped (drift check failed — state unknown; rerun with --force) [${diffErrorNames.join(", ")}]`,
          );
        }
        info(
          `Applied to ${applyResult.succeeded.length} of ${total} adapters. ${parts.join(". ")}.`,
          opts,
        );
        process.exitCode = 1;
      } else {
        info(`Applied to ${applyResult.succeeded.length} of ${total} adapters.`, opts);
      }

      // Proactive backup prune (DWL-T9): after a clean live apply with
      // backups enabled, sweep stale .bak files so disk usage doesn't
      // grow unbounded. Best-effort: never let a prune failure mask a
      // successful apply.
      if (
        !args["dry-run"] &&
        applyResult.failed.length === 0 &&
        (process.env.AM_APPLY_BACKUP === "1" || process.env.AM_APPLY_BACKUP === "true")
      ) {
        try {
          const pruneResult = await pruneBackups();
          if (pruneResult.removed > 0 && !args.json) {
            info(
              `Pruned ${pruneResult.removed} old backup(s), freed ${formatBytes(pruneResult.freedBytes)}.`,
              opts,
            );
          }
        } catch (err) {
          warn(`Backup prune failed: ${errorMessage(err)}`, opts);
        }
      }

      if (args.json) {
        // Per-adapter result with a derived `status` so JSON consumers don't
        // have to infer success from error-presence (C3 Option C, 2026-05-03).
        const results = applyResult.results.map((r) => ({
          adapter: r.adapter,
          status: r.error
            ? ("failed" as const)
            : applyResult.skipped.includes(r.adapter)
              ? ("skipped" as const)
              : ("ok" as const),
          files: r.files,
          warnings: r.warnings,
          ...(r.error ? { error: r.error } : {}),
          ...(r.diff ? { diff: r.diff } : {}),
        }));

        if (args["dry-run"]) {
          // ADR-0038 canonical envelope. Legacy top-level fields
          // (action, profile, dryRun, results, succeeded, failed, skipped)
          // are KEPT additively for back-compat — JSON consumers built
          // against the pre-envelope shape continue to work.
          const explanation: ApplyExplanation = {
            profile: applyResult.profile,
            results,
            succeeded: applyResult.succeeded.length,
            failed: applyResult.failed,
            skipped: applyResult.skipped,
          };
          const envelope: DryRunEnvelope<ApplyExplanation> = {
            action: "apply",
            reads_only: true,
            would_do: applyResult.results.map(
              (r) => `${r.adapter}: would write ${r.files.length} file(s)`,
            ),
            mutations_prevented: ["adapter file writes"],
            warnings: applyResult.results.flatMap((r) =>
              r.warnings.map((w) => `${r.adapter}: ${w}`),
            ),
            explanation,
          };
          output(
            {
              ...envelope,
              // Back-compat: pre-envelope consumers still expect the
              // top-level `action`, `profile`, `dryRun`, `results`, etc.
              profile: applyResult.profile,
              dryRun: true,
              results,
              succeeded: applyResult.succeeded.length,
              failed: applyResult.failed,
              skipped: applyResult.skipped,
              notices: applyResult.notices,
            },
            opts,
          );
        } else {
          // Live-mode JSON shape — unchanged from pre-ADR-0038.
          output(
            {
              action: "apply",
              profile: applyResult.profile,
              dryRun: false,
              results,
              succeeded: applyResult.succeeded.length,
              failed: applyResult.failed,
              skipped: applyResult.skipped,
              notices: applyResult.notices,
            },
            opts,
          );
        }
      }
    } catch (err) {
      amError(err, opts);
      process.exitCode = 1;
    }
  },
});
