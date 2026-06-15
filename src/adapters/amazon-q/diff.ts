/**
 * Amazon Q adapter: drift detection via structural comparison.
 *
 * Reads current native mcp.json and compares against resolved config.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { compareServerFields, readJsonFile } from "../shared/utils.ts";
import type { DiffChange, DiffResult, ResolvedConfig, ResolvedServer } from "../types.ts";

interface NativeServer {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  disabled?: boolean;
  [key: string]: unknown;
}

/**
 * Compare resolved config against native Amazon Q config files.
 */
export function diffConfig(
  config: ResolvedConfig,
  options: { projectPath?: string } = {},
  homeDir?: string,
): DiffResult {
  const home = homeDir ?? homedir();
  const changes: DiffChange[] = [];

  const nativeServers = readNativeServers(join(home, ".aws", "amazonq", "mcp.json"));
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

  // Catalog-ahead: server in the catalog but not yet in native. A FORWARD delta
  // (`am add server`), not a local removal — `am apply` resolves it by writing
  // the server, so label it `added-in-config`. (ws4-drift-relabel-catalog-ahead)
  for (const name of Object.keys(expected)) {
    if (!(name in nativeServers)) {
      changes.push({ entity: "server", name, type: "added-in-config" });
    }
  }

  // Find modified servers
  for (const [name, expectedServer] of Object.entries(expected)) {
    if (!(name in nativeServers)) continue;
    const native = nativeServers[name];
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

function readNativeServers(filePath: string): Record<string, NativeServer> | null {
  const json = readJsonFile(filePath);
  if (json === null) return null;
  return ((json as Record<string, unknown>).mcpServers as Record<string, NativeServer>) ?? {};
}
