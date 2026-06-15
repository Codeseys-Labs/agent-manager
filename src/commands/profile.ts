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
import { buildScopeManifest, resolveProfile } from "../core/resolver";
import { DEFAULT_MCP_TOOL_GROUPS, MCP_TOOL_GROUPS } from "../core/schema";
import type { Config, McpToolGroup, Profile, ProfileScope } from "../core/schema";
import { AmError, errorMessage, requireConfig } from "../lib/errors";
import { amError, error, info, output } from "../lib/output";
import { toolGroupCatalog } from "../mcp/server";
import { readActiveProfile } from "./use";

export const profileCommand = defineCommand({
  meta: { name: "profile", description: "Manage profiles" },
  subCommands: {
    list: () => Promise.resolve(profileListCommand),
    show: () => Promise.resolve(profileShowCommand),
    create: () => Promise.resolve(profileCreateCommand),
    delete: () => Promise.resolve(profileDeleteCommand),
    scope: () => Promise.resolve(profileScopeCommand),
  },
});

/**
 * Parse a comma-separated CLI value into a trimmed, de-duped, non-empty list.
 * Returns `undefined` for an absent flag (distinct from an empty list, which
 * carries meaning for `tool_groups`: an explicit empty narrows every group out).
 */
function parseCsv(raw: unknown): string[] | undefined {
  if (typeof raw !== "string") return undefined;
  const out: string[] = [];
  for (const part of raw.split(",")) {
    const t = part.trim();
    if (t.length > 0 && !out.includes(t)) out.push(t);
  }
  return out;
}

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
    tools: {
      type: "boolean",
      description: "Show the MCP tool-access scope this profile grants (ADR-0055)",
      default: false,
    },
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

      // ADR-0055 Decision 6: `--tools` prints the effective MCP access Scope —
      // the git-diffable manifest of which tools this profile exposes — built
      // via the SAME isToolInScope the gateway enforces (buildScopeManifest), so
      // the explanation can never drift from enforcement.
      if (args.tools) {
        const ceiling = config.settings?.mcp_serve?.tools ?? DEFAULT_MCP_TOOL_GROUPS;
        const catalog = toolGroupCatalog();
        const manifest = buildScopeManifest(resolved.name, catalog, ceiling, resolved.scope);
        if (args.json) {
          output(manifest, opts);
          return;
        }
        info(`Profile: ${manifest.profile} — MCP tool scope`, opts);
        info(`Ceiling (settings.mcp_serve.tools): ${manifest.ceiling.join(", ")}`, opts);
        if (!manifest.scoped) {
          info("Scope: none declared — this profile exposes the full ceiling.", opts);
        } else {
          info(
            `Scope groups: ${manifest.toolGroups ? manifest.toolGroups.join(", ") || "(none)" : "(inherit ceiling)"}`,
            opts,
          );
          if (manifest.allowTools.length > 0)
            info(`Allow: ${manifest.allowTools.join(", ")}`, opts);
          if (manifest.denyTools.length > 0) info(`Deny: ${manifest.denyTools.join(", ")}`, opts);
        }
        info(
          `Effective tools (${manifest.effectiveTools.length}): ${manifest.effectiveTools.join(", ") || "none"}`,
          opts,
        );
        info(
          `Excluded (${manifest.excludedTools.length}): ${manifest.excludedTools.join(", ") || "none"}`,
          opts,
        );
        return;
      }

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

        // Confirmation prompt.
        // FAIL CLOSED: deleting a profile is destructive, so it must never
        // proceed unconfirmed. When confirmation is required (no --yes) but we
        // cannot interactively prompt (non-TTY stdin: scripts, CI, piped input)
        // and --json was not passed (the structured/automation contract),
        // REFUSE rather than silently deleting. The previous
        // `&& process.stdin.isTTY` guard failed OPEN — under a non-TTY it
        // skipped the prompt and deleted the profile without consent. This now
        // matches the fail-closed convention used by `am uninstall`/`am update`;
        // operators in non-TTY contexts must pass --yes.
        if (!args.yes && !args.json) {
          if (!process.stdin.isTTY) {
            process.exitCode = 1;
            error(
              `Refusing to delete profile "${name}" without confirmation. stdin is not a TTY — pass --yes to confirm non-interactively.`,
              opts,
            );
            return { result: undefined, changed: false };
          }
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

export const profileScopeCommand = defineCommand({
  meta: {
    name: "scope",
    description: "Set a profile's runtime MCP tool-access scope (ADR-0055)",
  },
  args: {
    name: { type: "positional", description: "Profile name", required: true },
    "tool-groups": {
      type: "string",
      description: `Comma-separated tool groups to allow (${MCP_TOOL_GROUPS.join(", ")})`,
    },
    "allow-tools": {
      type: "string",
      description: "Comma-separated individual tool names to allow",
    },
    "deny-tools": {
      type: "string",
      description: "Comma-separated individual tool names to deny (deny wins)",
    },
    clear: {
      type: "boolean",
      description: "Remove the scope entirely (profile exposes the full ceiling)",
      default: false,
    },
    json: { type: "boolean", description: "JSON output", default: false },
    quiet: { type: "boolean", alias: "q", default: false },
    verbose: { type: "boolean", alias: "v", default: false },
  },
  async run({ args }) {
    const opts = { json: args.json, quiet: args.quiet, verbose: args.verbose };
    try {
      const configDir = resolveConfigDir();
      const name = args.name;

      // Parse + VALIDATE the inputs BEFORE opening the RMW transaction. An
      // unknown tool group must fail CLOSED — we abort with a nonzero exit and
      // commit nothing rather than writing a partial/widened scope (SECURITY:
      // an invalid group can never silently alter the runtime access boundary).
      const toolGroups = parseCsv(args["tool-groups"]);
      const allowTools = parseCsv(args["allow-tools"]);
      const denyTools = parseCsv(args["deny-tools"]);

      if (toolGroups !== undefined) {
        const valid = new Set<string>(MCP_TOOL_GROUPS);
        const unknown = toolGroups.filter((g) => !valid.has(g));
        if (unknown.length > 0) {
          process.exitCode = 1;
          error(
            `Unknown tool group(s): ${unknown.join(", ")}. Valid groups: ${MCP_TOOL_GROUPS.join(", ")}.`,
            opts,
          );
          return;
        }
      }

      // Fail CLOSED when no scope is specified and --clear is absent. An empty
      // `scope = {}` resolves to scopeDeclared=true with toolGroups=undefined,
      // which isToolInScope evaluates as the FULL ceiling — so writing it would
      // silently WIDEN a previously-narrowed profile (e.g. tool_groups=["core"])
      // back to everything. That contradicts the command's invariant and is a
      // fail-open hole in the keystone access-control write surface. Require an
      // explicit scope or an explicit --clear; commit nothing otherwise.
      if (
        !args.clear &&
        toolGroups === undefined &&
        allowTools === undefined &&
        denyTools === undefined
      ) {
        process.exitCode = 1;
        error(
          "Specify at least one of --tool-groups / --allow-tools / --deny-tools, or use --clear to remove the scope.",
          opts,
        );
        return;
      }

      await withConfig(configDir, async (config) => {
        requireConfig(config);

        if (!config.profiles?.[name]) {
          process.exitCode = 1;
          error(`Profile "${name}" does not exist.`, opts);
          return { result: undefined, changed: false };
        }

        if (args.clear) {
          if (config.profiles[name].scope === undefined) {
            info(`Profile "${name}" has no scope to clear.`, opts);
            if (args.json) output({ profile: name, scope: null, action: "clear" }, opts);
            return { result: undefined, changed: false };
          }
          // Reconstruct without `scope` rather than `delete` (lint/noDelete) or
          // `scope = undefined` (the @iarna/toml serializer rejects undefined
          // values). Dropping the key entirely restores the global-ceiling
          // default for this profile.
          const { scope: _dropped, ...rest } = config.profiles[name];
          config.profiles[name] = rest;
          info(`Cleared scope for profile "${name}"`, opts);
          if (args.json) output({ profile: name, scope: null, action: "clear" }, opts);
          return {
            result: undefined,
            changed: true,
            commitMessage: `set profile scope: ${name}`,
          };
        }

        // Build the scope, dropping empty arrays so we never persist noise.
        // `tool_groups` is preserved even when empty (an explicit empty list is
        // a meaningful deny-all-groups boundary), but parseCsv only yields an
        // empty array if the flag was passed as an empty string.
        const scope: ProfileScope = {};
        if (toolGroups !== undefined) scope.tool_groups = toolGroups as McpToolGroup[];
        if (allowTools && allowTools.length > 0) scope.allow_tools = allowTools;
        if (denyTools && denyTools.length > 0) scope.deny_tools = denyTools;

        config.profiles[name].scope = scope;

        info(`Set scope for profile "${name}"`, opts);
        if (args.json) output({ profile: name, scope, action: "scope" }, opts);

        return {
          result: undefined,
          changed: true,
          commitMessage: `set profile scope: ${name}`,
        };
      });
    } catch (err) {
      amError(err, opts);
      process.exitCode = 1;
    }
  },
});
