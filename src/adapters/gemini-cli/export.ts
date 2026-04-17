/**
 * Gemini CLI adapter: export resolved config to native format.
 *
 * Generates ~/.gemini/settings.json (mcpServers),
 * .gemini/settings.json (project servers),
 * and GEMINI.md (instructions with am:begin/am:end markers).
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { atomicWriteFileSync } from "../../core/atomic-write.ts";
import { filterByTarget, generateGeminiMd } from "../../core/instructions.ts";
import type {
  ExportOptions,
  ExportResult,
  ResolvedConfig,
  ResolvedServer,
  WrittenFile,
} from "../types.ts";

/**
 * Export resolved config to Gemini CLI native files.
 */
export function exportConfig(
  config: ResolvedConfig,
  options: ExportOptions = {},
  homeDir?: string,
): ExportResult {
  const home = homeDir ?? homedir();
  const files: WrittenFile[] = [];
  const warnings: string[] = [];

  // Partition servers by scope (presence of gemini-cli adapter scope hint)
  const globalServers: Record<string, ResolvedServer> = {};
  const projectServers: Record<string, ResolvedServer> = {};

  for (const [name, server] of Object.entries(config.servers)) {
    if (!server.enabled) continue;
    const gcAdapter = server.adapters?.["gemini-cli"] ?? {};
    if (gcAdapter.scope === "project") {
      projectServers[name] = server;
    } else {
      globalServers[name] = server;
    }
  }

  // 1. Generate ~/.gemini/settings.json
  const globalPath = join(home, ".gemini", "settings.json");
  const globalContent = generateSettingsJson(globalServers, globalPath, warnings);
  files.push({
    path: globalPath,
    content: globalContent,
    written: false,
  });

  // 2. Generate .gemini/settings.json (project-scoped servers)
  if (options.projectPath && Object.keys(projectServers).length > 0) {
    const projectSettingsPath = join(options.projectPath, ".gemini", "settings.json");
    const projectContent = generateSettingsJson(projectServers, projectSettingsPath, warnings);
    files.push({
      path: projectSettingsPath,
      content: projectContent,
      written: false,
    });
  }

  // 3. Generate GEMINI.md (instructions)
  if (options.projectPath) {
    const targeted = filterByTarget(config.instructions, "gemini-cli");
    if (Object.keys(targeted).length > 0) {
      const geminiMdPath = join(options.projectPath, "GEMINI.md");
      let existingContent: string | undefined;
      try {
        const fs = require("node:fs");
        existingContent = fs.readFileSync(geminiMdPath, "utf-8");
      } catch {
        // No existing file
      }
      const geminiMdContent = generateGeminiMd(targeted, existingContent);
      files.push({
        path: geminiMdPath,
        content: geminiMdContent,
        written: false,
      });
    }
  }

  // Write files unless dryRun
  if (!options.dryRun) {
    for (const file of files) {
      try {
        const fs = require("node:fs");
        const dir = file.path.substring(0, file.path.lastIndexOf("/"));
        fs.mkdirSync(dir, { recursive: true });
        atomicWriteFileSync(file.path, file.content);
        file.written = true;
      } catch (err) {
        warnings.push(
          `Failed to write ${file.path}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  return { files, warnings };
}

/** Build settings.json with mcpServers, preserving existing non-MCP fields. */
function generateSettingsJson(
  servers: Record<string, ResolvedServer>,
  existingPath: string,
  warnings: string[],
): string {
  // Read existing file to preserve non-MCP fields
  let existing: Record<string, unknown> = {};
  try {
    const fs = require("node:fs");
    const text = fs.readFileSync(existingPath, "utf-8");
    existing = JSON.parse(text);
  } catch {
    // No existing file or malformed — start fresh
  }

  const mcpServers: Record<string, unknown> = {};
  for (const [name, server] of Object.entries(servers)) {
    const entry: Record<string, unknown> = { command: server.command };
    if (server.args.length > 0) entry.args = server.args;
    if (Object.keys(server.env).length > 0) entry.env = server.env;

    // Map adapter-specific fields
    const gcExtras = server.adapters?.["gemini-cli"] ?? {};
    for (const [key, value] of Object.entries(gcExtras)) {
      if (key === "scope") continue; // internal routing hint
      entry[key] = value;
    }

    mcpServers[name] = entry;
  }

  const output = { ...existing, mcpServers };
  return `${JSON.stringify(output, null, 2)}\n`;
}
