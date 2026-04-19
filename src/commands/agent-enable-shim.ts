/**
 * CLI: am agent enable-shim <name> — opt in to a Tier-2 shim-wrapped agent.
 *
 * Flips two flags in the catalog for the named agent:
 *   1. [agents.<name>].shim_enabled = true            (bookkeeping)
 *   2. [agents.<name>].adapters.acp.command = "am-acp-shell <name>"
 *                                                    (so `am run` resolves
 *                                                    the agent through the shim)
 *
 * Then prints the ADR-0033 security caveat: Tier-2 wrappers inherit the
 * wrapped CLI's trust posture — `--yes`, `--no-interactive`, etc. bypass
 * am's permission UI. The user MUST pass `--yes` to skip the interactive
 * confirmation prompt (or we error out in non-interactive stdin).
 */

import { join } from "node:path";
import { defineCommand } from "citty";
import { resolveConfigDir, tryReadConfig, writeConfig } from "../core/config";
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
    name: { type: "positional", description: "Shim name (must be in BUILT_IN_SHIMS)", required: true },
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
        error(
          "Enabling a shim requires --yes in JSON mode (cannot prompt on stdin).",
          opts,
        );
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

    // 3. Flip the flag in the user's config.toml.
    const configDir = resolveConfigDir();
    const configPath = join(configDir, "config.toml");
    const existing = (await tryReadConfig(configPath)) ?? ({} as Config);

    const agentsBlock: Record<string, Record<string, unknown>> = {
      ...((existing.agents ?? {}) as Record<string, Record<string, unknown>>),
    };
    const entry: Record<string, unknown> = { ...(agentsBlock[name] ?? {}) };
    entry.name = name;
    entry.shim_enabled = true;
    const adapters: Record<string, Record<string, unknown>> = {
      ...((entry.adapters as Record<string, Record<string, unknown>> | undefined) ?? {}),
    };
    adapters.acp = {
      ...((adapters.acp as Record<string, unknown> | undefined) ?? {}),
      command: `am-acp-shell ${name}`,
    };
    entry.adapters = adapters;
    agentsBlock[name] = entry;

    const next: Config = {
      ...existing,
      agents: agentsBlock as unknown as Config["agents"],
    };
    await writeConfig(configPath, next);

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
