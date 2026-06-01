/**
 * Cursor adapter: export resolved config to native format.
 *
 * Generates .cursor/mcp.json (project MCP), ~/.cursor/mcp.json (global MCP),
 * .cursor/rules/*.mdc (instructions), and .cursor/agents/*.md (agents).
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { generateCursorMdc } from "../../core/instructions.ts";
import { sanitizePathSegment } from "../../lib/safe-path.ts";
import { writeExportFiles } from "../shared/export-utils.ts";
import type {
  ExportOptions,
  ExportResult,
  ResolvedAgent,
  ResolvedConfig,
  ResolvedServer,
  WrittenFile,
} from "../types.ts";

/**
 * Export resolved config to Cursor native files.
 */
export function exportConfig(
  config: ResolvedConfig,
  options: ExportOptions = {},
  homeDir?: string,
): ExportResult {
  const home = homeDir ?? homedir();
  const files: WrittenFile[] = [];
  const warnings: string[] = [];

  // Partition servers by scope
  const globalServers: Record<string, ResolvedServer> = {};
  const projectServers: Record<string, ResolvedServer> = {};

  for (const [name, server] of Object.entries(config.servers)) {
    if (!server.enabled) continue;
    const cursorAdapter = server.adapters?.cursor ?? {};
    if (cursorAdapter.scope === "project") {
      projectServers[name] = server;
    } else {
      globalServers[name] = server;
    }
  }

  // 1. Generate ~/.cursor/mcp.json (global)
  if (Object.keys(globalServers).length > 0) {
    const globalPath = join(home, ".cursor", "mcp.json");
    const globalContent = generateMcpJson(globalServers, globalPath, warnings);
    files.push({ path: globalPath, content: globalContent, written: false });
  }

  // 2. Generate .cursor/mcp.json (project)
  if (options.projectPath && Object.keys(projectServers).length > 0) {
    const mcpPath = join(options.projectPath, ".cursor", "mcp.json");
    const mcpContent = generateMcpJson(projectServers, mcpPath, warnings);
    files.push({ path: mcpPath, content: mcpContent, written: false });
  }

  // 3. Generate .cursor/rules/*.mdc (instructions)
  if (options.projectPath) {
    const ruleFiles = generateMdcRules(config, options.projectPath);
    files.push(...ruleFiles);
  }

  // 4. Generate .cursor/agents/*.md (agents)
  if (options.projectPath) {
    const agentFiles = generateAgentFiles(config, options.projectPath);
    files.push(...agentFiles);
  }

  writeExportFiles(files, warnings, { dryRun: options.dryRun });

  return { files, warnings };
}

/** Build mcpServers JSON, preserving existing non-MCP fields. */
function generateMcpJson(
  servers: Record<string, ResolvedServer>,
  existingPath: string,
  warnings: string[],
): string {
  let existing: Record<string, unknown> = {};
  try {
    const fs = require("node:fs");
    const text = fs.readFileSync(existingPath, "utf-8");
    existing = JSON.parse(text);
  } catch {
    // No existing file — start fresh
  }

  const mcpServers: Record<string, unknown> = {};
  for (const [name, server] of Object.entries(servers)) {
    const cursorExtras = server.adapters?.cursor ?? {};

    // URL-based (remote) server
    if (cursorExtras.url) {
      const entry: Record<string, unknown> = { url: cursorExtras.url };
      if (cursorExtras.headers) entry.headers = cursorExtras.headers;
      if (Object.keys(server.env).length > 0) entry.env = server.env;
      mcpServers[name] = entry;
      continue;
    }

    // Command-based (stdio) server
    const entry: Record<string, unknown> = { command: server.command };
    if (server.args.length > 0) entry.args = server.args;
    if (Object.keys(server.env).length > 0) entry.env = server.env;

    // Pass through cursor-specific extras (skip internal routing hints)
    for (const [key, value] of Object.entries(cursorExtras)) {
      if (key === "scope" || key === "url" || key === "headers") continue;
      entry[key] = value;
    }

    mcpServers[name] = entry;
  }

  const output = { ...existing, mcpServers };
  return `${JSON.stringify(output, null, 2)}\n`;
}

/** Generate .cursor/rules/*.mdc files from instructions. */
function generateMdcRules(config: ResolvedConfig, projectPath: string): WrittenFile[] {
  const files: WrittenFile[] = [];

  for (const [name, instr] of Object.entries(config.instructions)) {
    // Skip instructions not targeted at cursor
    if (instr.targets.length > 0 && !instr.targets.includes("cursor")) {
      continue;
    }

    const mdcContent = generateCursorMdc(instr);
    const safeName = sanitizePathSegment(name);
    const filePath = join(projectPath, ".cursor", "rules", `${safeName}.mdc`);
    files.push({ path: filePath, content: mdcContent, written: false });
  }

  return files;
}

/** Generate .cursor/agents/*.md files from agents. */
function generateAgentFiles(config: ResolvedConfig, projectPath: string): WrittenFile[] {
  const files: WrittenFile[] = [];

  for (const [name, agent] of Object.entries(config.agents)) {
    const content = generateAgentMd(agent);
    const safeName = sanitizePathSegment(name);
    const filePath = join(projectPath, ".cursor", "agents", `${safeName}.md`);
    files.push({ path: filePath, content, written: false });
  }

  return files;
}

/** Generate agent markdown file. */
function generateAgentMd(agent: ResolvedAgent): string {
  const parts: string[] = [];

  parts.push(`# ${agent.name}`);
  parts.push("");

  if (agent.description) {
    parts.push(agent.description);
    parts.push("");
  }

  if (agent.prompt) {
    parts.push(agent.prompt);
    parts.push("");
  }

  return parts.join("\n");
}
