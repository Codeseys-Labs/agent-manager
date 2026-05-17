/**
 * `am pair` — umbrella for ADR-0047 cross-device key handoff.
 *
 * Subcommands:
 *   - `am pair accept <name>`  — run on the NEW device; generates an
 *     age identity and writes `recipients/<name>.pub`.
 *   - `am pair finalize <name>` — run on the ORIGINAL device; registers
 *     the new device's public key and rewraps all enc:v2:age envelopes
 *     so the new device can decrypt them.
 *   - `am pair add <name>` — DEPRECATED alias for `am pair accept`.
 *     Forwards to the same code path; emits a stderr deprecation warning.
 *     Mirrors the `am run agents → am agent list` deprecation pattern
 *     (src/commands/run.ts:690-707).
 */

import { defineCommand } from "citty";
import { warn } from "../lib/output";
import { pairAcceptCommand } from "./pair-accept";

const PAIR_ADD_DEPRECATION = "`am pair add` is deprecated — use `am pair accept` (same behavior).";

const pairAddCommand = defineCommand({
  meta: {
    name: "add",
    description:
      "DEPRECATED: alias for `am pair accept` (same behavior). Use `am pair accept` instead.",
  },
  args: pairAcceptCommand.args,
  async run(ctx) {
    const args = ctx.args as Record<string, unknown>;
    const opts = {
      json: !!args.json,
      quiet: !!args.quiet,
      verbose: !!args.verbose,
    };
    warn(PAIR_ADD_DEPRECATION, opts);
    await (
      pairAcceptCommand as unknown as {
        run: (ctx: { args: Record<string, unknown> }) => Promise<void>;
      }
    ).run({ args });
  },
});

export const pairCommand = defineCommand({
  meta: {
    name: "pair",
    description:
      "Cross-device key handoff — accept a new device or finalize pairing by rewrapping envelopes (ADR-0047).",
  },
  args: {
    json: { type: "boolean", description: "JSON output", default: false },
    quiet: { type: "boolean", alias: "q", default: false },
    verbose: { type: "boolean", alias: "v", default: false },
  },
  subCommands: {
    accept: () => import("./pair-accept").then((m) => m.pairAcceptCommand),
    finalize: () => import("./pair-finalize").then((m) => m.pairFinalizeCommand),
    add: () => Promise.resolve(pairAddCommand),
  },
});
