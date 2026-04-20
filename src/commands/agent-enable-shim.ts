/**
 * CLI: am agent enable-shim <name> — opt in to a Tier-2 shim-wrapped agent.
 *
 * Flips two flags in the catalog for the named agent:
 *   1. [agents.<name>].shim_enabled = true            (bookkeeping)
 *   2. [agents.<name>].acp.command = "am-acp-shell <name>"
 *                                                    (so resolveAgent() picks
 *                                                    the config override and
 *                                                    routes `am run` through
 *                                                    the shim)
 *
 * Then prints the ADR-0033 security caveat: Tier-2 wrappers inherit the
 * wrapped CLI's trust posture — `--yes`, `--no-interactive`, etc. bypass
 * am's permission UI. The user MUST pass `--yes` to skip the interactive
 * confirmation prompt (or we error out in non-interactive stdin).
 */

import { defineCommand } from "citty";
import { resolveConfigDir } from "../core/config";
import { withConfig } from "../core/controller";
import type { Config } from "../core/schema";
import { error, info, output } from "../lib/output";
import { BUILT_IN_SHIMS } from "../protocols/acp/shell-wrapper";

const SECURITY_CAVEAT = [
  "───────────────────────────────────────────────────────────────",
  "  Tier-2 shim wrapper — security caveat (ADR-0033)",
  "───────────────────────────────────────────────────────────────",
  "  Tier-2 wrapped agents inherit the trust posture of the underlying",
  "  CLI. am does NOT interpose on permissions — if the wrapped flags",
  "  auto-approve (e.g. `--yes`, `--no-interactive`), every file",
  "  mutation the agent requests proceeds without am's approval UI.",
  "",
  "  Use Tier 2 only with agents whose auto-approve mode you trust in",
  "  your environment. To disable: remove [agents.<name>] from your",
  "  config.toml.",
  "───────────────────────────────────────────────────────────────",
].join("\n");

export const agentEnableShimCommand = defineCommand({
  meta: {
    name: "enable-shim",
    description: "Opt in to a Tier-2 acp-shell wrapped agent (aider, amazon-q, cody, ...)",
  },
  args: {
    name: {
      type: "positional",
      description: "Shim name (must be in BUILT_IN_SHIMS)",
      required: true,
    },
    yes: {
      type: "boolean",
      description: "Skip the interactive security-caveat confirmation prompt",
      default: false,
    },
    json: { type: "boolean", description: "JSON output", default: false },
    quiet: { type: "boolean", alias: "q", default: false },
    verbose: { type: "boolean", alias: "v", default: false },
  },
  async run({ args }) {
    const opts = { json: args.json, quiet: args.quiet, verbose: args.verbose };
    const name = args.name as string;

    // 1. Validate name against the shim registry.
    if (!BUILT_IN_SHIMS[name]) {
      const known = Object.keys(BUILT_IN_SHIMS).join(", ");
      error(
        `Unknown shim "${name}". Known shims: ${known}. See ADR-0033 Phase B for how to add one.`,
        opts,
      );
      process.exitCode = 1;
      return;
    }

    // 2. Show the caveat and require --yes (or an interactive confirmation).
    if (!args.yes) {
      if (opts.json) {
        // JSON callers (scripts) must pass --yes explicitly; we don't pop a prompt.
        error("Enabling a shim requires --yes in JSON mode (cannot prompt on stdin).", opts);
        process.exitCode = 2;
        return;
      }
      info(SECURITY_CAVEAT, opts);
      info("", opts);
      info(
        `Re-run with --yes to enable the shim for "${name}":\n  am agent enable-shim ${name} --yes`,
        opts,
      );
      process.exitCode = 2;
      return;
    }

    // 3. Flip the flag in the user's config.toml via withConfig (REV-4 HIGH-3:
    //    was raw writeConfig, now serialized through configMutex to match
    //    REV-1 MEDIUM-2).
    //
    // REV-4 CRIT-1 fix: write the shim command to `agents.<name>.acp.command`
    // DIRECTLY, not nested under `adapters.acp.command`. resolveAgent() in
    // core/agent-registry.ts reads ConfigAgentEntry.acp — which is a direct
    // property of the agent entry. The old `adapters.acp` path was silently
    // ignored by resolveAgent, so enable-shim "succeeded" but `am run <name>`
    // still returned the tier-3 refusal.
    const configDir = resolveConfigDir();
    const configPath = await withConfig(configDir, async (existing) => {
      const draft = existing ?? ({} as Config);
      const agentsBlock: Record<string, Record<string, unknown>> = {
        ...((draft.agents ?? {}) as Record<string, Record<string, unknown>>),
      };
      const entry: Record<string, unknown> = { ...(agentsBlock[name] ?? {}) };
      entry.name = name;
      entry.shim_enabled = true;
      // Write to the path resolveAgent actually reads.
      entry.acp = { command: `am-acp-shell ${name}` };
      agentsBlock[name] = entry;

      const next: Config = {
        ...draft,
        agents: agentsBlock as unknown as Config["agents"],
      };

      return {
        result: `${configDir}/config.toml`,
        changed: true,
        updated: next,
        commitMessage: `agent: enable shim for ${name}`,
      };
    });

    if (opts.json) {
      output(
        {
          action: "enable-shim",
          name,
          shim_command: `am-acp-shell ${name}`,
          config_path: configPath,
        },
        opts,
      );
      return;
    }

    info(SECURITY_CAVEAT, opts);
    info("", opts);
    info(`Enabled shim for "${name}".`, opts);
    info(`  Config updated: ${configPath}`, opts);
    info(`  Shim command:   am-acp-shell ${name}`, opts);
    info("", opts);
    info(`Try it: am run ${name} "hello"`, opts);
  },
});
