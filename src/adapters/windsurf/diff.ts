/**
 * Windsurf adapter: drift detection via structural comparison.
 *
 * Reads current native mcp_config.json and compares against resolved config.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import type { DiffChange, DiffResult, ResolvedConfig, ResolvedServer } from "../types.ts";

interface NativeServer {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  disabled?: boolean;
  [key: string]: unknown;
}

/**
 * Compare resolved config against native Windsurf config files.
 */
export function diffConfig(
  config: ResolvedConfig,
  options: { projectPath?: string } = {},
  homeDir?: string,
): DiffResult {
  const home = homeDir ?? homedir();
  const changes: DiffChange[] = [];

  const nativeServers = readNativeServers(join(home, ".codeium", "windsurf", "mcp_config.json"));
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
    const fieldChanges = compareServer(expectedServer, native);
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
  try {
    const fs = require("node:fs");
    const text = fs.readFileSync(filePath, "utf-8");
    const json = JSON.parse(text);
    return json.mcpServers ?? {};
  } catch {
    return null;
  }
}

function compareServer(
  expected: ResolvedServer,
  native: NativeServer,
): { field: string; expected: unknown; actual: unknown }[] {
  const diffs: { field: string; expected: unknown; actual: unknown }[] = [];

  if (expected.command !== native.command) {
    diffs.push({
      field: "command",
      expected: expected.command,
      actual: native.command,
    });
  }

  const expectedArgs = expected.args ?? [];
  const nativeArgs = native.args ?? [];
  if (JSON.stringify(normalize(expectedArgs)) !== JSON.stringify(normalize(nativeArgs))) {
    diffs.push({ field: "args", expected: expectedArgs, actual: nativeArgs });
  }

  const expectedEnv = expected.env ?? {};
  const nativeEnv = native.env ?? {};
  if (JSON.stringify(sortKeys(expectedEnv)) !== JSON.stringify(sortKeys(nativeEnv))) {
    diffs.push({ field: "env", expected: expectedEnv, actual: nativeEnv });
  }

  return diffs;
}

function sortKeys<T extends Record<string, unknown>>(obj: T): T {
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(obj).sort()) {
    sorted[key] = obj[key];
  }
  return sorted as T;
}

function normalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === "object") return sortKeys(value as Record<string, unknown>);
  return value;
}
