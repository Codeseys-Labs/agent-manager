/**
 * Amazon Q adapter: import native configs into core format.
 *
 * Reads ~/.aws/amazonq/mcp.json (global MCP servers)
 * and .amazonq/rules/*.md (project instructions — plain markdown).
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { fileExistsSync } from "../shared/utils.ts";
import type { ImportOptions, ImportResult, ImportedInstruction, ImportedServer } from "../types.ts";
import { extractPackageId } from "./identity.ts";

interface AmazonQServer {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  disabled?: boolean;
  [key: string]: unknown;
}

interface AmazonQMcpConfig {
  mcpServers?: Record<string, AmazonQServer>;
  [key: string]: unknown;
}

/**
 * Import Amazon Q native configs into core format.
 */
export function importConfig(options: ImportOptions = {}, homeDir?: string): ImportResult {
  const home = homeDir ?? homedir();
  const entities = options.entities ?? ["servers", "instructions"];
  const warnings: string[] = [];
  const servers: ImportedServer[] = [];
  const instructions: ImportedInstruction[] = [];

  if (entities.includes("servers")) {
    // Global servers from ~/.aws/amazonq/mcp.json
    const globalMcpPath = join(home, ".aws", "amazonq", "mcp.json");
    const globalServers = readServersFromFile(globalMcpPath, "global", warnings);
    servers.push(...globalServers);

    // Project servers from .amazonq/mcp.json
    if (options.projectPath) {
      const projectMcpPath = join(options.projectPath, ".amazonq", "mcp.json");
      const projectServers = readServersFromFile(projectMcpPath, "project", warnings);
      servers.push(...projectServers);
    }
  }

  if (entities.includes("instructions") && options.projectPath) {
    const projectInstructions = readRulesDir(options.projectPath, warnings);
    instructions.push(...projectInstructions);
  }

  return { servers, instructions, skills: [], warnings };
}

const CORE_FIELDS = new Set(["command", "args", "env", "disabled"]);

function readServersFromFile(
  filePath: string,
  scope: "global" | "project",
  warnings: string[],
): ImportedServer[] {
  const fs = require("node:fs");

  if (!fileExistsSync(filePath)) {
    if (scope === "global") {
      warnings.push(`File not found: ${filePath}`);
    }
    return [];
  }

  let text: string;
  try {
    text = fs.readFileSync(filePath, "utf-8");
  } catch {
    warnings.push(`Cannot read file: ${filePath}`);
    return [];
  }

  let json: AmazonQMcpConfig;
  try {
    json = JSON.parse(text);
  } catch {
    warnings.push(`Malformed JSON: ${filePath}`);
    return [];
  }

  const mcpServers = json.mcpServers;
  if (!mcpServers || typeof mcpServers !== "object") {
    return [];
  }

  const results: ImportedServer[] = [];
  for (const [name, entry] of Object.entries(mcpServers)) {
    if (!entry || typeof entry !== "object" || !entry.command) continue;

    const adapterExtras: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(entry)) {
      if (!CORE_FIELDS.has(key)) {
        adapterExtras[key] = value;
      }
    }

    const server: ImportedServer = {
      name,
      command: entry.command,
      scope,
      ...(entry.args && { args: entry.args }),
      ...(entry.env && { env: entry.env }),
      enabled: entry.disabled !== true,
      packageId: extractPackageId(entry.command, entry.args),
      ...(Object.keys(adapterExtras).length > 0 && { adapterExtras }),
    };

    results.push(server);
  }

  return results;
}

function readRulesDir(projectPath: string, warnings: string[]): ImportedInstruction[] {
  const fs = require("node:fs");
  const rulesDir = join(projectPath, ".amazonq", "rules");

  if (!fileExistsSync(rulesDir)) {
    return [];
  }

  let entries: string[];
  try {
    entries = fs.readdirSync(rulesDir);
  } catch {
    warnings.push(`Cannot read rules directory: ${rulesDir}`);
    return [];
  }

  const instructions: ImportedInstruction[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".md")) continue;
    const filePath = join(rulesDir, entry);
    try {
      const content = fs.readFileSync(filePath, "utf-8");
      const name = entry.replace(/\.md$/, "");

      instructions.push({
        name,
        content: content.trim(),
        scope: "always",
        sourcePath: filePath,
      });
    } catch {
      warnings.push(`Cannot read rule file: ${filePath}`);
    }
  }

  return instructions;
}
