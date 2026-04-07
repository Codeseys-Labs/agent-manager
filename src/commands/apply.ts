import { defineCommand } from "citty";
import { join } from "node:path";
import {
  resolveConfigDir,
  loadResolvedConfig,
  resolveProjectConfig,
} from "../core/config";
import { readActiveProfile } from "./use";
import { getDetectedAdapters, getAdapter, listAdapters } from "../adapters/registry";
import { output, info, error, debug } from "../lib/output";
import type { ResolvedConfig, ResolvedServer } from "../adapters/types";

function buildResolvedConfig(
  config: Awaited<ReturnType<typeof loadResolvedConfig>>,
  profileName: string,
): ResolvedConfig {
  const servers: Record<string, ResolvedServer> = {};
  for (const [name, srv] of Object.entries(config.servers ?? {})) {
    servers[name] = {
      name,
      command: srv.command,
      args: srv.args ?? [],
      env: srv.env ?? {},
      transport: srv.transport ?? "stdio",
      description: srv.description ?? "",
      tags: srv.tags ?? [],
      enabled: srv.enabled ?? true,
      adapters: (srv.adapters as Record<string, Record<string, unknown>>) ?? {},
    };
  }
  return {
    servers,
    instructions: {},
    skills: {},
    profile: profileName,
    adapters: (config.adapters as Record<string, Record<string, unknown>>) ?? {},
  };
}

export const applyCommand = defineCommand({
  meta: { name: "apply", description: "Generate native configs for detected tools" },
  args: {
    "dry-run": { type: "boolean", description: "Preview changes without writing", default: false },
    diff: { type: "boolean", description: "Show diff before applying", default: false },
    force: { type: "boolean", description: "Overwrite even if drifted", default: false },
    target: { type: "string", description: "Apply to specific adapter only" },
    profile: { type: "string", description: "Override active profile" },
    json: { type: "boolean", description: "JSON output", default: false },
    quiet: { type: "boolean", alias: "q", default: false },
    verbose: { type: "boolean", alias: "v", default: false },
  },
  async run({ args }) {
    const opts = { json: args.json, quiet: args.quiet, verbose: args.verbose };
    const configDir = resolveConfigDir();
    const projectFile = resolveProjectConfig(process.cwd());

    let config;
    try {
      config = await loadResolvedConfig({ configDir, projectFile });
    } catch {
      error("Config not found. Run `am init` first.", opts);
      process.exitCode = 1;
      return;
    }

    // Determine profile
    const profileName =
      args.profile ??
      (await readActiveProfile(configDir)) ??
      config.settings?.default_profile ??
      "default";

    const resolved = buildResolvedConfig(config, profileName);

    // Find adapters to apply
    let adapters;
    if (args.target) {
      const adapter = await getAdapter(args.target);
      if (!adapter) {
        const available = listAdapters();
        if (args.json) {
          console.error(JSON.stringify({
            error: `Adapter "${args.target}" not found`,
            suggestion: `Available adapters: ${available.join(", ")}`,
          }));
        } else {
          console.error(`error: Adapter "${args.target}" not found`);
          console.error(`  available: ${available.join(", ")}`);
        }
        process.exitCode = 1;
        return;
      }
      adapters = [adapter];
    } else {
      adapters = await getDetectedAdapters();
    }

    if (adapters.length === 0) {
      info("No tools detected. Nothing to apply.", opts);
      return;
    }

    const results: Array<{ adapter: string; files: Array<{ path: string; written: boolean }>; warnings: string[] }> = [];

    for (const adapter of adapters) {
      debug(`Applying to ${adapter.meta.displayName}...`, opts);

      if (args.diff) {
        try {
          const diffResult = adapter.diff(resolved);
          if (diffResult.status === "in-sync") {
            info(`${adapter.meta.displayName}: in sync`, opts);
          } else {
            info(`${adapter.meta.displayName}: ${diffResult.changes.length} change(s)`, opts);
            for (const change of diffResult.changes) {
              info(`  ${change.type}: ${change.entity} "${change.name}"`, opts);
            }
          }
        } catch {
          debug(`${adapter.meta.displayName}: diff not available`, opts);
        }
      }

      try {
        const result = adapter.export(resolved, {
          projectPath: projectFile ? join(projectFile, "..") : undefined,
          dryRun: args["dry-run"],
        });

        results.push({
          adapter: adapter.meta.name,
          files: result.files.map((f) => ({ path: f.path, written: f.written })),
          warnings: result.warnings,
        });

        if (!args["dry-run"]) {
          info(`${adapter.meta.displayName}: wrote ${result.files.filter((f) => f.written).length} file(s)`, opts);
        } else {
          info(`${adapter.meta.displayName}: would write ${result.files.length} file(s)`, opts);
          for (const f of result.files) {
            info(`  ${f.path}`, opts);
          }
        }

        for (const w of result.warnings) {
          info(`  warning: ${w}`, opts);
        }
      } catch (e: any) {
        const msg = e?.message ?? "export failed";
        info(`${adapter.meta.displayName}: ${msg}`, opts);
        results.push({ adapter: adapter.meta.name, files: [], warnings: [msg] });
      }
    }

    if (args.json) {
      output({ action: "apply", profile: profileName, dryRun: args["dry-run"], results }, opts);
    }
  },
});
