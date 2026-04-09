/**
 * Claude Code adapter: drift detection via structural comparison.
 *
 * Reads current native configs and compares against the resolved config.
 * Returns a DiffResult with status and per-entity changes.
 * Detects drift for both servers and instructions.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { filterByTarget } from "../../core/instructions.ts";
import { compareInstructions } from "../shared/diff-utils.ts";
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
 * Compare resolved config against native Claude Code config files.
 */
export function diffConfig(
  config: ResolvedConfig,
  options: { projectPath?: string } = {},
  homeDir?: string,
): DiffResult {
  const home = homeDir ?? homedir();
  const changes: DiffChange[] = [];

  // Read native servers
  const nativeGlobal = readNativeServers(join(home, ".claude.json"));
  if (nativeGlobal === null) {
    return { status: "unmanaged", changes: [] };
  }

  const nativeProject = options.projectPath
    ? readNativeServers(join(options.projectPath, ".mcp.json"))
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

  // Instruction drift: compare CLAUDE.md managed block
  if (options.projectPath) {
    const claudeMdPath = join(options.projectPath, "CLAUDE.md");
    let nativeContent: string | null = null;
    try {
      const fs = require("node:fs");
      nativeContent = fs.readFileSync(claudeMdPath, "utf-8");
    } catch {
      // File doesn't exist
    }
    const targetInstructions = filterByTarget(config.instructions, "claude-code");
    const instrChanges = compareInstructions(targetInstructions, nativeContent, "claude-code");
    changes.push(...instrChanges);
  }

  return {
    status: changes.length === 0 ? "in-sync" : "drifted",
    changes,
  };
}

/** Read mcpServers from a JSON file, returning null if file doesn't exist. */
function readNativeServers(filePath: string): Record<string, NativeServer> | null {
  const json = readJsonFile(filePath);
  if (json === null) return null;
  return ((json as Record<string, unknown>).mcpServers as Record<string, NativeServer>) ?? {};
}
