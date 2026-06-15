/**
 * Gemini CLI adapter: drift detection via structural comparison.
 *
 * Reads current native configs and compares against the resolved config.
 * Returns a DiffResult with status and per-entity changes.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { compareServerFields, readJsonFile } from "../shared/utils.ts";
import type { DiffChange, DiffResult, ResolvedConfig, ResolvedServer } from "../types.ts";

/**
 * Compare resolved config against native Gemini CLI config files.
 */
export function diffConfig(
  config: ResolvedConfig,
  options: { projectPath?: string } = {},
  homeDir?: string,
): DiffResult {
  const home = homeDir ?? homedir();
  const changes: DiffChange[] = [];

  // Read native servers
  const nativeGlobal = readNativeServers(join(home, ".gemini", "settings.json"));
  if (nativeGlobal === null) {
    return { status: "unmanaged", changes: [] };
  }

  const nativeProject = options.projectPath
    ? readNativeServers(join(options.projectPath, ".gemini", "settings.json"))
    : null;

  const allNative: Record<string, Record<string, unknown>> = {
    ...nativeGlobal,
    ...(nativeProject ?? {}),
  };

  // Expected servers from resolved config (only enabled)
  const expected: Record<string, ResolvedServer> = {};
  for (const [name, server] of Object.entries(config.servers)) {
    if (server.enabled) expected[name] = server;
  }

  // Find servers added locally (in native but not in resolved)
  for (const name of Object.keys(allNative)) {
    if (!(name in expected)) {
      changes.push({
        entity: "server",
        name,
        type: "added-locally",
      });
    }
  }

  // Catalog-ahead: server in the catalog but not yet in native. A FORWARD delta
  // (`am add server`), not a local removal — `am apply` resolves it by writing
  // the server, so label it `added-in-config`. (ws4-drift-relabel-catalog-ahead)
  for (const name of Object.keys(expected)) {
    if (!(name in allNative)) {
      changes.push({
        entity: "server",
        name,
        type: "added-in-config",
      });
    }
  }

  // Find modified servers (present in both but different)
  for (const [name, expectedServer] of Object.entries(expected)) {
    if (!(name in allNative)) continue;
    const native = allNative[name];
    const fieldChanges = compareServerFields(expectedServer, native);
    if (fieldChanges.length > 0) {
      changes.push({
        entity: "server",
        name,
        type: "modified",
        details: fieldChanges,
      });
    }
  }

  return {
    status: changes.length === 0 ? "in-sync" : "drifted",
    changes,
  };
}

/** Read mcpServers from a settings.json file, returning null if file doesn't exist. */
function readNativeServers(filePath: string): Record<string, Record<string, unknown>> | null {
  const json = readJsonFile(filePath);
  if (json === null) return null;
  return (
    ((json as Record<string, unknown>).mcpServers as Record<string, Record<string, unknown>>) ?? {}
  );
}
