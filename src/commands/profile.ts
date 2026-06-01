import { join } from "node:path";
import { confirm, isCancel } from "@clack/prompts";
import { defineCommand } from "citty";
import {
  loadResolvedConfig,
  resolveConfigDir,
  resolveProjectConfig,
  tryReadConfig,
} from "../core/config";
import { withConfig } from "../core/controller";
import { resolveProfile } from "../core/resolver";
import type { Config, Profile } from "../core/schema";
import { AmError, errorMessage, requireConfig } from "../lib/errors";
import { amError, error, info, output } from "../lib/output";
import { readActiveProfile } from "./use";

export const profileCommand = defineCommand({
  meta: { name: "profile", description: "Manage profiles" },
  subCommands: {
    list: () => Promise.resolve(profileListCommand),
    show: () => Promise.resolve(profileShowCommand),
    create: () => Promise.resolve(profileCreateCommand),
    delete: () => Promise.resolve(profileDeleteCommand),
  },
});

export const profileListCommand = defineCommand({
  meta: { name: "list", description: "List all profiles" },
  args: {
    json: { type: "boolean", description: "JSON output", default: false },
    quiet: { type: "boolean", alias: "q", default: false },
    verbose: { type: "boolean", alias: "v", default: false },
  },
  async run({ args }) {
    const opts = { json: args.json, quiet: args.quiet, verbose: args.verbose };
    try {
      const configDir = resolveConfigDir();
      const configPath = join(configDir, "config.toml");

      const config = await tryReadConfig(configPath);
      requireConfig(config);

      const profiles = config.profiles ?? {};
      const activeProfile =
        (await readActiveProfile(configDir)) ?? config.settings?.default_profile ?? "default";

      const entries = Object.entries(profiles).map(([name, profile]) => ({
        name,
        description: profile.description ?? "",
        inherits: profile.inherits ?? null,
        active: name === activeProfile,
      }));

      if (args.json) {
        output({ profiles: entries, activeProfile }, opts);
        return;
      }

      if (entries.length === 0) {
        info("No profiles configured.", opts);
        return;
      }

      info(`${"Name".padEnd(20)} ${"Inherits".padEnd(15)} ${"Description"}`, opts);
      info(`${"─".repeat(20)} ${"─".repeat(15)} ${"─".repeat(30)}`, opts);
      for (const p of entries) {
        const marker = p.active ? " *" : "";
        info(
          `${(p.name + marker).padEnd(20)} ${(p.inherits ?? "—").padEnd(15)} ${p.description}`,
          opts,
        );
      }
      info(`\n${entries.length} profile(s), active: ${activeProfile}`, opts);
    } catch (err) {
      amError(err, opts);
      process.exitCode = 1;
    }
  },
});

export const profileShowCommand = defineCommand({
  meta: { name: "show", description: "Show resolved config for a profile" },
  args: {
    name: { type: "positional", description: "Profile name", required: true },
    json: { type: "boolean", description: "JSON output", default: false },
    quiet: { type: "boolean", alias: "q", default: false },
    verbose: { type: "boolean", alias: "v", default: false },
  },
  async run({ args }) {
    const opts = { json: args.json, quiet: args.quiet, verbose: args.verbose };
    try {
      const configDir = resolveConfigDir();
      const projectFile = resolveProjectConfig(process.cwd());

      let config: Config;
      try {
        config = await loadResolvedConfig({ configDir, projectFile });
      } catch {
        throw new AmError(
          "Config not found",
          "Run `am init` to initialize agent-manager",
          "CONFIG_NOT_FOUND",
        );
      }

      const resolved = resolveProfile(args.name, config);

      if (args.json) {
        output(resolved, opts);
        return;
      }

      info(`Profile: ${resolved.name}`, opts);
      info(`Servers: ${resolved.servers.length > 0 ? resolved.servers.join(", ") : "none"}`, opts);
      info(`Skills: ${resolved.skills.length > 0 ? resolved.skills.join(", ") : "none"}`, opts);
      info(
        `Instructions: ${resolved.instructions.length > 0 ? resolved.instructions.join(", ") : "none"}`,
        opts,
      );

      const envEntries = Object.entries(resolved.env);
      if (envEntries.length > 0) {
        info("Env:", opts);
        for (const [k, v] of envEntries) {
          info(`  ${k}=${v}`, opts);
        }
      }
    } catch (err) {
      amError(err, opts);
      process.exitCode = 1;
    }
  },
});

export const profileCreateCommand = defineCommand({
  meta: { name: "create", description: "Create a new profile" },
  args: {
    name: { type: "positional", description: "Profile name", required: true },
    inherits: { type: "string", description: "Parent profile to inherit from" },
    description: { type: "string", description: "Profile description" },
    json: { type: "boolean", description: "JSON output", default: false },
    quiet: { type: "boolean", alias: "q", default: false },
    verbose: { type: "boolean", alias: "v", default: false },
  },
  async run({ args }) {
    const opts = { json: args.json, quiet: args.quiet, verbose: args.verbose };
    try {
      const configDir = resolveConfigDir();
      const name = args.name;

      // REV-1 MEDIUM-2: serialize RMW via withConfig (was raw read → writeConfig).
      await withConfig(configDir, async (config) => {
        requireConfig(config);

        if (config.profiles?.[name]) {
          process.exitCode = 1;
          error(`Profile "${name}" already exists.`, opts);
          return { result: undefined, changed: false };
        }

        // Validate parent exists if specified
        if (args.inherits && !config.profiles?.[args.inherits]) {
          process.exitCode = 1;
          error(`Parent profile "${args.inherits}" does not exist.`, opts);
          return { result: undefined, changed: false };
        }

        const profile: Profile = {};
        if (args.description) profile.description = args.description;
        if (args.inherits) profile.inherits = args.inherits;

        if (!config.profiles) config.profiles = {};
        config.profiles[name] = profile;

        info(`Created profile "${name}"`, opts);
        if (args.json) {
          output({ action: "create", profile: name, config: profile }, opts);
        }

        return {
          result: undefined,
          changed: true,
          commitMessage: `add profile: ${name}`,
        };
      });
    } catch (err) {
      amError(err, opts);
      process.exitCode = 1;
    }
  },
});

export const profileDeleteCommand = defineCommand({
  meta: { name: "delete", description: "Delete a profile" },
  args: {
    name: { type: "positional", description: "Profile name", required: true },
    yes: { type: "boolean", alias: "y", default: false },
    json: { type: "boolean", description: "JSON output", default: false },
    quiet: { type: "boolean", alias: "q", default: false },
    verbose: { type: "boolean", alias: "v", default: false },
  },
  async run({ args }) {
    const opts = { json: args.json, quiet: args.quiet, verbose: args.verbose };
    try {
      const configDir = resolveConfigDir();
      const name = args.name;

      // REV-1 MEDIUM-2: serialize RMW via withConfig (was raw read → writeConfig).
      await withConfig(configDir, async (config) => {
        requireConfig(config);

        if (!config.profiles?.[name]) {
          process.exitCode = 1;
          error(`Profile "${name}" does not exist.`, opts);
          return { result: undefined, changed: false };
        }

        // Check if any other profile inherits from this one
        for (const [otherName, otherProfile] of Object.entries(config.profiles ?? {})) {
          if (otherProfile.inherits === name) {
            process.exitCode = 1;
            error(`Cannot delete "${name}": profile "${otherName}" inherits from it.`, opts);
            return { result: undefined, changed: false };
          }
        }

        // Confirmation prompt. Skipped (and the delete proceeds) when --yes is
        // passed OR when running non-interactively (--json or no TTY), matching
        // the codebase convention used by `am uninstall`/`am update`. This
        // keeps the command from hanging on a prompt in scripts/CI; the change
        // is recoverable via `am undo` (withConfig auto-commits).
        if (!args.yes && !args.json && process.stdin.isTTY) {
          const confirmed = await confirm({
            message: `Delete profile '${name}'? This cannot be undone.`,
          });
          if (isCancel(confirmed) || !confirmed) {
            info("Aborted.", opts);
            return { result: undefined, changed: false };
          }
        }

        delete config.profiles[name];

        info(`Deleted profile "${name}"`, opts);
        if (args.json) {
          output({ action: "delete", profile: name }, opts);
        }

        return {
          result: undefined,
          changed: true,
          commitMessage: `delete profile: ${name}`,
        };
      });
    } catch (err) {
      amError(err, opts);
      process.exitCode = 1;
    }
  },
});
