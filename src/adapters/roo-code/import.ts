/**
 * Roo Code adapter: import native configs into core format.
 *
 * Reads mcp_settings.json (global MCP servers via VS Code globalStorage),
 * .roo/mcp.json (project MCP servers), .roo/rules/*.md (shared rules),
 * .roo/rules-{slug}/*.md (mode-specific rules), and .roomodes (custom modes).
 *
 * Legacy fallback files (.roorules-*, .clinerules-*) are also read.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import type { ImportOptions, ImportResult, ImportedInstruction, ImportedServer } from "../types.ts";
import { getGlobalStoragePath } from "./detect.ts";

interface RooMcpEntry {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  alwaysAllow?: string[];
  disabled?: boolean;
  [key: string]: unknown;
}

interface RooMcpSettings {
  mcpServers?: Record<string, RooMcpEntry>;
}

const CORE_FIELDS = new Set(["command", "args", "env", "disabled", "alwaysAllow"]);

/**
 * Import Roo Code native configs into core format.
 */
export function importConfig(options: ImportOptions = {}, homeDir?: string): ImportResult {
  const home = homeDir ?? homedir();
  const entities = options.entities ?? ["servers", "instructions"];
  const warnings: string[] = [];
  const servers: ImportedServer[] = [];
  const instructions: ImportedInstruction[] = [];

  if (entities.includes("servers")) {
    // Global servers from mcp_settings.json
    const globalServers = loadMcpSettings(home, warnings);
    if (globalServers) {
      servers.push(...extractServers(globalServers, "global"));
    }

    // Project servers from .roo/mcp.json
    if (options.projectPath) {
      const projectMcp = loadProjectMcp(options.projectPath, warnings);
      if (projectMcp) {
        servers.push(...extractServers(projectMcp, "project"));
      }
    }
  }

  if (entities.includes("instructions") && options.projectPath) {
    // Shared rules: .roo/rules/*.md
    const sharedRulesDir = join(options.projectPath, ".roo", "rules");
    instructions.push(...readRulesDir(sharedRulesDir, "roo-shared", warnings));

    // Mode-specific rules: .roo/rules-{slug}/*.md
    instructions.push(...readModeRules(options.projectPath, warnings));

    // Legacy fallbacks: .roorules-* and .clinerules-*
    instructions.push(...readLegacyRules(options.projectPath, warnings));
  }

  return { servers, instructions, skills: [], warnings };
}

function loadMcpSettings(home: string, warnings: string[]): Record<string, RooMcpEntry> | null {
  const fs = require("node:fs");
  const settingsPath = join(getGlobalStoragePath(home), "settings", "mcp_settings.json");

  try {
    fs.accessSync(settingsPath);
  } catch {
    return null;
  }

  let text: string;
  try {
    text = fs.readFileSync(settingsPath, "utf-8");
  } catch {
    warnings.push(`Cannot read file: ${settingsPath}`);
    return null;
  }

  let parsed: RooMcpSettings;
  try {
    parsed = JSON.parse(text);
  } catch {
    if (text.trim() !== "") warnings.push(`Malformed JSON: ${settingsPath}`);
    return null;
  }

  return parsed.mcpServers ?? null;
}

function loadProjectMcp(
  projectPath: string,
  warnings: string[],
): Record<string, RooMcpEntry> | null {
  const fs = require("node:fs");
  const mcpPath = join(projectPath, ".roo", "mcp.json");

  try {
    fs.accessSync(mcpPath);
  } catch {
    return null;
  }

  let text: string;
  try {
    text = fs.readFileSync(mcpPath, "utf-8");
  } catch {
    warnings.push(`Cannot read file: ${mcpPath}`);
    return null;
  }

  let parsed: RooMcpSettings;
  try {
    parsed = JSON.parse(text);
  } catch {
    if (text.trim() !== "") warnings.push(`Malformed JSON: ${mcpPath}`);
    return null;
  }

  return parsed.mcpServers ?? null;
}

function extractServers(
  mcpServers: Record<string, RooMcpEntry>,
  scope: "global" | "project",
): ImportedServer[] {
  const servers: ImportedServer[] = [];

  for (const [name, entry] of Object.entries(mcpServers)) {
    if (!entry || typeof entry !== "object" || !entry.command) continue;

    const adapterExtras: Record<string, unknown> = {};

    if (entry.alwaysAllow && entry.alwaysAllow.length > 0) {
      adapterExtras.alwaysAllow = entry.alwaysAllow;
    }

    if (entry.disabled === true) {
      adapterExtras.disabled = true;
    }

    for (const [key, value] of Object.entries(entry)) {
      if (!CORE_FIELDS.has(key)) {
        adapterExtras[key] = value;
      }
    }

    servers.push({
      name,
      command: entry.command,
      scope,
      ...(entry.args && entry.args.length > 0 && { args: entry.args }),
      ...(entry.env && Object.keys(entry.env).length > 0 && { env: entry.env }),
      enabled: entry.disabled !== true,
      ...(Object.keys(adapterExtras).length > 0 && { adapterExtras }),
    });
  }

  return servers;
}

/**
 * Read shared rules from .roo/rules/*.md
 */
function readRulesDir(dirPath: string, prefix: string, warnings: string[]): ImportedInstruction[] {
  const fs = require("node:fs");
  const results: ImportedInstruction[] = [];

  try {
    fs.accessSync(dirPath);
  } catch {
    return results;
  }

  let entries: string[];
  try {
    entries = fs.readdirSync(dirPath);
  } catch {
    warnings.push(`Cannot read rules directory: ${dirPath}`);
    return results;
  }

  for (const entry of entries) {
    if (!entry.endsWith(".md")) continue;
    const filePath = join(dirPath, entry);
    try {
      const content = fs.readFileSync(filePath, "utf-8");
      const name = `${prefix}-${entry.replace(".md", "")}`;
      results.push({
        name,
        content,
        scope: "always",
        description: `Roo Code rule: ${entry}`,
        sourcePath: filePath,
      });
    } catch {
      warnings.push(`Cannot read rule file: ${filePath}`);
    }
  }

  return results;
}

/**
 * Read mode-specific rules from .roo/rules-{slug}/*.md directories.
 */
function readModeRules(projectPath: string, warnings: string[]): ImportedInstruction[] {
  const fs = require("node:fs");
  const rooDir = join(projectPath, ".roo");
  const results: ImportedInstruction[] = [];

  let entries: string[];
  try {
    entries = fs.readdirSync(rooDir);
  } catch {
    return results;
  }

  for (const entry of entries) {
    if (!entry.startsWith("rules-")) continue;
    const slug = entry.replace("rules-", "");
    const modeRulesDir = join(rooDir, entry);

    try {
      const stat = fs.statSync(modeRulesDir);
      if (!stat.isDirectory()) continue;
    } catch {
      continue;
    }

    const rules = readRulesDir(modeRulesDir, `roo-mode-${slug}`, warnings);
    results.push(...rules);
  }

  return results;
}

/**
 * Read legacy rule files: .roorules-* and .clinerules-*
 */
function readLegacyRules(projectPath: string, warnings: string[]): ImportedInstruction[] {
  const fs = require("node:fs");
  const results: ImportedInstruction[] = [];

  let entries: string[];
  try {
    entries = fs.readdirSync(projectPath);
  } catch {
    return results;
  }

  for (const entry of entries) {
    const isRooLegacy = entry.startsWith(".roorules-");
    const isClineLegacy = entry.startsWith(".clinerules-");
    if (!isRooLegacy && !isClineLegacy) continue;

    const filePath = join(projectPath, entry);
    try {
      const stat = fs.statSync(filePath);
      if (!stat.isFile()) continue;
      const content = fs.readFileSync(filePath, "utf-8");
      const slug = isRooLegacy
        ? entry.replace(".roorules-", "")
        : entry.replace(".clinerules-", "");
      const prefix = isRooLegacy ? "roorules" : "clinerules";
      results.push({
        name: `${prefix}-${slug}`,
        content,
        scope: "always",
        description: `Roo Code legacy rule: ${entry}`,
        sourcePath: filePath,
      });
    } catch {
      warnings.push(`Cannot read legacy rule: ${filePath}`);
    }
  }

  return results;
}
