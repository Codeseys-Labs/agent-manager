/**
 * Continue adapter: drift detection via structural comparison.
 *
 * Reads the native config (YAML preferred, JSON fallback) and compares the
 * `mcpServers` array against the resolved config.
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { compareServerFields } from "../shared/utils.ts";
import type { DiffChange, DiffResult, ResolvedConfig, ResolvedServer } from "../types.ts";
import { listYamlFiles } from "./detect.ts";
import { parseYaml } from "./yaml.ts";

interface NativeServer {
  name: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
  [key: string]: unknown;
}

/**
 * Compare resolved config against native Continue config files.
 */
export function diffConfig(
  config: ResolvedConfig,
  _options: { projectPath?: string } = {},
  homeDir?: string,
): DiffResult {
  const home = homeDir ?? homedir();
  const changes: DiffChange[] = [];

  const nativeServers = readNativeServers(join(home, ".continue"));
  if (nativeServers === null) {
    return { status: "unmanaged", changes: [] };
  }

  const expected: Record<string, ResolvedServer> = {};
  for (const [name, server] of Object.entries(config.servers)) {
    if (server.enabled) expected[name] = server;
  }

  for (const name of Object.keys(nativeServers)) {
    if (!(name in expected)) {
      changes.push({ entity: "server", name, type: "added-locally" });
    }
  }

  for (const name of Object.keys(expected)) {
    if (!(name in nativeServers)) {
      changes.push({ entity: "server", name, type: "removed-locally" });
    }
  }

  for (const [name, expectedServer] of Object.entries(expected)) {
    if (!(name in nativeServers)) continue;
    const native = nativeServers[name];
    const fieldChanges = compareServerFields(expectedServer, native);
    if (fieldChanges.length > 0) {
      changes.push({ entity: "server", name, type: "modified", details: fieldChanges });
    }
  }

  return { status: changes.length === 0 ? "in-sync" : "drifted", changes };
}

/**
 * Read native servers from the `.continue/` directory — union of:
 *   1. config.yaml (preferred)
 *   2. config.json (legacy)
 *   3. .continue/mcpServers/*.yaml (per-server block files)
 *
 * Returns null if nothing readable is found (so caller can report unmanaged).
 */
function readNativeServers(continueDir: string): Record<string, NativeServer> | null {
  const fs = require("node:fs");
  const yamlPath = join(continueDir, "config.yaml");
  const jsonPath = join(continueDir, "config.json");
  const mcpDir = join(continueDir, "mcpServers");

  const map: Record<string, NativeServer> = {};
  let foundAny = false;

  if (existsSync(yamlPath)) {
    try {
      const text = fs.readFileSync(yamlPath, "utf-8");
      const parsed = parseYaml(text) as { mcpServers?: NativeServer[] } | null;
      if (parsed && Array.isArray(parsed.mcpServers)) {
        for (const entry of parsed.mcpServers) {
          if (entry && typeof entry === "object" && entry.name) map[entry.name] = entry;
        }
      }
      foundAny = true;
    } catch {
      /* malformed YAML — treat as unmanaged */
    }
  }

  if (existsSync(jsonPath)) {
    try {
      const text = fs.readFileSync(jsonPath, "utf-8");
      const parsed = JSON.parse(text) as { mcpServers?: NativeServer[] };
      if (Array.isArray(parsed.mcpServers)) {
        for (const entry of parsed.mcpServers) {
          if (entry && typeof entry === "object" && entry.name) map[entry.name] = entry;
        }
      }
      foundAny = true;
    } catch {
      /* malformed */
    }
  }

  if (existsSync(mcpDir)) {
    for (const file of listYamlFiles(mcpDir)) {
      try {
        const text = fs.readFileSync(join(mcpDir, file), "utf-8");
        const parsed = parseYaml(text) as { mcpServers?: NativeServer[] } | null;
        if (parsed && Array.isArray(parsed.mcpServers)) {
          for (const entry of parsed.mcpServers) {
            if (entry && typeof entry === "object" && entry.name) map[entry.name] = entry;
          }
        }
        foundAny = true;
      } catch {
        /* skip malformed file */
      }
    }
  }

  return foundAny ? map : null;
}
