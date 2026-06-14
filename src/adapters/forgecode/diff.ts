/**
 * ForgeCode adapter: drift detection via structural comparison.
 *
 * Reads current native .mcp.json and compares against the resolved config.
 * Returns a DiffResult with status and per-entity changes.
 *
 * Reuses normalization helpers from claude-code/diff.ts where possible.
 */

import { join } from "node:path";
import { compareServerFields, readJsonFile } from "../shared/utils.ts";
import type { DiffChange, DiffResult, ResolvedConfig, ResolvedServer } from "../types.ts";

/**
 * Compare resolved config against native ForgeCode config files.
 */
export function diffConfig(
  config: ResolvedConfig,
  options: { projectPath?: string } = {},
): DiffResult {
  const changes: DiffChange[] = [];

  // ForgeCode only has project-level .mcp.json — fall back to cwd if no projectPath provided
  const projectDir = options.projectPath ?? process.cwd();

  const nativeServers = readNativeServers(join(projectDir, ".mcp.json"));
  if (nativeServers === null) {
    return { status: "unmanaged", changes: [] };
  }

  // Expected servers from resolved config (only enabled)
  const expected: Record<string, ResolvedServer> = {};
  for (const [name, server] of Object.entries(config.servers)) {
    if (server.enabled) expected[name] = server;
  }

  // Find servers added locally (in native but not in resolved)
  for (const name of Object.keys(nativeServers)) {
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
    if (!(name in nativeServers)) {
      changes.push({
        entity: "server",
        name,
        type: "added-in-config",
      });
    }
  }

  // Find modified servers (present in both but different)
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

/** Read mcpServers from a JSON file, returning null if file doesn't exist. */
function readNativeServers(filePath: string): Record<string, Record<string, unknown>> | null {
  const json = readJsonFile(filePath);
  if (json === null) return null;
  return (
    ((json as Record<string, unknown>).mcpServers as Record<string, Record<string, unknown>>) ?? {}
  );
}
