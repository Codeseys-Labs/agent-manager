/**
 * Amazon Q adapter: export resolved config to native format.
 *
 * Generates ~/.aws/amazonq/mcp.json (mcpServers)
 * and .amazonq/rules/*.md (plain markdown instructions).
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { sanitizePathSegment } from "../../lib/safe-path.ts";
import { buildMcpServersJson, writeExportFiles } from "../shared/export-utils.ts";
import type {
  ExportOptions,
  ExportResult,
  ResolvedConfig,
  ResolvedServer,
  WrittenFile,
} from "../types.ts";

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
  const enabledServers: Record<string, ResolvedServer> = {};
  for (const [name, server] of Object.entries(config.servers)) {
    if (server.enabled) enabledServers[name] = server;
  }
  const mcpPath = join(home, ".aws", "amazonq", "mcp.json");
  const mcpContent = buildMcpServersJson(enabledServers, mcpPath, { adapterKey: "amazon-q" });
  files.push({ path: mcpPath, content: mcpContent, written: false });

  // 2. Generate .amazonq/rules/*.md (instructions)
  if (options.projectPath) {
    const ruleFiles = generateRuleFiles(config, options.projectPath);
    files.push(...ruleFiles);
  }

  writeExportFiles(files, warnings, { dryRun: options.dryRun });

  return { files, warnings };
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
