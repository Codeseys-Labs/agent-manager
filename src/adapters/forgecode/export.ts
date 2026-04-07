/**
 * ForgeCode adapter: export resolved config to native format.
 *
 * Generates .mcp.json (project servers — same format as Claude Code)
 * and AGENTS.md (instructions with am:begin/am:end markers).
 */

import { join } from "node:path";
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
 * Export resolved config to ForgeCode native files.
 */
export function exportConfig(
  config: ResolvedConfig,
  options: ExportOptions = {},
): ExportResult {
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

  // 2. Generate AGENTS.md (instructions)
  if (options.projectPath) {
    const instructionContent = generateInstructionBlock(config);
    if (instructionContent) {
      const agentsMdPath = join(options.projectPath, "AGENTS.md");
      const agentsMdContent = generateAgentsMd(
        agentsMdPath,
        instructionContent,
        warnings,
      );
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
      const fcAdapter = skill.adapters?.["forgecode"] ?? {};
      const content = (fcAdapter.content as string) ?? "";
      if (!content) continue;

      const skillPath = join(
        options.projectPath,
        ".forge",
        "skills",
        name,
        "SKILL.md",
      );
      files.push({ path: skillPath, content, written: false });
    }
  }

  // Write files unless dryRun
  if (!options.dryRun) {
    for (const file of files) {
      try {
        const fs = require("node:fs");
        const dir = file.path.substring(0, file.path.lastIndexOf("/"));
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(file.path, file.content, "utf-8");
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

/** Build .mcp.json for project-scoped servers. Same format as Claude Code. */
function generateMcpJson(servers: Record<string, ResolvedServer>): string {
  const mcpServers: Record<string, unknown> = {};
  for (const [name, server] of Object.entries(servers)) {
    const entry: Record<string, unknown> = { command: server.command };
    if (server.args.length > 0) entry.args = server.args;
    if (Object.keys(server.env).length > 0) entry.env = server.env;
    mcpServers[name] = entry;
  }
  return JSON.stringify({ mcpServers }, null, 2) + "\n";
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

/** Generate AGENTS.md content, preserving content outside am markers. */
function generateAgentsMd(
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
    return block + "\n";
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
  return existingContent.trimEnd() + "\n\n" + block + "\n";
}
