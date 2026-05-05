/**
 * `am secrets rotate` — rewrap all age envelopes in TOML config files
 * for the current recipient set (ADR-0042).
 *
 * Only meaningful when the active backend is `age` — the legacy
 * AES-GCM backend is single-key, so "rotation" there means generating
 * a new master key and re-encrypting, which is out of scope for this
 * command. For aes-gcm-legacy the command exits with a descriptive
 * error and suggests the appropriate workflow.
 *
 * For each `enc:v2:age:...` envelope found, we call
 * `AgeSecretsBackend.rewrap(envelope)` with no explicit recipient
 * list — that re-derives the recipient set from the local identity
 * plus the `recipients/` sidecar directory, which is exactly what
 * `am secret recipient add/remove` mutates. Net effect: after the
 * admin edits the recipient list, `am secrets rotate` brings every
 * envelope on disk into sync with that new set.
 *
 * Supports `--dry-run` (no writes), `--file <path>` (single file),
 * and `--no-backup` (suppress `.bak` copy).
 */

import { readFile } from "node:fs/promises";
import { join, resolve as resolvePath } from "node:path";
import * as TOML from "@iarna/toml";
import { defineCommand } from "citty";
import { atomicWriteFile } from "../core/atomic-write";
import { resolveConfigDir, resolveProjectConfig } from "../core/config";
import { getDefaultBackend } from "../core/secrets";
import type { AgeSecretsBackend } from "../core/secrets-age";
import type { SecretsBackend } from "../core/secrets-backend";
import { amError, info, output } from "../lib/output";

const AGE_ENVELOPE_PREFIX = "enc:v2:age:";

interface RotateStat {
  file: string;
  found: number;
  rotated: number;
  skipped: number;
  backupPath?: string;
}

export const secretsRotateCommand = defineCommand({
  meta: {
    name: "rotate",
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
        const msg = `am secrets rotate requires the \`age\` backend; current backend is \`${backend.name}\`. Set settings.secrets.backend = "age" in config.toml (and run \`am secrets migrate\` to forward-port existing envelopes) before rotating.`;
        if (args.json) {
          output({ action: "rotate", error: msg, backend: backend.name }, opts);
        } else {
          info(msg, opts);
        }
        process.exitCode = 1;
        return;
      }

      // Narrow via duck-type rather than importing the concrete class
      // to avoid an unused-import warning when the backend isn't age.
      if (typeof (backend as AgeSecretsBackend).rewrap !== "function") {
        throw new Error(
          "Active age backend does not expose rewrap() — upgrade core/secrets-age.ts.",
        );
      }

      const targets = args.file
        ? [resolvePath(args.file)]
        : await discoverTomlFiles(configDir, process.cwd());

      const stats: RotateStat[] = [];
      for (const file of targets) {
        const stat = await rotateFile(file, backend, { dryRun, noBackup });
        if (stat) stats.push(stat);
      }

      const totalFound = stats.reduce((n, s) => n + s.found, 0);
      const totalRotated = stats.reduce((n, s) => n + s.rotated, 0);

      if (args.json) {
        output(
          {
            action: "rotate",
            dryRun,
            backend: backend.name,
            files: stats,
            totals: { found: totalFound, rotated: totalRotated },
          },
          opts,
        );
        return;
      }

      if (stats.length === 0) {
        info("No TOML config files found to scan.", opts);
        return;
      }

      for (const s of stats) {
        if (s.found === 0) continue;
        const action = dryRun ? "would rotate" : "rotated";
        info(`${s.file}: ${action} ${s.rotated}/${s.found} envelope(s).`, opts);
        if (s.backupPath) info(`  backup: ${s.backupPath}`, opts);
      }
      info("", opts);
      info(
        `Total: ${totalRotated}/${totalFound} envelope(s) ${dryRun ? "would be " : ""}rotated.`,
        opts,
      );
    } catch (err) {
      amError(err, opts);
      process.exitCode = 1;
    }
  },
});

async function discoverTomlFiles(configDir: string, cwd: string): Promise<string[]> {
  const out = new Set<string>();
  const { stat } = await import("node:fs/promises");
  async function exists(p: string): Promise<boolean> {
    try {
      await stat(p);
      return true;
    } catch {
      return false;
    }
  }
  const globalConfig = join(configDir, "config.toml");
  if (await exists(globalConfig)) out.add(globalConfig);
  const localConfig = join(configDir, "config.local.toml");
  if (await exists(localConfig)) out.add(localConfig);
  const projectConfig = resolveProjectConfig(cwd);
  if (projectConfig) out.add(projectConfig);
  return Array.from(out);
}

async function rotateFile(
  file: string,
  backend: SecretsBackend,
  opts: { dryRun: boolean; noBackup: boolean },
): Promise<RotateStat | null> {
  let raw: string;
  try {
    raw = await readFile(file, "utf-8");
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = TOML.parse(raw);
  } catch {
    return { file, found: 0, rotated: 0, skipped: 0 };
  }

  let found = 0;
  let rotated = 0;
  let skipped = 0;

  const ageBackend = backend as AgeSecretsBackend;

  async function walk(value: unknown): Promise<unknown> {
    if (typeof value === "string") {
      if (!value.startsWith(AGE_ENVELOPE_PREFIX)) return value;
      found++;
      try {
        const next = await ageBackend.rewrap(value);
        if (next !== value) rotated++;
        return next;
      } catch {
        skipped++;
        return value;
      }
    }
    if (Array.isArray(value)) {
      const out: unknown[] = [];
      for (const v of value) out.push(await walk(v));
      return out;
    }
    if (value !== null && typeof value === "object") {
      const obj = value as Record<string, unknown>;
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(obj)) out[k] = await walk(v);
      return out;
    }
    return value;
  }

  const rewritten = (await walk(parsed)) as Record<string, unknown>;

  if (found === 0) {
    return { file, found: 0, rotated: 0, skipped: 0 };
  }

  if (opts.dryRun || rotated === 0) {
    return { file, found, rotated, skipped };
  }

  const serialized = TOML.stringify(rewritten as TOML.JsonMap);

  let backupPath: string | undefined;
  if (!opts.noBackup) {
    backupPath = `${file}.bak`;
    await atomicWriteFile(backupPath, raw);
  }
  await atomicWriteFile(file, serialized);

  return { file, found, rotated, skipped, backupPath };
}
