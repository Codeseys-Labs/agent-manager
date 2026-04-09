/**
 * Windsurf adapter: import native configs into core format.
 *
 * Reads ~/.codeium/windsurf/mcp_config.json (global MCP servers)
 * and .windsurf/rules/*.md (project instructions with frontmatter).
 */

import { homedir } from "node:os";
import { join } from "node:path";
import type { ImportOptions, ImportResult, ImportedInstruction, ImportedServer } from "../types.ts";
import { extractPackageId } from "./identity.ts";

interface WindsurfServer {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  disabled?: boolean;
  [key: string]: unknown;
}

interface WindsurfMcpConfig {
  mcpServers?: Record<string, WindsurfServer>;
  [key: string]: unknown;
}

/**
 * Import Windsurf native configs into core format.
 */
export function importConfig(options: ImportOptions = {}, homeDir?: string): ImportResult {
  const home = homeDir ?? homedir();
  const entities = options.entities ?? ["servers", "instructions"];
  const warnings: string[] = [];
  const servers: ImportedServer[] = [];
  const instructions: ImportedInstruction[] = [];

  if (entities.includes("servers")) {
    const mcpPath = join(home, ".codeium", "windsurf", "mcp_config.json");
    const mcpServers = readServersFromFile(mcpPath, warnings);
    servers.push(...mcpServers);
  }

  if (entities.includes("instructions") && options.projectPath) {
    const projectInstructions = readRulesDir(options.projectPath, warnings);
    instructions.push(...projectInstructions);

    // Legacy .windsurfrules
    const legacy = readLegacyRules(options.projectPath, warnings);
    if (legacy) {
      instructions.push(legacy);
    }
  }

  return { servers, instructions, skills: [], warnings };
}

const CORE_FIELDS = new Set(["command", "args", "env", "disabled"]);

function readServersFromFile(filePath: string, warnings: string[]): ImportedServer[] {
  const fs = require("node:fs");

  if (!fileExistsSync(filePath)) {
    warnings.push(`File not found: ${filePath}`);
    return [];
  }

  let text: string;
  try {
    text = fs.readFileSync(filePath, "utf-8");
  } catch {
    warnings.push(`Cannot read file: ${filePath}`);
    return [];
  }

  let json: WindsurfMcpConfig;
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
      scope: "global",
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

/**
 * Parse frontmatter from a rule file. Expects YAML-like frontmatter between --- delimiters.
 * Returns the body and parsed trigger/globs fields.
 */
function parseFrontmatter(content: string): {
  body: string;
  trigger?: string;
  globs?: string;
} {
  const match = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) return { body: content };

  const frontmatter = match[1];
  const body = match[2];

  let trigger: string | undefined;
  let globs: string | undefined;

  for (const line of frontmatter.split("\n")) {
    const triggerMatch = line.match(/^trigger:\s*(.+)$/);
    if (triggerMatch) trigger = triggerMatch[1].trim();

    const globsMatch = line.match(/^globs:\s*(.+)$/);
    if (globsMatch) globs = globsMatch[1].trim().replace(/^["']|["']$/g, "");
  }

  return { body, trigger, globs };
}

/** Map Windsurf trigger values to our scope enum. */
function triggerToScope(trigger?: string): "always" | "glob" | "agent-decision" | "manual" {
  switch (trigger) {
    case "always_on":
      return "always";
    case "glob":
      return "glob";
    case "model_decision":
      return "agent-decision";
    case "manual":
      return "manual";
    default:
      return "always";
  }
}

function readRulesDir(projectPath: string, warnings: string[]): ImportedInstruction[] {
  const fs = require("node:fs");
  const rulesDir = join(projectPath, ".windsurf", "rules");

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
      const { body, trigger, globs } = parseFrontmatter(content);
      const name = entry.replace(/\.md$/, "");

      instructions.push({
        name,
        content: body.trim(),
        scope: triggerToScope(trigger),
        description: globs ? `Applies to: ${globs}` : undefined,
        sourcePath: filePath,
      });
    } catch {
      warnings.push(`Cannot read rule file: ${filePath}`);
    }
  }

  return instructions;
}

function readLegacyRules(projectPath: string, warnings: string[]): ImportedInstruction | null {
  const fs = require("node:fs");
  const legacyPath = join(projectPath, ".windsurfrules");

  if (!fileExistsSync(legacyPath)) return null;

  try {
    const content = fs.readFileSync(legacyPath, "utf-8");
    return {
      name: "windsurfrules-legacy",
      content: content.trim(),
      scope: "always",
      description: "Legacy .windsurfrules file",
      sourcePath: legacyPath,
    };
  } catch {
    warnings.push(`Cannot read legacy rules: ${legacyPath}`);
    return null;
  }
}

function fileExistsSync(path: string): boolean {
  try {
    const fs = require("node:fs");
    fs.accessSync(path);
    return true;
  } catch {
    return false;
  }
}
