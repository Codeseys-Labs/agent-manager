/**
 * Codex CLI adapter: drift detection via structural comparison.
 *
 * Reads current native config.toml and compares against the resolved config.
 * Returns a DiffResult with status and per-entity changes.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { parse as parseTOML } from "@iarna/toml";
import { compareServerFields } from "../shared/utils.ts";
import type { DiffChange, DiffResult, ResolvedConfig, ResolvedServer } from "../types.ts";

interface NativeServer {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  enabled?: boolean;
  [key: string]: unknown;
}

/**
 * Compare resolved config against native Codex CLI config files.
 */
export function diffConfig(
  config: ResolvedConfig,
  options: { projectPath?: string } = {},
  homeDir?: string,
): DiffResult {
  const home = homeDir ?? homedir();
  const changes: DiffChange[] = [];

  // Read native servers
  const nativeGlobal = readNativeServers(join(home, ".codex", "config.toml"));
  if (nativeGlobal === null) {
    return { status: "unmanaged", changes: [] };
  }

  const nativeProject = options.projectPath
    ? readNativeServers(join(options.projectPath, ".codex", "config.toml"))
    : null;

  const allNative: Record<string, NativeServer> = {
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

/** Read mcp_servers from a TOML config file, returning null if file doesn't exist. */
function readNativeServers(filePath: string): Record<string, NativeServer> | null {
  try {
    const fs = require("node:fs");
    const text = fs.readFileSync(filePath, "utf-8");
    const config = parseTOML(text) as unknown as { mcp_servers?: Record<string, NativeServer> };
    return config.mcp_servers ?? {};
  } catch {
    return null;
  }
}
