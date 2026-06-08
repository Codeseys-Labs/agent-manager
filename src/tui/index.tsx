import React from "react";
import { render } from "silvery";
import { getDetectedAdapters } from "../adapters/registry.ts";
import { writeActiveProfile } from "../commands/use.ts";
import { resolveConfigDir } from "../core/config.ts";
import { APPLY_SAFE_DEFAULTS, applyResolved, withConfig } from "../core/controller.ts";
import { pull, push } from "../core/git.ts";
import { errorMessage } from "../lib/errors.ts";
import { App } from "./App.tsx";
import { loadTuiData } from "./data.ts";

/**
 * SEC-4c (Wave B apply-follow): the TUI apply call path, extracted as a pure,
 * testable function so the fail-closed drift gate can be exercised without
 * rendering the React tree.
 *
 * The TUI apply button was STILL fail-open before this — it called
 * `applyResolved(configDir)` with NO diff/force, so a button press silently
 * OVERWROTE a drifted native config (the exact overwrite class SEC-4b closed on
 * the MCP/web surfaces; the 2026-04-15 `~/.claude.json` wipe lineage). It now
 * derives `diff` from the SHARED APPLY_SAFE_DEFAULTS so the gate fires by
 * default: a drifted (or unreadable-drift) adapter is SKIPPED, not overwritten.
 * The returned summary names the skipped tools and points at the `F` (force)
 * key, matching the CLI `--force` / MCP `force=true` / web `{ force: true }`
 * opt-in. `force=true` overwrites on purpose.
 */
export async function runTuiApply(configDir: string, force = false): Promise<string> {
  const result = await applyResolved(configDir, {
    diff: APPLY_SAFE_DEFAULTS.diff,
    force: force || APPLY_SAFE_DEFAULTS.force,
  });
  const wrote = result.succeeded.length;
  if (result.skipped.length > 0) {
    // Fail-closed gate fired. Tell the user exactly which tools were NOT
    // written and how to overwrite on purpose (consistent with the CLI's
    // "rerun with --force" guidance).
    return `Applied to ${wrote} tool(s); SKIPPED ${result.skipped.length} drifted: ${result.skipped.join(", ")}. Press [F] to force-overwrite.`;
  }
  if (result.failed.length > 0) {
    const names = result.failed.map((f) => f.adapter).join(", ");
    return `Applied to ${wrote} tool(s); ${result.failed.length} failed: ${names}.`;
  }
  return `Apply complete — wrote ${wrote} tool(s)${force ? " (forced)" : ""}.`;
}

export async function launchTui(): Promise<void> {
  // Workaround for Bun + Ink TTY issues: resume stdin before render
  if (process.stdin.isTTY) {
    process.stdin.resume();
  }

  let data;
  try {
    data = await loadTuiData();
  } catch (err: any) {
    console.error(`Failed to load config: ${err.message}`);
    console.error("Run `am init` to set up agent-manager first.");
    process.exitCode = 1;
    return;
  }

  const configDir = resolveConfigDir();

  const handleProfileSwitch = async (profile: string) => {
    await writeActiveProfile(configDir, profile);
  };

  const handleSync = async () => {
    await pull(configDir);
  };

  const handlePush = async () => {
    try {
      await push(configDir);
      return "Pushed to remote";
    } catch (err: any) {
      return `Push failed: ${err.message}`;
    }
  };

  const handleAddServer = async () => {
    return "Use `am add server <name>` from CLI to add servers";
  };

  // REV-4 MEDIUM-2 continuation: TUI mutation sites were the last callers
  // doing raw `writeConfig()` without the controller mutex. Every RMW now
  // flows through `withConfig`, matching the 8 CLI surfaces that landed in
  // REV-1 MEDIUM-2 (install / uninstall / update / profile create / profile
  // delete / init / marketplace install / marketplace uninstall).
  //
  // The TUI's React state is not held under the lock — we compute the
  // next-state value inside `withConfig` and return it as the handler
  // result, then the component updates state after the lock releases.
  const handleRemoveServer = async (serverName: string): Promise<string> => {
    try {
      return await withConfig<string>(configDir, async (config) => {
        if (!config) {
          return {
            result: "No config found — run `am init` first.",
            changed: false,
          };
        }
        if (!config.servers?.[serverName]) {
          return {
            result: `Server "${serverName}" not found`,
            changed: false,
          };
        }
        delete config.servers[serverName];
        return {
          result: `Removed server "${serverName}"`,
          changed: true,
          commitMessage: `remove server: ${serverName}`,
        };
      });
    } catch (err) {
      return `Remove failed: ${errorMessage(err)}`;
    }
  };

  const handleImport = async (): Promise<string> => {
    try {
      const adapters = await getDetectedAdapters();
      if (adapters.length === 0) return "No tools detected to import from";

      return await withConfig<string>(configDir, async (existing) => {
        if (!existing) {
          return {
            result: "No config found — run `am init` first.",
            changed: false,
          };
        }
        const config = existing;
        if (!config.servers) config.servers = {};

        let imported = 0;
        for (const adapter of adapters) {
          try {
            const result = await adapter.import({});
            for (const srv of result.servers) {
              if (!config.servers[srv.name]) {
                config.servers[srv.name] = {
                  command: srv.command,
                  args: srv.args,
                  env: srv.env,
                  transport: srv.transport ?? "stdio",
                  description: srv.description,
                  tags: srv.tags,
                  enabled: srv.enabled ?? true,
                };
                imported++;
              }
            }
          } catch {
            /* skip failing adapters */
          }
        }

        if (imported === 0) {
          return {
            result: `No new servers found in ${adapters.length} detected tool(s)`,
            changed: false,
          };
        }

        // Secret detection + encryption (runs under the lock so a second
        // importer can't race on settings.env writes).
        const { scanConfigForSecrets, substituteSecret, pickEnvVarName } = await import(
          "../core/secret-detection.ts"
        );
        const {
          loadKey: loadEncKey,
          encryptValue,
          generateKey,
          importKey,
          saveKey,
        } = await import("../core/secrets.ts");
        const scanResults = await scanConfigForSecrets(config.servers);
        if (scanResults.length > 0) {
          let key = await loadEncKey(configDir);
          if (!key) {
            const b64 = await generateKey();
            await saveKey(configDir, b64);
            key = await importKey(b64);
          }
          for (const result of scanResults) {
            const server = config.servers[result.serverName];
            if (!server) continue;
            for (const secret of result.secrets) {
              if (!config.settings) config.settings = {};
              if (!config.settings.env) config.settings.env = {};
              // Collision-safe env-var name for URL creds (review C), and only
              // encrypt+store once the plaintext is provably removed (review A+F).
              const envVar =
                secret.source === "url-credential"
                  ? pickEnvVarName(config.settings.env, secret.suggestedEnvVar, result.serverName)
                  : secret.suggestedEnvVar;
              if (!substituteSecret(server, secret, envVar)) continue;
              config.settings.env[envVar] = await encryptValue(secret.value, key);
            }
          }
        }

        return {
          result: `Imported ${imported} server(s) from ${adapters.length} tool(s)`,
          changed: true,
          commitMessage: `import: auto (${imported} servers)`,
        };
      });
    } catch (err) {
      return `Import failed: ${errorMessage(err)}`;
    }
  };

  // README pillar-6 "no parallel implementations": route the TUI apply
  // button through the same controller.applyResolved() pipeline the CLI
  // (`am apply`), MCP (`am_apply`), and web (`POST /api/apply`) already
  // use. The previous TUI apply implementation duplicated ~15 lines of
  // load→decrypt→export logic and skipped the mutex entirely. SEC-4c (the
  // fail-closed drift gate) lives in the extracted `runTuiApply` above.
  const handleApply = (force = false): Promise<string> => runTuiApply(configDir, force);

  const instance = render(
    <App
      initialData={data}
      onProfileSwitch={handleProfileSwitch}
      onSync={handleSync}
      onApply={handleApply}
      onPush={handlePush}
      onAddServer={handleAddServer}
      onRemoveServer={handleRemoveServer}
      onImport={handleImport}
    />,
  );

  // Silvery RenderHandle types may not expose waitUntilExit
  const inst = instance as unknown as Record<string, unknown>;
  if (typeof inst.waitUntilExit === "function") {
    await (inst.waitUntilExit as () => Promise<void>)();
  }
}
