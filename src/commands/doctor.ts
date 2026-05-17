import * as fs from "node:fs";
import { join } from "node:path";
import { defineCommand } from "citty";
import { ZodError } from "zod";
import { getAdapter, listAdapters } from "../adapters/registry";
import { getBackupStats } from "../core/apply-backup";
import { resolveConfigDir, resolveProjectConfig, tryReadConfig } from "../core/config";
import { getStatus } from "../core/git";
import { scanConfigForSecrets } from "../core/secret-detection";
import { legacyKeyPath, resolveKeyPath } from "../core/secrets";
import { errorMessage } from "../lib/errors";
import { error, info, output } from "../lib/output";

interface Check {
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
      if (err instanceof ZodError) {
        const issues = err.issues
          .map(
            (i: { path: (string | number)[]; message: string }) =>
              `${i.path.join(".")}: ${i.message}`,
          )
          .join("; ");
        checks.push({
          name: "config.toml",
          status: "fail",
          message: `Validation errors: ${issues}`,
        });
      } else {
        checks.push({
          name: "config.toml",
          status: "fail",
          message: `Parse error: ${errorMessage(err)}`,
        });
      }
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

    // 7. Project config in cwd
    const projectFile = resolveProjectConfig(process.cwd());
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
      const projectConfigPath = resolveProjectConfig(process.cwd());
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
          message: `team_passphrase field found in: ${teamPassphraseFiles.join(", ")}. This anti-pattern is rejected by ADR-0046. Migrate to per-recipient X25519 identities: run \`am secrets add-recipient <pubkey>\` for each team member, then re-encrypt secrets with \`am secrets rewrap\`.`,
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
        message:
          "betterleaks not installed (run `am secret install-scanner` for enhanced scanning)",
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

    // Output
    const hasFailures = checks.some((c) => c.status === "fail");
    const hasWarnings = checks.some((c) => c.status === "warn");
    const healthy = !hasFailures;

    if (args.json) {
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
