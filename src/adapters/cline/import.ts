/**
 * Cline adapter: import native configs into core format.
 *
 * Reads cline_mcp_settings.json (MCP servers) and
 * .clinerules (file or directory) for instructions.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import type { ImportOptions, ImportResult, ImportedInstruction, ImportedServer } from "../types.ts";
import { getGlobalStoragePath } from "./detect.ts";

interface ClineMcpEntry {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  alwaysAllow?: string[];
  disabled?: boolean;
  [key: string]: unknown;
}

interface ClineMcpSettings {
  mcpServers?: Record<string, ClineMcpEntry>;
}

const CORE_FIELDS = new Set(["command", "args", "env", "disabled", "alwaysAllow"]);

/**
 * Import Cline native configs into core format.
 */
export function importConfig(options: ImportOptions = {}, homeDir?: string): ImportResult {
  const home = homeDir ?? homedir();
  const entities = options.entities ?? ["servers", "instructions"];
  const warnings: string[] = [];
  const servers: ImportedServer[] = [];
  const instructions: ImportedInstruction[] = [];

  if (entities.includes("servers")) {
    const mcpSettings = loadMcpSettings(home, warnings);
    if (mcpSettings?.mcpServers) {
      servers.push(...extractServers(mcpSettings.mcpServers));
    }
  }

  if (entities.includes("instructions") && options.projectPath) {
    instructions.push(...readClinerules(options.projectPath, warnings));
  }

  return { servers, instructions, skills: [], warnings };
}

function loadMcpSettings(home: string, warnings: string[]): ClineMcpSettings | null {
  const fs = require("node:fs");
  const settingsPath = join(getGlobalStoragePath(home), "settings", "cline_mcp_settings.json");

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

  try {
    return JSON.parse(text) as ClineMcpSettings;
  } catch {
    if (text.trim() !== "") warnings.push(`Malformed JSON: ${settingsPath}`);
    return null;
  }
}

function extractServers(mcpServers: Record<string, ClineMcpEntry>): ImportedServer[] {
  const servers: ImportedServer[] = [];

  for (const [name, entry] of Object.entries(mcpServers)) {
    if (!entry || typeof entry !== "object" || !entry.command) continue;

    const adapterExtras: Record<string, unknown> = {};

    // Carry alwaysAllow into extras
    if (entry.alwaysAllow && entry.alwaysAllow.length > 0) {
      adapterExtras.alwaysAllow = entry.alwaysAllow;
    }

    // Carry disabled into extras
    if (entry.disabled === true) {
      adapterExtras.disabled = true;
    }

    // Collect any other non-core fields
    for (const [key, value] of Object.entries(entry)) {
      if (!CORE_FIELDS.has(key)) {
        adapterExtras[key] = value;
      }
    }

    servers.push({
      name,
      command: entry.command,
      scope: "global",
      ...(entry.args && entry.args.length > 0 && { args: entry.args }),
      ...(entry.env && Object.keys(entry.env).length > 0 && { env: entry.env }),
      enabled: entry.disabled !== true,
      ...(Object.keys(adapterExtras).length > 0 && { adapterExtras }),
    });
  }

  return servers;
}

/**
 * Read instructions from .clinerules (file or directory).
 */
function readClinerules(projectPath: string, warnings: string[]): ImportedInstruction[] {
  const fs = require("node:fs");
  const results: ImportedInstruction[] = [];
  const rulesPath = join(projectPath, ".clinerules");

  try {
    fs.accessSync(rulesPath);
  } catch {
    return results;
  }

  let stat: { isDirectory: () => boolean };
  try {
    stat = fs.statSync(rulesPath);
  } catch {
    return results;
  }

  if (stat.isDirectory()) {
    // Modern format: .clinerules/*.md
    let entries: string[];
    try {
      entries = fs.readdirSync(rulesPath);
    } catch {
      warnings.push(`Cannot read rules directory: ${rulesPath}`);
      return results;
    }

    for (const entry of entries) {
      if (!entry.endsWith(".md")) continue;
      const filePath = join(rulesPath, entry);
      try {
        const content = fs.readFileSync(filePath, "utf-8");
        const name = `cline-rule-${entry.replace(".md", "")}`;
        results.push({
          name,
          content,
          scope: "always",
          description: `Cline project rule: ${entry}`,
          sourcePath: filePath,
        });
      } catch {
        warnings.push(`Cannot read rule file: ${filePath}`);
      }
    }
  } else {
    // Legacy format: .clinerules as a single file
    try {
      const content = fs.readFileSync(rulesPath, "utf-8");
      results.push({
        name: "cline-rules",
        content,
        scope: "always",
        description: "Cline project rules (legacy .clinerules file)",
        sourcePath: rulesPath,
      });
    } catch {
      warnings.push(`Cannot read rules file: ${rulesPath}`);
    }
  }

  return results;
}
