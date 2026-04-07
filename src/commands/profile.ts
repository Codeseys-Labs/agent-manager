import { defineCommand } from "citty";
import { join } from "node:path";
import {
  resolveConfigDir,
  readConfig,
  writeConfig,
  loadResolvedConfig,
  resolveProjectConfig,
} from "../core/config";
import { resolveProfile } from "../core/resolver";
import { commitAll } from "../core/git";
import { readActiveProfile } from "./use";
import { output, info, error } from "../lib/output";
import type { Config, Profile } from "../core/schema";

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
    const configDir = resolveConfigDir();
    const configPath = join(configDir, "config.toml");

    let config: Config;
    try {
      config = await readConfig(configPath);
    } catch {
      error("Config not found. Run `am init` first.", opts);
      return;
    }

    const profiles = config.profiles ?? {};
    const activeProfile =
      (await readActiveProfile(configDir)) ??
      config.settings?.default_profile ??
      "default";

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
    const configDir = resolveConfigDir();
    const projectFile = resolveProjectConfig(process.cwd());

    let config: Config;
    try {
      config = await loadResolvedConfig({ configDir, projectFile });
    } catch {
      error("Config not found. Run `am init` first.", opts);
      return;
    }

    let resolved;
    try {
      resolved = resolveProfile(args.name, config);
    } catch (err: any) {
      error(err.message, opts);
      return;
    }

    if (args.json) {
      output(resolved, opts);
      return;
    }

    info(`Profile: ${resolved.name}`, opts);
    info(`Servers: ${resolved.servers.length > 0 ? resolved.servers.join(", ") : "none"}`, opts);
    info(`Skills: ${resolved.skills.length > 0 ? resolved.skills.join(", ") : "none"}`, opts);
    info(`Instructions: ${resolved.instructions.length > 0 ? resolved.instructions.join(", ") : "none"}`, opts);

    const envEntries = Object.entries(resolved.env);
    if (envEntries.length > 0) {
      info(`Env:`, opts);
      for (const [k, v] of envEntries) {
        info(`  ${k}=${v}`, opts);
      }
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
    const configDir = resolveConfigDir();
    const configPath = join(configDir, "config.toml");

    let config: Config;
    try {
      config = await readConfig(configPath);
    } catch {
      error("Config not found. Run `am init` first.", opts);
      return;
    }

    const name = args.name;

    if (config.profiles?.[name]) {
      error(`Profile "${name}" already exists.`, opts);
      return;
    }

    // Validate parent exists if specified
    if (args.inherits && !config.profiles?.[args.inherits]) {
      error(`Parent profile "${args.inherits}" does not exist.`, opts);
      return;
    }

    const profile: Profile = {};
    if (args.description) profile.description = args.description;
    if (args.inherits) profile.inherits = args.inherits;

    if (!config.profiles) config.profiles = {};
    config.profiles[name] = profile;

    await writeConfig(configPath, config);

    try {
      await commitAll(configDir, `add profile: ${name}`);
    } catch {
      // Nothing to commit
    }

    info(`Created profile "${name}"`, opts);
    if (args.json) {
      output({ action: "create", profile: name, config: profile }, opts);
    }
  },
});

export const profileDeleteCommand = defineCommand({
  meta: { name: "delete", description: "Delete a profile" },
  args: {
    name: { type: "positional", description: "Profile name", required: true },
    json: { type: "boolean", description: "JSON output", default: false },
    quiet: { type: "boolean", alias: "q", default: false },
    verbose: { type: "boolean", alias: "v", default: false },
  },
  async run({ args }) {
    const opts = { json: args.json, quiet: args.quiet, verbose: args.verbose };
    const configDir = resolveConfigDir();
    const configPath = join(configDir, "config.toml");

    let config: Config;
    try {
      config = await readConfig(configPath);
    } catch {
      error("Config not found. Run `am init` first.", opts);
      return;
    }

    const name = args.name;

    if (!config.profiles?.[name]) {
      error(`Profile "${name}" does not exist.`, opts);
      return;
    }

    // Check if any other profile inherits from this one
    for (const [otherName, otherProfile] of Object.entries(config.profiles ?? {})) {
      if (otherProfile.inherits === name) {
        error(`Cannot delete "${name}": profile "${otherName}" inherits from it.`, opts);
        return;
      }
    }

    delete config.profiles[name];

    await writeConfig(configPath, config);

    try {
      await commitAll(configDir, `delete profile: ${name}`);
    } catch {
      // Nothing to commit
    }

    info(`Deleted profile "${name}"`, opts);
    if (args.json) {
      output({ action: "delete", profile: name }, opts);
    }
  },
});
