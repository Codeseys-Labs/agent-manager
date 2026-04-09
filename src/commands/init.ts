import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { defineCommand } from "citty";
import { getDetectedAdapters } from "../adapters/registry";
import { resolveConfigDir, tryReadConfig, writeConfig } from "../core/config";
import { initRepo } from "../core/git";
import type { Config } from "../core/schema";
import { error, info, output } from "../lib/output";
import { initProject } from "./init-project";

export const initCommand = defineCommand({
  meta: { name: "init", description: "Initialize agent-manager config and git repo" },
  args: {
    project: {
      type: "boolean",
      description: "Scan workspace for AI tool configs and create .agent-manager.toml",
      default: false,
    },
    json: { type: "boolean", description: "JSON output", default: false },
    quiet: {
      type: "boolean",
      alias: "q",
      description: "Suppress non-essential output",
      default: false,
    },
    verbose: { type: "boolean", alias: "v", description: "Verbose output", default: false },
  },
  async run({ args }) {
    const opts = { json: args.json, quiet: args.quiet, verbose: args.verbose };

    // --project mode: scan workspace and create .agent-manager.toml
    if (args.project) {
      const projectPath = process.cwd();
      info("Scanning workspace for AI tool configs...", opts);
      await initProject(projectPath, opts);
      return;
    }

    const configDir = resolveConfigDir();
    const configPath = join(configDir, "config.toml");

    // Check if already initialized
    const existing = await tryReadConfig(configPath);
    if (existing) {
      if (args.json) {
        output({ status: "already_initialized", configDir }, opts);
      } else {
        error(`Already initialized. Config exists at ${configPath}`, opts);
      }
      return;
    }

    // Create config directory
    await mkdir(configDir, { recursive: true });

    // Initialize git repo
    await initRepo(configDir);

    // Write initial config
    const config: Config = {
      settings: { default_profile: "default" },
      servers: {},
      profiles: {
        default: {
          description: "Default profile — all servers",
        },
      },
    };
    await writeConfig(configPath, config);

    // Detect installed tools
    const detected = await getDetectedAdapters();
    const detectedNames = detected.map((a) => a.meta.displayName);

    info(`Initialized agent-manager at ${configDir}`, opts);
    if (detectedNames.length > 0) {
      info(`Detected tools: ${detectedNames.join(", ")}`, opts);
      info("Run `am import auto` to import existing configs", opts);
    }

    if (args.json) {
      output(
        {
          status: "initialized",
          configDir,
          configPath,
          detectedTools: detectedNames,
        },
        opts,
      );
    }
  },
});
