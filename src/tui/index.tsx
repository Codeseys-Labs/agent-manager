import { join } from "node:path";
import React from "react";
import { render } from "silvery";
import { getDetectedAdapters } from "../adapters/registry.ts";
import { readActiveProfile, writeActiveProfile } from "../commands/use.ts";
import {
  buildResolvedConfig,
  loadResolvedConfig,
  readConfig,
  resolveConfigDir,
  resolveProjectConfig,
  writeConfig,
} from "../core/config.ts";
import { commitAll, pull, push } from "../core/git.ts";
import { interpolateEnvAsync, loadKey } from "../core/secrets.ts";
import { errorMessage } from "../lib/errors.ts";
import { App } from "./App.tsx";
import { loadTuiData } from "./data.ts";

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

  const handleRemoveServer = async (serverName: string): Promise<string> => {
    try {
      const configPath = join(configDir, "config.toml");
      const config = await readConfig(configPath);
      if (!config.servers?.[serverName]) return `Server "${serverName}" not found`;
      delete config.servers[serverName];
      await writeConfig(configPath, config);
      try {
        await commitAll(configDir, `remove server: ${serverName}`);
      } catch {
        /* git commit is best-effort */
      }
      return `Removed server "${serverName}"`;
    } catch (err) {
      return `Remove failed: ${errorMessage(err)}`;
    }
  };

  const handleImport = async (): Promise<string> => {
    try {
      const adapters = await getDetectedAdapters();
      if (adapters.length === 0) return "No tools detected to import from";

      const configPath = join(configDir, "config.toml");
      const config = await readConfig(configPath);
      if (!config.servers) config.servers = {};

      let imported = 0;
      for (const adapter of adapters) {
        try {
          const result = adapter.import({});
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

      if (imported > 0) {
        // Secret detection + encryption
        const { scanConfigForSecrets, substituteSecret } = await import(
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
              substituteSecret(server, secret, secret.suggestedEnvVar);
              if (!config.settings) config.settings = {};
              if (!config.settings.env) config.settings.env = {};
              config.settings.env[secret.suggestedEnvVar] = await encryptValue(secret.value, key);
            }
          }
        }

        await writeConfig(configPath, config);
        try {
          await commitAll(configDir, `import: auto (${imported} servers)`);
        } catch {
          /* git commit is best-effort */
        }
      }

      return imported > 0
        ? `Imported ${imported} server(s) from ${adapters.length} tool(s)`
        : `No new servers found in ${adapters.length} detected tool(s)`;
    } catch (err) {
      return `Import failed: ${errorMessage(err)}`;
    }
  };

  const handleApply = async () => {
    const projectFile = resolveProjectConfig(process.cwd());
    const config = await loadResolvedConfig({ configDir, projectFile });
    const profileName =
      (await readActiveProfile(configDir)) ?? config.settings?.default_profile ?? "default";

    // Decrypt encrypted values before building resolved config
    const encryptionKey = await loadKey(configDir);
    const { config: interpolated } = await interpolateEnvAsync(config, {
      encryptionKey: encryptionKey ?? undefined,
    });

    const resolved = buildResolvedConfig(interpolated, profileName, configDir);

    const adapters = await getDetectedAdapters();
    for (const adapter of adapters) {
      adapter.export(resolved, {
        projectPath: projectFile ? projectFile.replace(/[/\\][^/\\]+$/, "") : undefined,
      });
    }
  };

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
