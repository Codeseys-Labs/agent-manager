/**
 * ForgeCode adapter: drift detection via structural comparison.
 *
 * Reads current native .mcp.json and compares against the resolved config.
 * Returns a DiffResult with status and per-entity changes.
 *
 * Reuses normalization helpers from claude-code/diff.ts where possible.
 */

import { join } from "node:path";
import type {
  DiffChange,
  DiffResult,
  ResolvedConfig,
  ResolvedServer,
} from "../types.ts";

interface NativeServer {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  disable?: boolean;
  [key: string]: unknown;
}

/**
 * Compare resolved config against native ForgeCode config files.
 */
export function diffConfig(
  config: ResolvedConfig,
  options: { projectPath?: string } = {},
): DiffResult {
  const changes: DiffChange[] = [];

  // ForgeCode only has project-level .mcp.json
  if (!options.projectPath) {
    return { status: "unmanaged", changes: [] };
  }

  const nativeServers = readNativeServers(
    join(options.projectPath, ".mcp.json"),
  );
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

  // Find servers removed locally (in resolved but not in native)
  for (const name of Object.keys(expected)) {
    if (!(name in nativeServers)) {
      changes.push({
        entity: "server",
        name,
        type: "removed-locally",
      });
    }
  }

  // Find modified servers (present in both but different)
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

/** Read mcpServers from a JSON file, returning null if file doesn't exist. */
function readNativeServers(
  filePath: string,
): Record<string, NativeServer> | null {
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

  if (expected.command !== native.command) {
    diffs.push({
      field: "command",
      expected: expected.command,
      actual: native.command,
    });
  }

  const expectedArgs = expected.args ?? [];
  const nativeArgs = native.args ?? [];
  if (
    JSON.stringify(normalize(expectedArgs)) !==
    JSON.stringify(normalize(nativeArgs))
  ) {
    diffs.push({
      field: "args",
      expected: expectedArgs,
      actual: nativeArgs,
    });
  }

  const expectedEnv = expected.env ?? {};
  const nativeEnv = native.env ?? {};
  if (
    JSON.stringify(sortKeys(expectedEnv)) !==
    JSON.stringify(sortKeys(nativeEnv))
  ) {
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
  if (value && typeof value === "object")
    return sortKeys(value as Record<string, unknown>);
  return value;
}
