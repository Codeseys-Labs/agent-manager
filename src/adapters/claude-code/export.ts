/**
 * Claude Code adapter: export resolved config to native format.
 *
 * Generates ~/.claude.json (mcpServers), .mcp.json (project servers),
 * and CLAUDE.md (instructions with am:begin/am:end markers).
 */

import { homedir } from "node:os";
import { join } from "node:path";
import {
  generateWikiContext,
  spliceMarkerBlock,
  spliceWikiBlock,
} from "../../core/instructions.ts";
import { buildMcpServersJson, writeExportFiles } from "../shared/export-utils.ts";
import type {
  ExportOptions,
  ExportResult,
  ResolvedConfig,
  ResolvedServer,
  WrittenFile,
} from "../types.ts";

const AM_BEGIN = "<!-- am:begin -->";
const AM_END = "<!-- am:end -->";

/**
 * Export resolved config to Claude Code native files.
 */
export async function exportConfig(
  config: ResolvedConfig,
  options: ExportOptions = {},
  homeDir?: string,
): Promise<ExportResult> {
  const home = homeDir ?? homedir();
  const files: WrittenFile[] = [];
  const warnings: string[] = [];

  // Partition servers by scope (presence of claude-code adapter scope hint)
  const globalServers: Record<string, ResolvedServer> = {};
  const projectServers: Record<string, ResolvedServer> = {};

  for (const [name, server] of Object.entries(config.servers)) {
    if (!server.enabled) continue;
    const ccAdapter = server.adapters?.["claude-code"] ?? {};
    if (ccAdapter.scope === "project") {
      projectServers[name] = server;
    } else {
      globalServers[name] = server;
    }
  }

  // 1. Generate ~/.claude.json
  const globalPath = join(home, ".claude.json");
  const globalContent = buildMcpServersJson(globalServers, globalPath, {
    adapterKey: "claude-code",
    skipExtras: ["scope"],
    // Map core field names to Claude Code native names.
    mapExtra: (key, value) =>
      key === "alwaysAllow" || key === "always_allow" ? ["always_allow", value] : [key, value],
  });
  files.push({
    path: globalPath,
    content: globalContent,
    written: false,
  });

  // 2. Generate .mcp.json (project-scoped servers)
  if (options.projectPath && Object.keys(projectServers).length > 0) {
    const mcpPath = join(options.projectPath, ".mcp.json");
    const mcpContent = generateMcpJson(projectServers);
    files.push({ path: mcpPath, content: mcpContent, written: false });
  }

  // 3. Generate CLAUDE.md (instructions + optional wiki context)
  if (options.projectPath) {
    const instructionContent = generateInstructionBlock(config);
    if (instructionContent) {
      const claudeMdPath = join(options.projectPath, "CLAUDE.md");
      let claudeMdContent = generateClaudeMd(claudeMdPath, instructionContent, warnings);

      // Inject wiki context if enabled
      const configDir = options.projectPath;
      const wikiBlock = await generateWikiContext(configDir, config.settings);
      if (wikiBlock) {
        claudeMdContent = spliceWikiBlock(wikiBlock, claudeMdContent);
      }

      files.push({
        path: claudeMdPath,
        content: claudeMdContent,
        written: false,
      });
    }
  }

  writeExportFiles(files, warnings, { dryRun: options.dryRun });

  return { files, warnings };
}

/** Build .mcp.json for project-scoped servers. */
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
    if (instr.targets.length > 0 && !instr.targets.includes("claude-code")) {
      continue;
    }
    parts.push(instr.content);
  }
  if (parts.length === 0) return null;
  return parts.join("\n\n");
}

/**
 * Generate CLAUDE.md content, preserving content outside am markers.
 *
 * Reads the existing file (if any) and delegates the marker splice to the
 * shared {@link spliceMarkerBlock} helper so the fail-closed guard (H3) is
 * enforced in ONE place: well-formed markers are replaced in place; malformed
 * (out-of-order / unpaired) markers leave the file UNCHANGED and push a warning
 * rather than scrambling user prose or duplicating the managed block.
 */
function generateClaudeMd(
  existingPath: string,
  managedContent: string,
  warnings: string[],
): string {
  const block = `${AM_BEGIN}\n${managedContent}\n${AM_END}`;

  let existingContent: string | undefined;
  try {
    const fs = require("node:fs");
    existingContent = fs.readFileSync(existingPath, "utf-8");
  } catch {
    // No existing file — just return the managed block.
    existingContent = undefined;
  }

  return spliceMarkerBlock(block, existingContent, warnings, "CLAUDE.md");
}
