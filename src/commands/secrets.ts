/**
 * `am secrets` — umbrella for ADR-0042 multi-backend operations.
 *
 * Kept separate from the existing `am secret` group (singular) which
 * manages individual secret values (set/get/list/scan/generate-key).
 * The plural form hosts the cross-cutting backend-level operations:
 *
 *   - `am secrets migrate` — forward-port enc:v1: envelopes to the
 *     currently-configured backend.
 *   - `am secrets rotate` — rewrap enc:v2:age: envelopes against the
 *     current recipient set (age backend only).
 *
 * Both subcommands read `settings.secrets.backend` from `config.toml`
 * (or the `AM_SECRETS_BACKEND` env var) to decide the target backend.
 */

import { defineCommand } from "citty";

export const secretsCommand = defineCommand({
  meta: {
    name: "secrets",
    description: "Backend-level secrets operations (migrate, rotate)",
  },
  args: {
    json: { type: "boolean", description: "JSON output", default: false },
    quiet: { type: "boolean", alias: "q", default: false },
    verbose: { type: "boolean", alias: "v", default: false },
  },
  subCommands: {
    migrate: () => import("./secrets-migrate").then((m) => m.secretsMigrateCommand),
    rotate: () => import("./secrets-rotate").then((m) => m.secretsRotateCommand),
  },
});
