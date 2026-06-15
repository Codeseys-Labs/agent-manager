import { readFile } from "node:fs/promises";
import { join } from "node:path";
import * as TOML from "@iarna/toml";
import { defineCommand } from "citty";
import { listAdapters } from "../adapters/registry";
import { loadResolvedConfig, resolveConfigDir, resolveProjectConfig } from "../core/config";
import { resolveProfile } from "../core/resolver";
import { ConfigSchema } from "../core/schema";
import { AmError, errorMessage, isNotFound } from "../lib/errors";
import { amError, error, info, output, warn } from "../lib/output";
import { tomlStringify } from "../lib/toml";

export const configCommand = defineCommand({
  meta: { name: "config", description: "Manage agent-manager configuration" },
  subCommands: {
    validate: () => Promise.resolve(validateCommand),
    show: () => Promise.resolve(showCommand),
  },
});

export const validateCommand = defineCommand({
  meta: { name: "validate", description: "Validate config files" },
  args: {
    json: { type: "boolean", description: "JSON output", default: false },
    quiet: { type: "boolean", alias: "q", default: false },
    verbose: { type: "boolean", alias: "v", default: false },
  },
  async run({ args }) {
    const opts = { json: args.json, quiet: args.quiet, verbose: args.verbose };
    const configDir = resolveConfigDir();
    const configPath = join(configDir, "config.toml");
    const projectFile = resolveProjectConfig(process.cwd());

    const errors: string[] = [];
    const warnings: string[] = [];

    // Validate global config.toml
    try {
      const raw = await readFile(configPath, "utf-8");
      const parsed = TOML.parse(raw);
      const result = ConfigSchema.safeParse(parsed);

      if (!result.success) {
        for (const issue of result.error.issues) {
          errors.push(`config.toml: ${issue.path.join(".")}: ${issue.message}`);
        }
      } else {
        // Check for unknown adapter names
        const knownAdapters = listAdapters();
        if (result.data.adapters) {
          for (const name of Object.keys(result.data.adapters)) {
            if (!knownAdapters.includes(name)) {
              warnings.push(`Unknown adapter "${name}" in config.toml`);
            }
          }
        }
        // Check server-level adapters
        if (result.data.servers) {
          for (const [srvName, srv] of Object.entries(result.data.servers)) {
            if (srv.adapters) {
              for (const name of Object.keys(srv.adapters)) {
                if (!knownAdapters.includes(name)) {
                  warnings.push(`Unknown adapter "${name}" in server "${srvName}"`);
                }
              }
            }
          }
        }
        // Profile inheritance: the schema accepts circular / self-referential /
        // unknown-parent `inherits` chains, but resolveProfile throws on them.
        // Run the resolver per profile so `am validate` catches what only blows
        // up at apply/serve time (ws3-cdc6).
        if (result.data.profiles) {
          for (const name of Object.keys(result.data.profiles)) {
            try {
              resolveProfile(name, result.data);
            } catch (err: unknown) {
              errors.push(`config.toml: profiles.${name}: ${errorMessage(err)}`);
            }
          }
        }
      }
    } catch (err: unknown) {
      if (isNotFound(err)) {
        errors.push("config.toml not found. Run `am init` first.");
      } else {
        errors.push(`config.toml parse error: ${errorMessage(err)}`);
      }
    }

    // Validate project config if present
    if (projectFile) {
      try {
        const raw = await readFile(projectFile, "utf-8");
        const parsed = TOML.parse(raw);
        const { ProjectConfigSchema } = await import("../core/schema");
        const result = ProjectConfigSchema.safeParse(parsed);

        if (!result.success) {
          for (const issue of result.error.issues) {
            errors.push(`.agent-manager.toml: ${issue.path.join(".")}: ${issue.message}`);
          }
        }
      } catch (err: unknown) {
        errors.push(`.agent-manager.toml parse error: ${errorMessage(err)}`);
      }
    }

    const valid = errors.length === 0;

    if (args.json) {
      // Mirror the non-JSON branch: an invalid config sets a nonzero exit code.
      // Previously this branch returned before the exit-code logic below, so
      // `am validate --json` always exited 0 even when `valid: false`.
      if (!valid) process.exitCode = 1;
      output({ valid, errors, warnings }, opts);
      return;
    }

    if (valid) {
      info("Config is valid.", opts);
    } else {
      for (const e of errors) {
        error(e, opts);
      }
    }

    for (const w of warnings) {
      warn(w, opts);
    }

    if (!valid) {
      process.exitCode = 1;
    }
  },
});

export const showCommand = defineCommand({
  meta: { name: "show", description: "Show configuration" },
  args: {
    resolved: {
      type: "boolean",
      description: "Show fully resolved config after merge + profile resolution",
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
      const configPath = join(configDir, "config.toml");

      if (args.resolved) {
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

        if (args.json) {
          output(config, opts);
        } else {
          info(tomlStringify(config as Record<string, unknown>), opts);
        }
        return;
      }

      // Raw config
      try {
        const raw = await readFile(configPath, "utf-8");
        if (args.json) {
          const parsed = TOML.parse(raw);
          output(parsed, opts);
        } else {
          info(raw, opts);
        }
      } catch (err: unknown) {
        if (isNotFound(err)) {
          throw new AmError(
            "Config not found",
            "Run `am init` to initialize agent-manager",
            "CONFIG_NOT_FOUND",
          );
        }
        throw err;
      }
    } catch (err) {
      amError(err, opts);
      process.exitCode = 1;
    }
  },
});
