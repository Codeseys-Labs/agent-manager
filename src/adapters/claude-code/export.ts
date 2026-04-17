/**
 * Claude Code adapter: export resolved config to native format.
 *
 * Generates ~/.claude.json (mcpServers), .mcp.json (project servers),
 * and CLAUDE.md (instructions with am:begin/am:end markers).
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { atomicWriteFileSync } from "../../core/atomic-write.ts";
import { generateWikiContext, spliceWikiBlock } from "../../core/instructions.ts";
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
  const globalContent = generateClaudeJson(globalServers, config, globalPath, warnings);
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

/** Build the mcpServers object for ~/.claude.json, preserving existing non-MCP fields. */
function generateClaudeJson(
  servers: Record<string, ResolvedServer>,
  config: ResolvedConfig,
  existingPath: string,
  warnings: string[],
): string {
  // Read existing file to preserve non-MCP fields (numStartups, etc.)
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
    const ccExtras = server.adapters?.["claude-code"] ?? {};
    for (const [key, value] of Object.entries(ccExtras)) {
      if (key === "scope") continue; // internal routing hint
      // Map core field names to Claude Code native names
      if (key === "alwaysAllow" || key === "always_allow") {
        entry.always_allow = value;
      } else {
        entry[key] = value;
      }
    }

    mcpServers[name] = entry;
  }

  const output = { ...existing, mcpServers };
  return `${JSON.stringify(output, null, 2)}\n`;
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

/** Generate CLAUDE.md content, preserving content outside am markers. */
function generateClaudeMd(
  existingPath: string,
  managedContent: string,
  warnings: string[],
): string {
  const block = `${AM_BEGIN}\n${managedContent}\n${AM_END}`;

  let existingContent = "";
  try {
    const fs = require("node:fs");
    existingContent = fs.readFileSync(existingPath, "utf-8");
  } catch {
    // No existing file — just return the managed block
    return `${block}\n`;
  }

  // Replace existing managed section if present
  const beginIdx = existingContent.indexOf(AM_BEGIN);
  const endIdx = existingContent.indexOf(AM_END);
  if (beginIdx !== -1 && endIdx !== -1) {
    const before = existingContent.slice(0, beginIdx);
    const after = existingContent.slice(endIdx + AM_END.length);
    return before + block + after;
  }

  // Append managed section to existing content
  return `${existingContent.trimEnd()}\n\n${block}\n`;
}
