/**
 * `am secrets` — umbrella for ADR-0042 / ADR-0051 multi-backend
 * operations.
 *
 * Kept separate from the existing `am secret` group (singular) which
 * manages individual secret values (set/get/list/scan/generate-key).
 * The plural form hosts the cross-cutting backend-level operations:
 *
 *   - `am secrets migrate` — forward-port enc:v1: envelopes to the
 *     currently-configured backend.
 *   - `am secrets rewrap` — re-encrypt enc:v2:age: envelopes against
 *     the current recipient set (no identity change). ADR-0051 verb.
 *   - `am secrets rotate [--finalize]` — generate a new identity,
 *     dual-encrypt during the grace period, then drop the old at
 *     `--finalize`. ADR-0051 verb.
 *   - `am secrets revoke <fingerprint>` — drop a peer recipient and
 *     rewrap. ADR-0051 verb.
 *
 * All four read `settings.secrets.backend` from `config.toml` (or the
 * `AM_SECRETS_BACKEND` env var) to decide the target backend, and only
 * `migrate` / `rewrap` / `rotate` / `revoke` operate on the `age`
 * backend.
 */

import { defineCommand } from "citty";

export const secretsCommand = defineCommand({
  meta: {
    name: "secrets",
    description: "Backend-level secrets operations (migrate, rewrap, rotate, revoke)",
  },
  args: {
    json: { type: "boolean", description: "JSON output", default: false },
    quiet: { type: "boolean", alias: "q", default: false },
    verbose: { type: "boolean", alias: "v", default: false },
  },
  subCommands: {
    migrate: () => import("./secrets-migrate").then((m) => m.secretsMigrateCommand),
    rewrap: () => import("./secrets-rewrap").then((m) => m.secretsRewrapCommand),
    rotate: () => import("./secrets-rotate").then((m) => m.secretsRotateCommand),
    revoke: () => import("./secrets-revoke").then((m) => m.secretsRevokeCommand),
  },
});
