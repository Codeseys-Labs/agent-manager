import * as fs from "node:fs";
import { join } from "node:path";
import { defineCommand } from "citty";
import { getAdapter, listAdapters } from "../adapters/registry";
import { getBackupStats } from "../core/apply-backup";
import {
  buildResolvedConfig,
  resolveConfigDir,
  resolveProjectConfig,
  tryReadConfig,
} from "../core/config";
import { getStatus } from "../core/git";
import { resolveProfile } from "../core/resolver";
import { scanConfigForSecrets } from "../core/secret-detection";
import { isAnyEnvelope, legacyKeyPath, loadKey, resolveKeyPath } from "../core/secrets";
import { findMissingSkillAgentDeps } from "../core/skill-deps";
import { errorDetail, errorMessage } from "../lib/errors";
import { error, info, output } from "../lib/output";
import { redactSecretish } from "../lib/redact";
import { readActiveProfile } from "./use";

export interface Check {
  name: string;
  status: "ok" | "warn" | "fail";
  message: string;
}

export const LEGACY_PASSPHRASE_ENV_VARS = [
  "AM_TEAM_PASSPHRASE",
  "AGENT_MANAGER_TEAM_PASSPHRASE",
  "AM_SHARED_PASSPHRASE",
] as const;

export const TEAM_PASSPHRASE_CONFIG_PATTERNS = [
  /^\s*team_passphrase\s*=/m,
  /^\s*"team_passphrase"\s*=/m,
  /\bsecrets\.team_passphrase\s*=/,
  /\bsecrets\s*=\s*\{[^}]*\bteam_passphrase\b[^}]*\}/,
] as const;

export function hasLegacyTeamPassphraseConfig(raw: string): boolean {
  return TEAM_PASSPHRASE_CONFIG_PATTERNS.some((pattern) => pattern.test(raw));
}

/**
 * Render a byte count as a short human-readable string. Base-1000 (not
 * 1024) so test fixtures land on round values without floating-point
 * drift in expectations.
 */
function formatBytes(bytes: number): string {
  if (bytes < 1000) return `${bytes} B`;
  if (bytes < 1000 * 1000) return `${(bytes / 1000).toFixed(1)} KB`;
  return `${(bytes / (1000 * 1000)).toFixed(1)} MB`;
}

/**
 * Run the full agent-manager health check and return the raw `Check[]`.
 *
 * Extracted from the `doctor` command's `run` handler so other surfaces
 * (notably the `am setup` wizard's final green-health step) can run the same
 * checks without re-implementing them or shelling out. The command renders
 * these; the wizard inspects them and emits them in `--json` mode.
 *
 * @param configDir Resolved global config dir (callers pass `resolveConfigDir()`).
 * @param cwd Working directory used for project-config probes (defaults to `process.cwd()`).
 */
export async function collectDoctorChecks(
  configDir: string,
  cwd: string = process.cwd(),
): Promise<Check[]> {
  const checks: Check[] = [];

  // 1. Config directory exists
  try {
    fs.accessSync(configDir);
    checks.push({ name: "Config directory", status: "ok", message: configDir });
  } catch {
    checks.push({ name: "Config directory", status: "fail", message: `Not found: ${configDir}` });
  }

  // 2. Config directory is a git repo
  try {
    fs.accessSync(join(configDir, ".git"));
    checks.push({ name: "Git repository", status: "ok", message: "Initialized" });
  } catch {
    checks.push({
      name: "Git repository",
      status: "fail",
      message: "Not a git repo. Run `am init`.",
    });
  }

  // 3. config.toml is valid
  const configPath = join(configDir, "config.toml");
  try {
    const config = await tryReadConfig(configPath);
    if (config === null) {
      checks.push({ name: "config.toml", status: "fail", message: "Not found" });
    } else {
      checks.push({ name: "config.toml", status: "ok", message: "Valid" });
    }
  } catch (err: unknown) {
    // `tryReadConfig` always wraps parse/schema failures in a typed `AmError`
    // (CONFIG_PARSE_ERROR / CONFIG_SCHEMA_ERROR) — the raw `ZodError` never
    // reaches here anymore — so a single branch handles both. `errorDetail`
    // folds the AmError suggestion (which carries the offending field path,
    // e.g. a secret-shaped server name) back into the surfaced text, and
    // `redactSecretish` scrubs any echoed secret to a `[REDACTED_*]`
    // placeholder so the diagnostic stays useful without leaking credentials —
    // matching the MCP `am_doctor` path.
    checks.push({
      name: "config.toml",
      status: "fail",
      message: `Parse/validation error: ${redactSecretish(errorDetail(err))}`,
    });
  }

  // 4. Detected AI tools
  const adapterNames = listAdapters();
  for (const name of adapterNames) {
    const adapter = await getAdapter(name);
    if (!adapter) continue;
    const detection = await adapter.detect();
    if (detection.installed) {
      checks.push({
        name: `Adapter: ${adapter.meta.displayName}`,
        status: "ok",
        message: detection.version ? `v${detection.version}` : "Detected",
      });
    } else {
      checks.push({
        name: `Adapter: ${adapter.meta.displayName}`,
        status: "warn",
        message: "Not detected",
      });
    }
  }

  // 5. Git remote configured + ahead/behind
  try {
    const gitStatus = await getStatus(configDir);
    if (gitStatus.remotes.length > 0) {
      checks.push({
        name: "Git remote",
        status: "ok",
        message: gitStatus.remotes[0].url,
      });
    } else {
      checks.push({
        name: "Git remote",
        status: "warn",
        message: "No remote configured",
      });
    }
    if (!gitStatus.clean) {
      checks.push({
        name: "Working tree",
        status: "warn",
        message: `${gitStatus.dirty.length} uncommitted change(s)`,
      });
    } else {
      checks.push({ name: "Working tree", status: "ok", message: "Clean" });
    }
  } catch {
    checks.push({ name: "Git status", status: "warn", message: "Could not read git status" });
  }

  // 6. Encryption key (new location: OS data dir, NOT the git-tracked config dir)
  const keyPath = resolveKeyPath();
  try {
    fs.accessSync(keyPath);
    checks.push({ name: "Encryption key", status: "ok", message: `Present at ${keyPath}` });
  } catch {
    checks.push({
      name: "Encryption key",
      status: "warn",
      message: `Not found at ${keyPath} (secrets will not be encrypted)`,
    });
  }

  // 6b. Legacy key file inside git-tracked config dir — HIGH severity warn.
  // If present, it may have been (or may still be) committed to the user's remote.
  const legacyPath = legacyKeyPath(configDir);
  try {
    fs.accessSync(legacyPath);
    checks.push({
      name: "Legacy key location",
      status: "warn",
      message: `Found key at ${legacyPath} — this is INSIDE the git-tracked config dir. Delete it and ensure it has not been pushed to any remote. The active key now lives at ${keyPath}.`,
    });
  } catch {
    // Absent: good.
  }

  // 6c. Encryption integrity — encrypted envelopes present but key lost.
  //     The plain "Encryption key" check above (#6) only warns when the key
  //     is absent, which is benign when there are no secrets to decrypt. The
  //     hard-broken case is: encrypted envelopes (`enc:v1:`/`enc:v2:age:`)
  //     exist in the config but `loadKey` cannot produce a key — `am apply`
  //     then fails or leaks ciphertext, so this is a FAIL, not a warn.
  try {
    const integrityConfig = await tryReadConfig(join(configDir, "config.toml"));
    if (integrityConfig) {
      const envelopeBuckets: Array<Record<string, string> | undefined> = [
        integrityConfig.settings?.env,
      ];
      if (integrityConfig.servers) {
        for (const server of Object.values(integrityConfig.servers)) {
          envelopeBuckets.push(server.env);
        }
      }
      if (integrityConfig.profiles) {
        for (const profile of Object.values(integrityConfig.profiles)) {
          envelopeBuckets.push(profile.env);
        }
      }

      let envelopeCount = 0;
      for (const bucket of envelopeBuckets) {
        if (!bucket) continue;
        for (const value of Object.values(bucket)) {
          if (isAnyEnvelope(value)) envelopeCount += 1;
        }
      }

      if (envelopeCount > 0) {
        const key = await loadKey(configDir);
        if (key === null) {
          checks.push({
            name: "Encryption integrity",
            status: "fail",
            message: `${envelopeCount} encrypted secret(s) present but the key at ${keyPath} is missing/unreadable — secrets cannot be decrypted and \`am apply\` will fail or leak ciphertext. Restore the key or re-encrypt with a new one.`,
          });
        } else {
          checks.push({
            name: "Encryption integrity",
            status: "ok",
            message: `${envelopeCount} encrypted secret(s) present and the key at ${keyPath} loads`,
          });
        }
      }
      // No envelopes: nothing to decrypt — skip (a missing key is already a
      // benign warn via check #6, and we must not fail the common
      // no-secrets-no-key setup path).
    }
  } catch {
    // Config already validated above; a failure here is non-fatal.
  }

  // 7. Project config in cwd
  const projectFile = resolveProjectConfig(cwd);
  if (projectFile) {
    checks.push({ name: "Project config", status: "ok", message: projectFile });
  } else {
    checks.push({
      name: "Project config",
      status: "warn",
      message: "No .agent-manager.toml in current directory tree",
    });
  }

  // 8. Enterprise/managed config files
  const managedPaths = [
    join(configDir, "config.managed.toml"),
    join(configDir, "config.enterprise.toml"),
  ];
  for (const mp of managedPaths) {
    try {
      fs.accessSync(mp);
      const name = mp.split("/").pop()!;
      checks.push({
        name: "Managed config",
        status: "warn",
        message: `${name} detected — may override local settings`,
      });
    } catch {
      // Not present, fine
    }
  }

  // 8b. ADR-0046: best-effort regex scan for the `team_passphrase`
  //     anti-pattern in raw config and legacy environment variables. The
  //     schema validator (src/core/schema.ts) is the canonical defense for
  //     newly-loaded configs; this scan also catches configs that fail other
  //     validation first, project-level `.agent-manager.toml` files, and
  //     managed/enterprise files that may not otherwise be loaded here.
  //
  //     Covered TOML shapes: bare keys (`team_passphrase = "x"`), quoted
  //     bare keys (`"team_passphrase" = "x"`), dotted secrets keys
  //     (`settings.secrets.team_passphrase = "x"`), and simple inline
  //     secrets tables (`secrets = { team_passphrase = "x" }`). This is not
  //     a TOML parser and may miss exotic/multiline forms; schema validation
  //     remains the authoritative gate.
  try {
    const configsToScan: string[] = [];
    const globalConfigPath = join(configDir, "config.toml");
    try {
      fs.accessSync(globalConfigPath);
      configsToScan.push(globalConfigPath);
    } catch {
      // Skip if absent.
    }
    const projectConfigPath = resolveProjectConfig(cwd);
    if (projectConfigPath && projectConfigPath !== globalConfigPath) {
      configsToScan.push(projectConfigPath);
    }
    // Managed/enterprise configs may override local settings; scan them too.
    for (const mp of [
      join(configDir, "config.managed.toml"),
      join(configDir, "config.enterprise.toml"),
    ]) {
      try {
        fs.accessSync(mp);
        if (!configsToScan.includes(mp)) configsToScan.push(mp);
      } catch {
        // Not present, skip.
      }
    }

    const teamPassphraseFiles: string[] = [];
    for (const filePath of configsToScan) {
      try {
        const raw = fs.readFileSync(filePath, "utf-8");
        if (hasLegacyTeamPassphraseConfig(raw)) {
          teamPassphraseFiles.push(filePath);
        }
      } catch {
        // Read-fail is non-fatal; secret-audit check below catches gross issues.
      }
    }

    const envHints: string[] = [];
    for (const envName of LEGACY_PASSPHRASE_ENV_VARS) {
      if (process.env[envName]) envHints.push(envName);
    }

    if (teamPassphraseFiles.length > 0) {
      checks.push({
        name: "Team passphrase (ADR-0046)",
        status: "fail",
        message: `team_passphrase field found in: ${teamPassphraseFiles.join(", ")}. This anti-pattern is rejected by ADR-0046. Migrate to per-recipient X25519 identities: have each teammate run \`am pair accept\` (then you \`am pair finalize\`) to add their recipient, then re-encrypt secrets with \`am secrets rewrap\`.`,
      });
    } else if (envHints.length > 0) {
      checks.push({
        name: "Team passphrase (ADR-0046)",
        status: "warn",
        message: `Legacy shared-passphrase env var(s) set: ${envHints.join(", ")}. These are not used by current am, but their presence suggests a legacy shared-passphrase setup. See ADR-0046; migrate to per-recipient identities.`,
      });
    } else {
      checks.push({
        name: "Team passphrase (ADR-0046)",
        status: "ok",
        message: "No shared-passphrase anti-pattern detected",
      });
    }
  } catch {
    // Defensive: if scan errors, surface a soft warning rather than failing doctor.
    checks.push({
      name: "Team passphrase (ADR-0046)",
      status: "warn",
      message: "Could not complete team_passphrase scan",
    });
  }

  // 9. Secret audit — scan servers for unencrypted secrets
  try {
    const configPath = join(configDir, "config.toml");
    const configForScan = await tryReadConfig(configPath);
    if (configForScan?.servers) {
      const scanResults = await scanConfigForSecrets(configForScan.servers);
      const totalSecrets = scanResults.reduce((sum, r) => sum + r.secrets.length, 0);
      if (totalSecrets > 0) {
        checks.push({
          name: "Secret audit",
          status: "warn",
          message: `${totalSecrets} potential unencrypted secret(s) found (run \`am secret scan\` to review)`,
        });
      } else {
        checks.push({
          name: "Secret audit",
          status: "ok",
          message: "No unencrypted secrets detected in server configs",
        });
      }
    }
  } catch {
    // Config already checked above, skip silently
  }

  // 9b. Skill → agent dependency closure (R2/297e, ws6-skill-deps-missing-agent).
  //     A skill body (SKILL.md) may delegate to a named subagent via
  //     `Task(subagent_type='...')`. If the catalog provides no matching agent
  //     the skill is broken at runtime, so flag each dangling reference.
  try {
    const configForDeps = await tryReadConfig(join(configDir, "config.toml"));
    if (configForDeps) {
      // Resolve the SAME catalog `am status` does: honor the persisted active
      // profile first (ws-c7d6-doctor-active-profile / R2-7), falling back to
      // default_profile, then "default". status.ts uses this exact precedence —
      // if doctor only read default_profile the two commands could disagree on
      // which catalog they check.
      const profileName =
        (await readActiveProfile(configDir)) ??
        (configForDeps.settings?.default_profile as string | undefined) ??
        "default";
      const resolved = buildResolvedConfig(configForDeps, profileName, configDir);
      const missingDeps = findMissingSkillAgentDeps(resolved);
      if (missingDeps.length > 0) {
        const detail = missingDeps
          .map((d) => `skill ${d.skill} references missing agent ${d.agent}`)
          .join("; ");
        checks.push({
          name: "Skill dependencies",
          status: "warn",
          message: `${missingDeps.length} skill→agent reference(s) point to an absent agent: ${detail}. Add the agent(s) to the catalog or fix the skill's Task(subagent_type=...) reference.`,
        });
      } else {
        checks.push({
          name: "Skill dependencies",
          status: "ok",
          message: "All skill agent references resolve to catalog agents",
        });
      }
    }
  } catch {
    // Config already validated above; a failure here is non-fatal.
  }

  // 9c. Profile inheritance closure (ws3-cdc6). ConfigSchema accepts a config
  //     whose profiles inherit in a circle (a→b→a), self-reference (a→a), or
  //     point at an unknown parent — but resolveProfile (the resolver the
  //     gateway and `am apply` rely on) throws on all three. Run it per profile
  //     so doctor surfaces the defect instead of letting it blow up later.
  try {
    const configForInherit = await tryReadConfig(join(configDir, "config.toml"));
    if (configForInherit?.profiles) {
      const inheritErrors: string[] = [];
      for (const name of Object.keys(configForInherit.profiles)) {
        try {
          resolveProfile(name, configForInherit);
        } catch (err: unknown) {
          inheritErrors.push(`${name}: ${errorMessage(err)}`);
        }
      }
      if (inheritErrors.length > 0) {
        checks.push({
          name: "Profile inheritance",
          status: "fail",
          message: `${inheritErrors.length} profile(s) fail to resolve: ${inheritErrors.join("; ")}. Fix the \`inherits\` chain (no cycles, self-references, or unknown parents).`,
        });
      } else {
        checks.push({
          name: "Profile inheritance",
          status: "ok",
          message: "All profiles resolve (no inheritance cycles or unknown parents)",
        });
      }
    }
  } catch {
    // Config already validated above; a failure here is non-fatal.
  }

  // 10. Betterleaks scanner
  const { isBetterleaksAvailable, getBetterleaksVersion } = await import("../core/betterleaks");
  if (isBetterleaksAvailable()) {
    const version = getBetterleaksVersion();
    checks.push({
      name: "Secret scanner",
      status: "ok",
      message: `betterleaks ${version ?? "installed"}`,
    });
  } else {
    checks.push({
      name: "Secret scanner",
      status: "warn",
      message: "betterleaks not installed (run `am secret install-scanner` for enhanced scanning)",
    });
  }

  // 11. Apply backups (AM_APPLY_BACKUP) — surface state + size warning.
  const backupEnv = process.env.AM_APPLY_BACKUP;
  const backupEnabled = backupEnv === "1" || backupEnv === "true";
  if (!backupEnabled) {
    checks.push({
      name: "Apply backups",
      status: "ok",
      message: "Disabled (set AM_APPLY_BACKUP=1 to enable)",
    });
  } else {
    try {
      const stats = await getBackupStats();
      if (stats.totalBackups === 0) {
        checks.push({ name: "Apply backups", status: "ok", message: "Enabled, no backups yet" });
      } else {
        const sizeText = formatBytes(stats.totalBytes);
        const base = `${stats.targets} target(s), ${stats.totalBackups} backup(s), ${sizeText}`;
        if (stats.totalBytes > 100 * 1024 * 1024) {
          checks.push({
            name: "Apply backups",
            status: "warn",
            message: `${base} — consider pruning`,
          });
        } else {
          checks.push({ name: "Apply backups", status: "ok", message: base });
        }
      }
    } catch (err) {
      checks.push({
        name: "Apply backups",
        status: "warn",
        message: `Could not read backup stats: ${errorMessage(err)}`,
      });
    }
  }

  return checks;
}

export const doctorCommand = defineCommand({
  meta: { name: "doctor", description: "Health check for agent-manager" },
  args: {
    json: { type: "boolean", description: "JSON output", default: false },
    quiet: { type: "boolean", alias: "q", default: false },
    verbose: { type: "boolean", alias: "v", default: false },
  },
  async run({ args }) {
    const opts = { json: args.json, quiet: args.quiet, verbose: args.verbose };
    const configDir = resolveConfigDir();
    const checks = await collectDoctorChecks(configDir);

    // Output
    const hasFailures = checks.some((c) => c.status === "fail");
    const hasWarnings = checks.some((c) => c.status === "warn");
    const healthy = !hasFailures;

    if (args.json) {
      // Mirror the non-JSON branch: failures set a nonzero exit code, warnings
      // do not. Previously this branch returned before any exit-code logic, so
      // `am doctor --json` always exited 0 even when `healthy: false`.
      if (hasFailures) process.exitCode = 1;
      output({ healthy, checks }, opts);
      return;
    }

    const icons: Record<string, string> = { ok: "+", warn: "!", fail: "x" };
    for (const check of checks) {
      info(`  [${icons[check.status]}] ${check.name}: ${check.message}`, opts);
    }

    info("", opts);
    if (hasFailures) {
      info("Health check: FAIL", opts);
      process.exitCode = 1;
    } else if (hasWarnings) {
      info("Health check: OK (with warnings)", opts);
    } else {
      info("Health check: OK", opts);
    }
  },
});
