/**
 * Copilot adapter: drift detection via structural comparison.
 *
 * Reads current native .vscode/mcp.json (uses "servers" key) and
 * compares against the resolved config.
 */

import { join } from "node:path";
import { compareServerFields, readJsonFile } from "../shared/utils.ts";
import type { DiffChange, DiffResult, ResolvedConfig, ResolvedServer } from "../types.ts";

interface NativeServer {
  type?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  [key: string]: unknown;
}

/**
 * Compare resolved config against native Copilot config files.
 */
export function diffConfig(
  config: ResolvedConfig,
  options: { projectPath?: string } = {},
): DiffResult {
  const changes: DiffChange[] = [];

  if (!options.projectPath) {
    return { status: "unmanaged", changes: [] };
  }

  const nativeServers = readNativeServers(join(options.projectPath, ".vscode", "mcp.json"));
  if (nativeServers === null) {
    return { status: "unmanaged", changes: [] };
  }

  // Expected servers from resolved config (only enabled)
  const expected: Record<string, ResolvedServer> = {};
  for (const [name, server] of Object.entries(config.servers)) {
    if (server.enabled) expected[name] = server;
  }

  // Find servers added locally
  for (const name of Object.keys(nativeServers)) {
    if (!(name in expected)) {
      changes.push({ entity: "server", name, type: "added-locally" });
    }
  }

  // Find servers removed locally
  for (const name of Object.keys(expected)) {
    if (!(name in nativeServers)) {
      changes.push({ entity: "server", name, type: "removed-locally" });
    }
  }

  // Find modified servers
  for (const [name, expectedServer] of Object.entries(expected)) {
    if (!(name in nativeServers)) continue;
    const native = nativeServers[name];
    // For HTTP servers, Copilot may store URL in adapter extras
    const urlOverride = expectedServer.adapters?.copilot?.url as string | undefined;
    const fieldChanges = compareServerFields(expectedServer, native, {
      urlOverride: urlOverride ?? undefined,
    });
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

/** Read servers from .vscode/mcp.json — uses "servers" key. */
function readNativeServers(filePath: string): Record<string, NativeServer> | null {
  const json = readJsonFile(filePath);
  if (json === null) return null;
  return ((json as Record<string, unknown>).servers as Record<string, NativeServer>) ?? {};
}
