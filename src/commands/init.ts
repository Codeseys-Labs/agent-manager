import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import * as clack from "@clack/prompts";
import { defineCommand } from "citty";
import { getDetectedAdapters } from "../adapters/registry";
import { resolveConfigDir, serializeConfig } from "../core/config";
import { withConfig } from "../core/controller";
import { addRemote, initRepo } from "../core/git";
import type { Config } from "../core/schema";
import { generateKey, resolveKeyPath, saveKey } from "../core/secrets";
import { AmError, errorMessage } from "../lib/errors";
import { type OutputOptions, error, info, output } from "../lib/output";
import { initProject } from "./init-project";

/**
 * Serialized read-modify-write for the first-run / already-initialized decision.
 *
 * Returns `true` when a fresh config was initialized (caller proceeds with
 * detect/key/remote next-steps), `false` when a valid config already exists
 * (already-initialized message emitted, exit code set). A CORRUPT existing
 * config (malformed TOML / schema violation) propagates the typed AmError
 * thrown by `tryReadConfig` so the caller can render an actionable message
 * instead of a raw stack — see the `run` handler's catch.
 *
 * REV-1 MEDIUM-2: serialize RMW via withConfig (was raw tryReadConfig +
 * writeConfig). initRepo is only run on the first-run path because it is not
 * idempotent (it makes an "init" commit).
 */
async function runInitRmw(
  configDir: string,
  configPath: string,
  args: { json: boolean },
  opts: OutputOptions,
): Promise<boolean> {
  return withConfig(
    configDir,
    async (existing) => {
      if (existing) {
        process.exitCode = 1;
        if (args.json) {
          output({ status: "already_initialized", configDir }, opts);
        } else {
          error(`Already initialized. Config exists at ${configPath}`, opts);
        }
        return { result: false, changed: false };
      }

      const newConfig: Config = {
        settings: { default_profile: "default" },
        servers: {},
        profiles: {
          default: {
            description: "Default profile — all servers",
          },
        },
      };

      // First-run: initialize the git repo under the lock so concurrent
      // `am init` invocations can't race on `git init`.
      //
      // ws3 brownfield-wipe fix: initRepo now folds config.toml INTO its
      // single "init: agent-manager repository" commit (alongside
      // .gitignore) — we render the same TOML withConfig would write and
      // hand it to initRepo. This guarantees the baseline tree CONTAINS
      // config.toml, so a later `am undo` (revertHead) restores to a
      // config.toml-bearing parent instead of unlinking it (the wipe-out
      // chain: init → add → undo → apply --force wrote empty {} over a
      // populated native config).
      //
      // CRITICAL INVARIANT: this remains exactly ONE commit. withConfig
      // is invoked with `noCommit: true`, so the file it writes to disk
      // (identical bytes to what initRepo committed) is NOT turned into a
      // second commit — `am undo` right after `am init` still correctly
      // reports "Nothing to undo" (it requires log length >= 2 to act).
      await initRepo(configDir, { configToml: serializeConfig(newConfig) });

      return {
        result: true,
        changed: true,
        updated: newConfig,
        // commitMessage intentionally omitted — withConfig's noCommit
        // option (below) short-circuits the commit path regardless, but
        // leaving this undefined makes the intent explicit.
      };
    },
    { noCommit: true },
  );
}

export const initCommand = defineCommand({
  meta: { name: "init", description: "Initialize agent-manager config and git repo" },
  args: {
    project: {
      type: "boolean",
      description: "Scan workspace for AI tool configs and create .agent-manager.toml",
      default: false,
    },
    json: { type: "boolean", description: "JSON output", default: false },
    yes: {
      type: "boolean",
      alias: "y",
      description:
        "Non-interactive: accept defaults, skip all prompts (key + remote skipped unless flagged)",
      default: false,
    },
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
    // Non-interactive when explicitly requested (--yes/--json/--quiet) or when
    // there is no TTY (CI, pipes, Docker RUN). Prompts are gated on this so a
    // scripted `am init` never hangs and `--yes` is an honest, declared flag.
    const interactive = !args.yes && !args.json && !args.quiet && Boolean(process.stdin.isTTY);

    // --project mode: scan workspace and create .agent-manager.toml
    if (args.project) {
      const projectPath = process.cwd();
      info("Scanning workspace for AI tool configs...", opts);
      await initProject(projectPath, opts);
      return;
    }

    const configDir = resolveConfigDir();
    const configPath = join(configDir, "config.toml");

    // Create the config dir (idempotent) up front so withConfig's
    // tryReadConfig has a stable path to probe.
    await mkdir(configDir, { recursive: true });

    // runInitRmw probes the existing config via tryReadConfig. A MISSING
    // config returns null (first-run path → wasInitialized=true); a VALID
    // existing one short-circuits with wasInitialized=false (already-init
    // message emitted, exit code set); a CORRUPT one (malformed TOML or schema
    // violation) now throws a typed AmError (CONFIG_PARSE_ERROR /
    // CONFIG_SCHEMA_ERROR) instead of being collapsed to "not found". Catch
    // that here and emit an actionable message rather than propagating a raw
    // stack. We do NOT auto-delete or overwrite the file — the user owns it.
    let wasInitialized: boolean;
    try {
      wasInitialized = await runInitRmw(configDir, configPath, args, opts);
    } catch (err) {
      if (
        err instanceof AmError &&
        (err.code === "CONFIG_PARSE_ERROR" || err.code === "CONFIG_SCHEMA_ERROR")
      ) {
        const reason = err.suggestion ? `${err.message} (${err.suggestion})` : err.message;
        process.exitCode = 1;
        if (args.json) {
          output(
            {
              status: "corrupt_config",
              configDir,
              configPath,
              code: err.code,
              reason,
            },
            opts,
          );
        } else {
          error(
            `Existing config at ${configPath} is corrupt: ${reason}. Fix it by hand or remove it, then re-run am init`,
            opts,
          );
        }
        return;
      }
      throw err;
    }

    if (!wasInitialized) {
      return;
    }

    // Detect installed tools
    const detected = await getDetectedAdapters();
    const detectedNames = detected.map((a) => a.meta.displayName);

    // Offer encryption key generation (interactive only, not in JSON/quiet mode)
    let keyGenerated = false;
    if (interactive) {
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
    if (interactive) {
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
    // `am init` only detects + inits the git repo — it does NOT import or
    // apply. Spell out the full chain so a fresh user is never stranded at a
    // dead end (the "init → ??? → working configs" friction). For most people
    // `am setup` is the right one-shot path; init's next-steps point there
    // first, then give the granular commands for users who chose init on
    // purpose. Importing alone changes nothing on disk — `am apply` is what
    // renders the native IDE config files, so it's always named explicitly.
    if (detectedNames.length > 0) {
      info(`Detected tools: ${detectedNames.join(", ")}`, opts);
      info("Next steps:", opts);
      info(
        "  am setup                     # guided one-shot: import + key + profile + apply",
        opts,
      );
      info("  — or do it by hand —", opts);
      info("  am import auto               # import the detected tools' existing configs", opts);
      info(
        "  am apply                     # render native config files (import alone writes nothing)",
        opts,
      );
    } else {
      // Novice first-run recovery (2026-05-03-E, per Codex-B audit): when
      // no adapters detect, silence is a dead end. Suggest the commands most
      // likely to produce immediate value, led by the guided wizard.
      info("No supported tools detected yet. Try one of:", opts);
      info("  am setup                     # guided first-run wizard (safe to re-run)", opts);
      info("  am agent list --runnable     # see which built-in agents work now", opts);
      info("  am search <query>            # find an MCP server in the Registry", opts);
      info("  am add server <name> --command <cmd>   # add an MCP server by hand", opts);
      info("  am apply                     # after adding anything, render native configs", opts);
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
