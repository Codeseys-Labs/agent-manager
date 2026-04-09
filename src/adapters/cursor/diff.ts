/**
 * Cursor adapter: drift detection via structural comparison.
 *
 * Reads current native configs and compares against the resolved config.
 * Returns a DiffResult with status and per-entity changes.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import type { DiffChange, DiffResult, ResolvedConfig, ResolvedServer } from "../types.ts";

interface NativeServer {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  disabled?: boolean;
  [key: string]: unknown;
}

/**
 * Compare resolved config against native Cursor config files.
 */
export function diffConfig(
  config: ResolvedConfig,
  options: { projectPath?: string } = {},
  homeDir?: string,
): DiffResult {
  const home = homeDir ?? homedir();
  const changes: DiffChange[] = [];

  // Read native servers
  const nativeGlobal = readNativeServers(join(home, ".cursor", "mcp.json"));
  const nativeProject = options.projectPath
    ? readNativeServers(join(options.projectPath, ".cursor", "mcp.json"))
    : null;

  // If neither exists, it's unmanaged
  if (nativeGlobal === null && nativeProject === null) {
    return { status: "unmanaged", changes: [] };
  }

  const allNative: Record<string, NativeServer> = {
    ...(nativeGlobal ?? {}),
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

  // Find servers removed locally (in resolved but not in native)
  for (const name of Object.keys(expected)) {
    if (!(name in allNative)) {
      changes.push({
        entity: "server",
        name,
        type: "removed-locally",
      });
    }
  }

  // Find modified servers (present in both but different)
  for (const [name, expectedServer] of Object.entries(expected)) {
    if (!(name in allNative)) continue;
    const native = allNative[name];
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

/** Read mcpServers from a JSON file, returning null if file doesn't exist. */
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

/** Compare a resolved server against native, returning field-level diffs. */
function compareServer(
  expected: ResolvedServer,
  native: NativeServer,
): { field: string; expected: unknown; actual: unknown }[] {
  const diffs: { field: string; expected: unknown; actual: unknown }[] = [];

  // Compare command
  if (expected.command !== (native.command ?? "")) {
    diffs.push({
      field: "command",
      expected: expected.command,
      actual: native.command ?? "",
    });
  }

  // Compare args (normalize: treat missing as [])
  const expectedArgs = expected.args ?? [];
  const nativeArgs = native.args ?? [];
  if (JSON.stringify(normalize(expectedArgs)) !== JSON.stringify(normalize(nativeArgs))) {
    diffs.push({
      field: "args",
      expected: expectedArgs,
      actual: nativeArgs,
    });
  }

  // Compare env (normalize: treat missing as {})
  const expectedEnv = expected.env ?? {};
  const nativeEnv = native.env ?? {};
  if (JSON.stringify(sortKeys(expectedEnv)) !== JSON.stringify(sortKeys(nativeEnv))) {
    diffs.push({
      field: "env",
      expected: expectedEnv,
      actual: nativeEnv,
    });
  }

  return diffs;
}

/** Sort keys of an object for deterministic comparison. */
function sortKeys<T extends Record<string, unknown>>(obj: T): T {
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(obj).sort()) {
    sorted[key] = obj[key];
  }
  return sorted as T;
}

/** Normalize a value for comparison (deep sort for objects/arrays). */
function normalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === "object") return sortKeys(value as Record<string, unknown>);
  return value;
}
