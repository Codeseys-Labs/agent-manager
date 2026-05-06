/**
 * `am pair` — umbrella for ADR-0047 cross-device key handoff.
 *
 * Subcommands:
 *   - `am pair accept <name>`  — run on the NEW device; generates an
 *     age identity and writes `recipients/<name>.pub`.
 *   - `am pair finalize <name>` — run on the ORIGINAL device; registers
 *     the new device's public key and rewraps all enc:v2:age envelopes
 *     so the new device can decrypt them.
 */

import { defineCommand } from "citty";

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
  },
});
