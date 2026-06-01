/**
 * Amazon Q adapter: export resolved config to native format.
 *
 * Generates ~/.aws/amazonq/mcp.json (mcpServers)
 * and .amazonq/rules/*.md (plain markdown instructions).
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { atomicWriteFileSync } from "../../core/atomic-write.ts";
import { sanitizePathSegment } from "../../lib/safe-path.ts";
import type { ExportOptions, ExportResult, ResolvedConfig, WrittenFile } from "../types.ts";

/**
 * Export resolved config to Amazon Q native files.
 */
export function exportConfig(
  config: ResolvedConfig,
  options: ExportOptions = {},
  homeDir?: string,
): ExportResult {
  const home = homeDir ?? homedir();
  const files: WrittenFile[] = [];
  const warnings: string[] = [];

  // 1. Generate ~/.aws/amazonq/mcp.json
  const mcpPath = join(home, ".aws", "amazonq", "mcp.json");
  const mcpContent = generateMcpConfig(config, mcpPath);
  files.push({ path: mcpPath, content: mcpContent, written: false });

  // 2. Generate .amazonq/rules/*.md (instructions)
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

/** Generate mcp.json, preserving existing non-MCP fields. */
function generateMcpConfig(config: ResolvedConfig, existingPath: string): string {
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

    // Map adapter-specific fields
    const aqExtras = server.adapters?.["amazon-q"] ?? {};
    for (const [key, value] of Object.entries(aqExtras)) {
      entry[key] = value;
    }

    mcpServers[name] = entry;
  }

  const output = { ...existing, mcpServers };
  return `${JSON.stringify(output, null, 2)}\n`;
}

/** Generate .amazonq/rules/*.md files from instructions (plain markdown). */
function generateRuleFiles(config: ResolvedConfig, projectPath: string): WrittenFile[] {
  const files: WrittenFile[] = [];

  for (const [name, instr] of Object.entries(config.instructions)) {
    if (instr.targets.length > 0 && !instr.targets.includes("amazon-q")) {
      continue;
    }

    const content = `${instr.content}\n`;
    const filePath = join(projectPath, ".amazonq", "rules", `${sanitizePathSegment(name)}.md`);
    files.push({ path: filePath, content, written: false });
  }

  return files;
}
