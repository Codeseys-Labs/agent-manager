/**
 * Cline adapter: export resolved config to native format.
 *
 * Generates cline_mcp_settings.json (MCP servers) and
 * .clinerules/*.md (instructions).
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
  const enabledServers: Record<string, ResolvedServer> = {};
  for (const [name, server] of Object.entries(config.servers)) {
    if (server.enabled) enabledServers[name] = server;
  }
  const mcpPath = join(getGlobalStoragePath(home), "settings", "cline_mcp_settings.json");
  const mcpContent = buildMcpServersJson(enabledServers, mcpPath, { adapterKey: "cline" });
  files.push({ path: mcpPath, content: mcpContent, written: false });

  // 2. Generate .clinerules/*.md (instructions)
  if (options.projectPath) {
    const ruleFiles = generateRuleFiles(config, options.projectPath);
    files.push(...ruleFiles);
  }

  writeExportFiles(files, warnings, { dryRun: options.dryRun });

  return { files, warnings };
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
