/**
 * Cursor adapter: drift detection via structural comparison.
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

  // Instruction drift: compare .cursor/rules/*.mdc files
  if (options.projectPath) {
    const targetInstructions = filterByTarget(config.instructions, "cursor");
    const rulesDir = join(options.projectPath, ".cursor", "rules");
    for (const [name, instr] of Object.entries(targetInstructions)) {
      const mdcPath = join(rulesDir, `${name}.mdc`);
      let nativeContent: string | null = null;
      try {
        const fs = require("node:fs");
        nativeContent = fs.readFileSync(mdcPath, "utf-8");
      } catch {
        // File doesn't exist — instruction missing from native
      }
      if (nativeContent === null) {
        changes.push({
          entity: "instruction",
          name,
          type: "removed-locally",
        });
      } else if (!nativeContent.includes(instr.content.trim())) {
        changes.push({
          entity: "instruction",
          name,
          type: "modified",
          details: [
            {
              field: "content",
              expected: instr.content.slice(0, 100) + (instr.content.length > 100 ? "..." : ""),
              actual: nativeContent.slice(0, 100) + (nativeContent.length > 100 ? "..." : ""),
            },
          ],
        });
      }
    }
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
