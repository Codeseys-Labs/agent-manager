/**
 * Cline adapter: drift detection via structural comparison.
 *
 * Reads current cline_mcp_settings.json and compares against the resolved config.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { compareServerFields } from "../shared/utils.ts";
import type { DiffChange, DiffResult, ResolvedConfig, ResolvedServer } from "../types.ts";
import { getGlobalStoragePath } from "./detect.ts";

interface NativeServer {
  command: string;
  args: string[];
  env: Record<string, string>;
  [key: string]: unknown;
}

/**
 * Compare resolved config against native Cline config files.
 */
export function diffConfig(
  config: ResolvedConfig,
  _options: { projectPath?: string } = {},
  homeDir?: string,
): DiffResult {
  const home = homeDir ?? homedir();
  const changes: DiffChange[] = [];

  const nativeServers = readNativeServers(home);
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

/** Read and normalize servers from cline_mcp_settings.json. */
function readNativeServers(home: string): Record<string, NativeServer> | null {
  const fs = require("node:fs");
  const settingsPath = join(getGlobalStoragePath(home), "settings", "cline_mcp_settings.json");

  let text: string;
  try {
    text = fs.readFileSync(settingsPath, "utf-8");
  } catch {
    return null;
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }

  const mcpServers = parsed.mcpServers;
  if (!mcpServers || typeof mcpServers !== "object") {
    return {};
  }

  const result: Record<string, NativeServer> = {};
  for (const [name, entry] of Object.entries(mcpServers as Record<string, unknown>)) {
    if (!entry || typeof entry !== "object") continue;
    const obj = entry as Record<string, unknown>;
    if (obj.disabled === true) continue;
    if (typeof obj.command !== "string") continue;

    result[name] = {
      command: obj.command,
      args: Array.isArray(obj.args) ? (obj.args as string[]) : [],
      env:
        obj.env && typeof obj.env === "object" && !Array.isArray(obj.env)
          ? (obj.env as Record<string, string>)
          : {},
    };
  }

  return result;
}
