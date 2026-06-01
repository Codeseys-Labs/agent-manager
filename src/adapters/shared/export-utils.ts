/**
 * Shared adapter export utilities — collapses the duplicated MCP-JSON
 * builder and the file-write loop carried by every IDE adapter.
 *
 * Two helpers:
 * - `buildMcpServersJson` — read-merge-partition the on-disk `{ mcpServers }`
 *   JSON, preserving any non-managed top-level keys and per-server adapter
 *   extras (stdio command/args/env vs url-based remote).
 * - `writeExportFiles` — the shared `mkdirSync + atomicWriteFileSync` loop with
 *   warning-on-failure semantics, gated on `dryRun`.
 *
 * Both are behaviour-preserving extractions: the output is byte-identical to
 * the inline code each adapter previously carried.
 */

import { dirname } from "node:path";
import { atomicWriteFileSync } from "../../core/atomic-write.ts";
import type { ResolvedServer, WrittenFile } from "../types.ts";

// ── MCP servers JSON builder ────────────────────────────────────

export interface BuildMcpServersOptions {
  /**
   * Adapter key used to read per-server `server.adapters[adapterKey]` extras.
   * When omitted, no adapter-specific fields are merged.
   */
  adapterKey?: string;
  /**
   * Top-level JSON key the servers map is written under. Most adapters use
   * `mcpServers`; Copilot/VS Code use `servers`.
   */
  serversKey?: string;
  /**
   * Adapter-extra keys to skip when merging (internal routing hints like
   * `scope`, or fields handled explicitly by the adapter such as `url`).
   */
  skipExtras?: readonly string[];
  /**
   * Optional hook to map/transform an adapter-extra key/value before it is
   * written onto the server entry. Return `undefined` to drop the pair, or a
   * `[key, value]` tuple to write it under a (possibly renamed) key.
   *
   * Runs after `skipExtras` filtering. Lets adapters keep small field-name
   * remaps (e.g. Claude Code's `alwaysAllow` → `always_allow`) without
   * forking the whole builder.
   */
  mapExtra?: (key: string, value: unknown) => [string, unknown] | undefined;
  /**
   * When true, remote servers (`transport === "streamable-http" | "sse"`)
   * emit `{ url }` (using `server.command` as the URL) instead of
   * `{ command }`. Defaults to `false` — most adapters historically wrote
   * `command` unconditionally and only stdio servers ever reach them.
   */
  remote?: boolean;
}

/**
 * Build an MCP-servers JSON document, preserving existing non-managed
 * top-level fields read from `existingPath`.
 *
 * stdio servers emit `{ command, args?, env? }`; remote servers (detected via
 * `transport === "streamable-http" | "sse"`) emit `{ url, env? }` using
 * `server.command` as the URL. Adapter-specific extras (minus `skipExtras`)
 * are merged onto each entry.
 *
 * @param servers      Map of server name → resolved server (caller pre-filters
 *                     by `enabled`/scope as needed).
 * @param existingPath Path to read for non-managed top-level field preservation.
 * @param opts         Builder options (see {@link BuildMcpServersOptions}).
 * @returns Pretty-printed JSON string with a trailing newline.
 */
export function buildMcpServersJson(
  servers: Record<string, ResolvedServer>,
  existingPath: string,
  opts: BuildMcpServersOptions = {},
): string {
  const { adapterKey, serversKey = "mcpServers", skipExtras = [], mapExtra, remote = false } = opts;
  const skip = new Set(skipExtras);

  let existing: Record<string, unknown> = {};
  try {
    const fs = require("node:fs");
    const text = fs.readFileSync(existingPath, "utf-8");
    existing = JSON.parse(text);
  } catch {
    // No existing file or malformed — start fresh.
  }

  const mcpServers: Record<string, unknown> = {};
  for (const [name, server] of Object.entries(servers)) {
    const isHttp = remote && (server.transport === "streamable-http" || server.transport === "sse");
    const entry: Record<string, unknown> = {};

    if (isHttp) {
      entry.url = server.command;
    } else {
      entry.command = server.command;
      if (server.args.length > 0) entry.args = server.args;
    }

    if (Object.keys(server.env).length > 0) entry.env = server.env;

    if (adapterKey) {
      const extras = server.adapters?.[adapterKey] ?? {};
      for (const [key, value] of Object.entries(extras)) {
        if (skip.has(key)) continue;
        if (mapExtra) {
          const mapped = mapExtra(key, value);
          if (mapped) entry[mapped[0]] = mapped[1];
        } else {
          entry[key] = value;
        }
      }
    }

    mcpServers[name] = entry;
  }

  const output = { ...existing, [serversKey]: mcpServers };
  return `${JSON.stringify(output, null, 2)}\n`;
}

// ── File write loop ─────────────────────────────────────────────

/**
 * Write the collected export files unless `dryRun` is set.
 *
 * Mutates each file's `written` flag on success; on failure pushes a warning
 * string and continues (never throws). This is the shared
 * `mkdirSync + atomicWriteFileSync` loop every adapter carried inline.
 *
 * @param files    Files to write (their `written` flags are mutated in place).
 * @param warnings Warning sink — failures are appended here.
 * @param opts     `{ dryRun }` — when true, nothing is written.
 */
export function writeExportFiles(
  files: WrittenFile[],
  warnings: string[],
  opts: { dryRun?: boolean } = {},
): void {
  if (opts.dryRun) return;

  const fs = require("node:fs");
  for (const file of files) {
    try {
      fs.mkdirSync(dirname(file.path), { recursive: true });
      atomicWriteFileSync(file.path, file.content);
      file.written = true;
    } catch (err) {
      warnings.push(
        `Failed to write ${file.path}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}
