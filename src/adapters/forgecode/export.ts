/**
 * ForgeCode adapter: export resolved config to native format.
 *
 * Generates .mcp.json (project servers — same format as Claude Code)
 * and AGENTS.md (instructions with am:begin/am:end markers).
 */

import { join } from "node:path";
import { generateWikiContext, spliceWikiBlock } from "../../core/instructions.ts";
import { sanitizePathSegment } from "../../lib/safe-path.ts";
import { writeExportFiles } from "../shared/export-utils.ts";
import { AM_BEGIN, AM_END, spliceMarkerBlock } from "../shared/utils.ts";
import type {
  ExportOptions,
  ExportResult,
  ResolvedConfig,
  ResolvedServer,
  WrittenFile,
} from "../types.ts";

/**
 * Export resolved config to ForgeCode native files.
 */
export async function exportConfig(
  config: ResolvedConfig,
  options: ExportOptions = {},
): Promise<ExportResult> {
  const files: WrittenFile[] = [];
  const warnings: string[] = [];

  // Collect project-scoped servers (ForgeCode only uses .mcp.json at project level)
  const projectServers: Record<string, ResolvedServer> = {};
  for (const [name, server] of Object.entries(config.servers)) {
    if (!server.enabled) continue;
    projectServers[name] = server;
  }

  // 1. Generate .mcp.json
  if (options.projectPath && Object.keys(projectServers).length > 0) {
    const mcpPath = join(options.projectPath, ".mcp.json");
    const mcpContent = generateMcpJson(projectServers);
    files.push({ path: mcpPath, content: mcpContent, written: false });
  }

  // 2. Generate AGENTS.md (instructions + optional wiki context)
  if (options.projectPath) {
    const instructionContent = generateInstructionBlock(config);
    if (instructionContent) {
      const agentsMdPath = join(options.projectPath, "AGENTS.md");
      const block = `${AM_BEGIN}\n${instructionContent}\n${AM_END}`;
      let existingContent: string | undefined;
      try {
        const fs = require("node:fs");
        existingContent = fs.readFileSync(agentsMdPath, "utf-8");
      } catch {
        // No existing file
      }
      let agentsMdContent = spliceMarkerBlock(block, existingContent);

      // Inject wiki context if enabled
      const configDir = options.projectPath;
      const wikiBlock = await generateWikiContext(configDir, config.settings);
      if (wikiBlock) {
        agentsMdContent = spliceWikiBlock(wikiBlock, agentsMdContent);
      }

      files.push({
        path: agentsMdPath,
        content: agentsMdContent,
        written: false,
      });
    }
  }

  // 3. Write skills to .forge/skills/
  if (options.projectPath) {
    for (const [name, skill] of Object.entries(config.skills)) {
      const fcAdapter = skill.adapters?.forgecode ?? {};
      const content = (fcAdapter.content as string) ?? "";
      if (!content) continue;

      const skillPath = join(
        options.projectPath,
        ".forge",
        "skills",
        sanitizePathSegment(name),
        "SKILL.md",
      );
      files.push({ path: skillPath, content, written: false });
    }
  }

  writeExportFiles(files, warnings, { dryRun: options.dryRun });

  return { files, warnings };
}

/** Build .mcp.json for project-scoped servers. Same format as Claude Code. */
function generateMcpJson(servers: Record<string, ResolvedServer>): string {
  const mcpServers: Record<string, unknown> = {};
  for (const [name, server] of Object.entries(servers)) {
    const entry: Record<string, unknown> = { command: server.command };
    if (server.args.length > 0) entry.args = server.args;
    if (Object.keys(server.env).length > 0) entry.env = server.env;
    mcpServers[name] = entry;
  }
  return `${JSON.stringify({ mcpServers }, null, 2)}\n`;
}

/** Concatenate all instructions into a single markdown block. */
function generateInstructionBlock(config: ResolvedConfig): string | null {
  const parts: string[] = [];
  for (const [, instr] of Object.entries(config.instructions)) {
    if (instr.targets.length > 0 && !instr.targets.includes("forgecode")) {
      continue;
    }
    parts.push(instr.content);
  }
  if (parts.length === 0) return null;
  return parts.join("\n\n");
}
