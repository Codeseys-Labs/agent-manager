/**
 * Roo Code adapter: export resolved config to native format.
 *
 * Generates mcp_settings.json (global MCP servers via VS Code globalStorage),
 * .roo/mcp.json (project MCP servers), and .roo/rules/*.md (instructions).
 */

import { homedir } from "node:os";
import { join } from "node:path";
import type {
  ExportOptions,
  ExportResult,
  ResolvedConfig,
  ResolvedServer,
  WrittenFile,
} from "../types.ts";
import { getGlobalStoragePath } from "./detect.ts";

/**
 * Export resolved config to Roo Code native files.
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
    const rooAdapter = server.adapters?.["roo-code"] ?? {};
    if (rooAdapter.scope === "project") {
      projectServers[name] = server;
    } else {
      globalServers[name] = server;
    }
  }

  // 1. Generate global mcp_settings.json
  const mcpPath = join(getGlobalStoragePath(home), "settings", "mcp_settings.json");
  const mcpContent = generateMcpSettings(globalServers, mcpPath);
  files.push({ path: mcpPath, content: mcpContent, written: false });

  // 2. Generate .roo/mcp.json (project-scoped servers)
  if (options.projectPath && Object.keys(projectServers).length > 0) {
    const projectMcpPath = join(options.projectPath, ".roo", "mcp.json");
    const projectMcpContent = generateMcpSettings(projectServers, projectMcpPath);
    files.push({
      path: projectMcpPath,
      content: projectMcpContent,
      written: false,
    });
  }

  // 3. Generate .roo/rules/*.md (instructions)
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

/** Generate mcp_settings.json or .roo/mcp.json, preserving existing non-managed fields. */
function generateMcpSettings(
  servers: Record<string, ResolvedServer>,
  existingPath: string,
): string {
  const fs = require("node:fs");

  let existing: Record<string, unknown> = {};
  try {
    const text = fs.readFileSync(existingPath, "utf-8");
    existing = JSON.parse(text);
  } catch {
    // No existing file — start fresh
  }

  const mcpServers: Record<string, unknown> = {};
  for (const [name, server] of Object.entries(servers)) {
    const entry: Record<string, unknown> = { command: server.command };
    if (server.args.length > 0) entry.args = server.args;
    if (Object.keys(server.env).length > 0) entry.env = server.env;

    // Map adapter-specific fields (alwaysAllow, disabled, etc.)
    const rooExtras = server.adapters?.["roo-code"] ?? {};
    for (const [key, value] of Object.entries(rooExtras)) {
      if (key === "scope") continue; // internal routing hint
      entry[key] = value;
    }

    mcpServers[name] = entry;
  }

  const output = { ...existing, mcpServers };
  return `${JSON.stringify(output, null, 2)}\n`;
}

/** Generate .roo/rules/*.md files from instructions. */
function generateRuleFiles(config: ResolvedConfig, projectPath: string): WrittenFile[] {
  const files: WrittenFile[] = [];

  for (const [name, instr] of Object.entries(config.instructions)) {
    if (instr.targets.length > 0 && !instr.targets.includes("roo-code")) {
      continue;
    }

    const content = `${instr.content}\n`;
    const filePath = join(projectPath, ".roo", "rules", `${name}.md`);
    files.push({ path: filePath, content, written: false });
  }

  return files;
}
