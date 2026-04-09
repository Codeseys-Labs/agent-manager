import { defineCommand } from "citty";
import { getDetectedAdapters } from "../adapters/registry";
import { buildResolvedConfig, loadResolvedConfig, resolveConfigDir, resolveProjectConfig } from "../core/config";
import { getStatus } from "../core/git";
import { debug, error, info, output } from "../lib/output";
import { readActiveProfile } from "./use";

export const statusCommand = defineCommand({
  meta: { name: "status", description: "Show config and drift status" },
  args: {
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

    const profileName =
      (await readActiveProfile(configDir)) ?? config.settings?.default_profile ?? "default";

    // Git status
    let gitStatus;
    try {
      gitStatus = await getStatus(configDir);
    } catch {
      gitStatus = { branch: "unknown", clean: true, dirty: [], remotes: [] };
    }

    const resolved = buildResolvedConfig(config, profileName);
    const serverCount = Object.keys(resolved.servers).length;

    // Adapter drift
    const adapters = await getDetectedAdapters();
    const toolStatuses: Array<{ name: string; status: string; changes: number }> = [];

    for (const adapter of adapters) {
      try {
        const diffResult = adapter.diff(resolved);
        toolStatuses.push({
          name: adapter.meta.displayName,
          status: diffResult.status,
          changes: diffResult.changes.length,
        });
      } catch {
        toolStatuses.push({
          name: adapter.meta.displayName,
          status: "unknown",
          changes: 0,
        });
      }
    }

    if (args.json) {
      output(
        {
          profile: profileName,
          servers: serverCount,
          git: {
            branch: gitStatus.branch,
            clean: gitStatus.clean,
            dirty: gitStatus.dirty,
            remotes: gitStatus.remotes,
          },
          tools: toolStatuses,
        },
        opts,
      );
      return;
    }

    info(`Profile: ${profileName}`, opts);
    info(`Servers: ${serverCount}`, opts);
    info(
      `Git: ${gitStatus.branch} (${gitStatus.clean ? "clean" : `${gitStatus.dirty.length} dirty`})`,
      opts,
    );

    if (gitStatus.remotes.length > 0) {
      info(`Remote: ${gitStatus.remotes[0].url}`, opts);
    } else {
      info("Remote: none (add a remote URL to your config repo to set up sync)", opts);
    }

    if (toolStatuses.length > 0) {
      info("\nTool Status:", opts);
      for (const t of toolStatuses) {
        const statusStr =
          t.status === "in-sync"
            ? "in sync"
            : t.status === "drifted"
              ? `drift detected (${t.changes} change${t.changes !== 1 ? "s" : ""})`
              : t.status;
        info(`  ${t.name.padEnd(20)} ${statusStr}`, opts);
      }
    }
  },
});
