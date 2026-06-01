/**
 * Cline adapter: export resolved config to native format.
 *
 * Generates cline_mcp_settings.json (MCP servers) and
 * .clinerules/*.md (instructions).
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { atomicWriteFileSync } from "../../core/atomic-write.ts";
import { sanitizePathSegment } from "../../lib/safe-path.ts";
import type { ExportOptions, ExportResult, ResolvedConfig, WrittenFile } from "../types.ts";
import { getGlobalStoragePath } from "./detect.ts";

/**
 * Export resolved config to Cline native files.
 */
export function exportConfig(
  config: ResolvedConfig,
  options: ExportOptions = {},
  homeDir?: string,
): ExportResult {
  const home = homeDir ?? homedir();
  const files: WrittenFile[] = [];
  const warnings: string[] = [];

  // 1. Generate cline_mcp_settings.json
  const mcpPath = join(getGlobalStoragePath(home), "settings", "cline_mcp_settings.json");
  const mcpContent = generateMcpSettings(config, mcpPath);
  files.push({ path: mcpPath, content: mcpContent, written: false });

  // 2. Generate .clinerules/*.md (instructions)
  if (options.projectPath) {
    const ruleFiles = generateRuleFiles(config, options.projectPath);
    files.push(...ruleFiles);
  }

  // Write files unless dryRun
  if (!options.dryRun) {
    const fs = require("node:fs");
    for (const file of files) {
      try {
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

/** Generate cline_mcp_settings.json, preserving existing non-managed fields. */
function generateMcpSettings(config: ResolvedConfig, existingPath: string): string {
  const fs = require("node:fs");

  let existing: Record<string, unknown> = {};
  try {
    const text = fs.readFileSync(existingPath, "utf-8");
    existing = JSON.parse(text);
  } catch {
    // No existing file — start fresh
  }

  const mcpServers: Record<string, unknown> = {};
  for (const [name, server] of Object.entries(config.servers)) {
    if (!server.enabled) continue;

    const entry: Record<string, unknown> = { command: server.command };
    if (server.args.length > 0) entry.args = server.args;
    if (Object.keys(server.env).length > 0) entry.env = server.env;

    // Map adapter-specific fields (alwaysAllow, disabled, etc.)
    const clineExtras = server.adapters?.cline ?? {};
    for (const [key, value] of Object.entries(clineExtras)) {
      entry[key] = value;
    }

    mcpServers[name] = entry;
  }

  const output = { ...existing, mcpServers };
  return `${JSON.stringify(output, null, 2)}\n`;
}

/** Generate .clinerules/*.md files from instructions. */
function generateRuleFiles(config: ResolvedConfig, projectPath: string): WrittenFile[] {
  const files: WrittenFile[] = [];

  for (const [name, instr] of Object.entries(config.instructions)) {
    if (instr.targets.length > 0 && !instr.targets.includes("cline")) {
      continue;
    }

    const content = `${instr.content}\n`;
    const filePath = join(projectPath, ".clinerules", `${sanitizePathSegment(name)}.md`);
    files.push({ path: filePath, content, written: false });
  }

  return files;
}
