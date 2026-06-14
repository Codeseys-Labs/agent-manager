import { defineCommand } from "citty";
import { getDetectedAdapters } from "../adapters/registry";
import {
  buildResolvedConfig,
  loadResolvedConfig,
  resolveConfigDir,
  resolveProjectConfig,
} from "../core/config";
import { getStatus } from "../core/git";
import { findMissingSkillAgentDeps } from "../core/skill-deps";
import { AmError } from "../lib/errors";
import { amError, debug, info, output } from "../lib/output";
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
    try {
      const configDir = resolveConfigDir();
      const projectFile = resolveProjectConfig(process.cwd());

      let config;
      try {
        config = await loadResolvedConfig({ configDir, projectFile });
      } catch {
        throw new AmError(
          "Config not found",
          "Run `am init` to initialize agent-manager",
          "CONFIG_NOT_FOUND",
        );
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

      const resolved = buildResolvedConfig(config, profileName, configDir);
      const serverCount = Object.keys(resolved.servers).length;

      // Skill → agent dependency closure (R2/297e, ws6-skill-deps-missing-agent).
      // A skill body (SKILL.md) can delegate to a named subagent via
      // `Task(subagent_type='...')`. If the catalog has no matching agent the
      // skill is broken at runtime, so surface each dangling reference here.
      const missingDeps = findMissingSkillAgentDeps(resolved);

      // Adapter drift. A `diff()` delta has two flavors that status must NOT
      // conflate: REAL drift (native-side changes — added-locally /
      // removed-locally / modified — the apply would clobber) vs catalog-ahead
      // `added-in-config` entries (e.g. right after `am add server`) that a bare
      // `am apply` simply writes. The latter is pending work, not divergence, so
      // we split the change count and only label genuine drift as
      // "drift detected". (ws4-drift-relabel-catalog-ahead)
      const adapters = await getDetectedAdapters();
      const toolStatuses: Array<{
        name: string;
        status: string;
        changes: number;
        pending: number;
        drift: number;
      }> = [];

      for (const adapter of adapters) {
        try {
          const diffResult = await adapter.diff(resolved);
          const pending = diffResult.changes.filter((c) => c.type === "added-in-config").length;
          const drift = diffResult.changes.length - pending;
          toolStatuses.push({
            name: adapter.meta.displayName,
            status: diffResult.status,
            changes: diffResult.changes.length,
            pending,
            drift,
          });
        } catch {
          toolStatuses.push({
            name: adapter.meta.displayName,
            status: "unknown",
            changes: 0,
            pending: 0,
            drift: 0,
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
            "missing-deps": missingDeps,
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
          let statusStr: string;
          if (t.status === "in-sync") {
            statusStr = "in sync";
          } else if (t.status === "drifted") {
            // Split real drift from catalog-ahead pending entries. A delta that
            // is ONLY pending (catalog has servers/instructions the tool doesn't
            // yet — e.g. after `am add server`) is NOT drift: a bare `am apply`
            // writes it. Report it as "N to add" instead of alarming the user
            // with "drift detected". (ws4-drift-relabel-catalog-ahead)
            const parts: string[] = [];
            if (t.drift > 0) {
              parts.push(`drift detected (${t.drift} change${t.drift !== 1 ? "s" : ""})`);
            }
            if (t.pending > 0) {
              parts.push(`${t.pending} to add`);
            }
            statusStr = parts.length > 0 ? parts.join(", ") : "in sync";
          } else {
            statusStr = t.status;
          }
          info(`  ${t.name.padEnd(20)} ${statusStr}`, opts);
        }
      }

      if (missingDeps.length > 0) {
        info("\nSkill dependencies:", opts);
        for (const dep of missingDeps) {
          info(`  skill ${dep.skill} references missing agent ${dep.agent}`, opts);
        }
      }
    } catch (err) {
      amError(err, opts);
      process.exitCode = 1;
    }
  },
});
