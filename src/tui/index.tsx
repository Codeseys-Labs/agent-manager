import { render } from "silvery";
import React from "react";
import { getDetectedAdapters } from "../adapters/registry.ts";
import type { ResolvedConfig, ResolvedServer } from "../adapters/types.ts";
import { readActiveProfile, writeActiveProfile } from "../commands/use.ts";
import { loadResolvedConfig, resolveConfigDir, resolveProjectConfig } from "../core/config.ts";
import { pull } from "../core/git.ts";
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

  const handleApply = async () => {
    const projectFile = resolveProjectConfig(process.cwd());
    const config = await loadResolvedConfig({ configDir, projectFile });
    const profileName =
      (await readActiveProfile(configDir)) ?? config.settings?.default_profile ?? "default";

    const servers: Record<string, ResolvedServer> = {};
    for (const [name, srv] of Object.entries(config.servers ?? {})) {
      servers[name] = {
        name,
        command: srv.command,
        args: srv.args ?? [],
        env: srv.env ?? {},
        transport: srv.transport ?? "stdio",
        description: srv.description ?? "",
        tags: srv.tags ?? [],
        enabled: srv.enabled ?? true,
        adapters: (srv.adapters as Record<string, Record<string, unknown>>) ?? {},
      };
    }
    const resolved: ResolvedConfig = {
      servers,
      instructions: {},
      skills: {},
      agents: {},
      profile: profileName,
      adapters: (config.adapters as Record<string, Record<string, unknown>>) ?? {},
    };

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
    />,
  );

  await instance.waitUntilExit();
}
