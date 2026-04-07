/**
 * Kilo Code adapter: drift detection via structural comparison.
 *
 * Reads current native configs (JSONC) and compares against the resolved config.
 * Handles both new CLI-native MCP format and legacy mcpServers format.
 */

import { join } from "node:path";
import { homedir } from "node:os";
import { parseJsonc } from "./jsonc.ts";
import type {
  DiffChange,
  DiffResult,
  ResolvedConfig,
  ResolvedServer,
} from "../types.ts";

interface NativeServer {
  command: string;
  args: string[];
  env: Record<string, string>;
}

/**
 * Compare resolved config against native Kilo Code config files.
 */
export function diffConfig(
  config: ResolvedConfig,
  options: { projectPath?: string } = {},
  homeDir?: string,
): DiffResult {
  const home = homeDir ?? homedir();
  const changes: DiffChange[] = [];

  // Read native servers from both global and project configs
  const nativeGlobal = readNativeServers(home);
  if (nativeGlobal === null) {
    return { status: "unmanaged", changes: [] };
  }

  const nativeProject = options.projectPath
    ? readNativeProjectServers(options.projectPath)
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

  // Find servers added locally
  for (const name of Object.keys(allNative)) {
    if (!(name in expected)) {
      changes.push({ entity: "server", name, type: "added-locally" });
    }
  }

  // Find servers removed locally
  for (const name of Object.keys(expected)) {
    if (!(name in allNative)) {
      changes.push({ entity: "server", name, type: "removed-locally" });
    }
  }

  // Find modified servers
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

/** Read and normalize servers from global kilo config. */
function readNativeServers(
  home: string,
): Record<string, NativeServer> | null {
  const configDir = join(home, ".config", "kilo");
  const configNames = [
    "kilo.jsonc",
    "kilo.json",
    "config.json",
    "opencode.jsonc",
    "opencode.json",
  ];

  for (const name of configNames) {
    const config = readJsoncConfig(join(configDir, name));
    if (config) return normalizeServers(config);
  }
  return null;
}

/** Read and normalize servers from project kilo config. */
function readNativeProjectServers(
  projectPath: string,
): Record<string, NativeServer> | null {
  // .kilo/kilo.jsonc takes priority
  const dotKiloConfig = readJsoncConfig(
    join(projectPath, ".kilo", "kilo.jsonc"),
  );
  if (dotKiloConfig) return normalizeServers(dotKiloConfig);

  const rootConfig = readJsoncConfig(join(projectPath, "kilo.jsonc"));
  if (rootConfig) return normalizeServers(rootConfig);

  return null;
}

function readJsoncConfig(filePath: string): Record<string, unknown> | null {
  try {
    const fs = require("node:fs");
    const text = fs.readFileSync(filePath, "utf-8");
    return parseJsonc(text) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Normalize both MCP formats into a common NativeServer shape. */
function normalizeServers(
  config: Record<string, unknown>,
): Record<string, NativeServer> {
  const result: Record<string, NativeServer> = {};

  // New format: `mcp` key
  const mcp = config.mcp as Record<string, Record<string, unknown>> | undefined;
  if (mcp && typeof mcp === "object") {
    for (const [name, entry] of Object.entries(mcp)) {
      if (!entry || typeof entry !== "object") continue;
      if (entry.enabled === false) continue;

      if (entry.type === "remote" && entry.url) {
        result[name] = {
          command: entry.url as string,
          args: [],
          env: (entry.headers as Record<string, string>) ?? {},
        };
      } else if (Array.isArray(entry.command) && entry.command.length > 0) {
        const [cmd, ...args] = entry.command as string[];
        result[name] = {
          command: cmd,
          args,
          env: (entry.environment as Record<string, string>) ?? {},
        };
      }
    }
  }

  // Legacy format: `mcpServers` key
  const mcpServers = config.mcpServers as
    | Record<string, Record<string, unknown>>
    | undefined;
  if (mcpServers && typeof mcpServers === "object") {
    for (const [name, entry] of Object.entries(mcpServers)) {
      if (!entry || typeof entry !== "object") continue;
      if (entry.disabled === true) continue;
      if (!entry.command) continue;

      result[name] = {
        command: entry.command as string,
        args: (entry.args as string[]) ?? [],
        env: (entry.env as Record<string, string>) ?? {},
      };
    }
  }

  return result;
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
  if (JSON.stringify(normalize(expectedArgs)) !== JSON.stringify(normalize(nativeArgs))) {
    diffs.push({ field: "args", expected: expectedArgs, actual: nativeArgs });
  }

  const expectedEnv = expected.env ?? {};
  const nativeEnv = native.env ?? {};
  if (
    JSON.stringify(sortKeys(expectedEnv)) !==
    JSON.stringify(sortKeys(nativeEnv))
  ) {
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
  if (value && typeof value === "object")
    return sortKeys(value as Record<string, unknown>);
  return value;
}
