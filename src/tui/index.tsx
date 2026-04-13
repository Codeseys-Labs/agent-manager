import React from "react";
import { render } from "silvery";
import { getDetectedAdapters } from "../adapters/registry.ts";
import { readActiveProfile, writeActiveProfile } from "../commands/use.ts";
import {
  buildResolvedConfig,
  loadResolvedConfig,
  resolveConfigDir,
  resolveProjectConfig,
} from "../core/config.ts";
import { pull, push } from "../core/git.ts";
import { interpolateEnvAsync, loadKey } from "../core/secrets.ts";
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
    />,
  );

  await instance.waitUntilExit();
}
