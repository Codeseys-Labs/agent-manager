import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import * as clack from "@clack/prompts";
import { defineCommand } from "citty";
import { getDetectedAdapters } from "../adapters/registry";
import { resolveConfigDir } from "../core/config";
import { withConfig } from "../core/controller";
import { addRemote, initRepo } from "../core/git";
import type { Config } from "../core/schema";
import { generateKey, resolveKeyPath, saveKey } from "../core/secrets";
import { errorMessage } from "../lib/errors";
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

    // REV-1 MEDIUM-2: serialize RMW via withConfig (was raw tryReadConfig + writeConfig).
    // The initialize-if-absent path returns { changed: true, updated: newConfig };
    // the already-initialized path short-circuits with { changed: false }
    // after setting exitCode. Create the config dir (idempotent) up front so
    // withConfig's tryReadConfig has a stable path to probe. initRepo is only
    // run on the first-run path because it is not idempotent (it makes an
    // "init" commit).
    await mkdir(configDir, { recursive: true });

    const wasInitialized = await withConfig(configDir, async (existing) => {
      if (existing) {
        process.exitCode = 1;
        if (args.json) {
          output({ status: "already_initialized", configDir }, opts);
        } else {
          error(`Already initialized. Config exists at ${configPath}`, opts);
        }
        return { result: false, changed: false };
      }

      // First-run: initialize the git repo under the lock so concurrent
      // `am init` invocations can't race on `git init`.
      await initRepo(configDir);

      const newConfig: Config = {
        settings: { default_profile: "default" },
        servers: {},
        profiles: {
          default: {
            description: "Default profile — all servers",
          },
        },
      };

      return {
        result: true,
        changed: true,
        updated: newConfig,
        commitMessage: "initial commit",
      };
    });

    if (!wasInitialized) {
      return;
    }

    // Detect installed tools
    const detected = await getDetectedAdapters();
    const detectedNames = detected.map((a) => a.meta.displayName);

    // Offer encryption key generation (interactive only, not in JSON/quiet mode)
    let keyGenerated = false;
    if (!args.json && !args.quiet && process.stdin.isTTY) {
      const setupKey = await clack.confirm({
        message: "Generate an encryption key for secrets?",
        initialValue: true,
      });
      if (!clack.isCancel(setupKey) && setupKey) {
        const base64Key = await generateKey();
        await saveKey(configDir, base64Key);
        keyGenerated = true;
        info(`Encryption key saved to ${resolveKeyPath()} (outside git-tracked config dir)`, opts);
        info("Use `am secret set <name> <value>` to encrypt secrets", opts);
      }
    }

    // Offer remote setup (interactive only)
    let remoteConfigured: string | null = null;
    if (!args.json && !args.quiet && process.stdin.isTTY) {
      const remoteUrl = await clack.text({
        message: "Git remote URL for sync (leave empty to skip):",
        placeholder: "https://github.com/user/agent-manager-config.git",
      });

      if (
        remoteUrl &&
        !clack.isCancel(remoteUrl) &&
        typeof remoteUrl === "string" &&
        remoteUrl.trim()
      ) {
        try {
          await addRemote(configDir, remoteUrl.trim());
          remoteConfigured = remoteUrl.trim();
          info(`Remote "origin" set to ${remoteUrl.trim()}`, opts);
        } catch (err) {
          info(
            `Could not set remote: ${errorMessage(err)}. Set it later with: git -C ${configDir} remote add origin <url>`,
            opts,
          );
        }
      }
    }

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
          keyGenerated,
          remoteConfigured,
        },
        opts,
      );
    }
  },
});
