import * as fs from "node:fs";
import { join } from "node:path";
import { defineCommand } from "citty";
import { ZodError } from "zod";
import { getAdapter, listAdapters } from "../adapters/registry";
import { resolveConfigDir, resolveProjectConfig, tryReadConfig } from "../core/config";
import { getStatus } from "../core/git";
import { error, info, output } from "../lib/output";

interface Check {
  name: string;
  status: "ok" | "warn" | "fail";
  message: string;
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
    } catch (err: any) {
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
          message: `Parse error: ${err.message}`,
        });
      }
    }

    // 4. Detected AI tools
    const adapterNames = listAdapters();
    for (const name of adapterNames) {
      const adapter = await getAdapter(name);
      if (!adapter) continue;
      const detection = adapter.detect();
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

    // 6. Encryption key
    const keyPath = join(configDir, ".agent-manager", "key.txt");
    try {
      fs.accessSync(keyPath);
      checks.push({ name: "Encryption key", status: "ok", message: "Present" });
    } catch {
      checks.push({
        name: "Encryption key",
        status: "warn",
        message: "Not found (secrets will not be encrypted)",
      });
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
