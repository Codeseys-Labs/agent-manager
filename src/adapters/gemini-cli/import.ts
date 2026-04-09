/**
 * Gemini CLI adapter: import native configs into core format.
 *
 * Reads ~/.gemini/settings.json (global mcpServers),
 * .gemini/settings.json (project-scoped), and GEMINI.md (instructions).
 * Missing files are warned, not fatal.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import type { ImportOptions, ImportResult, ImportedInstruction, ImportedServer } from "../types.ts";

interface GeminiServer {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  [key: string]: unknown;
}

interface GeminiSettings {
  mcpServers?: Record<string, GeminiServer>;
  [key: string]: unknown;
}

/** Core fields that are part of ImportedServer — everything else goes to adapterExtras. */
const CORE_FIELDS = new Set(["command", "args", "env"]);

/**
 * Import Gemini CLI native configs into core format.
 */
export function importConfig(options: ImportOptions = {}, homeDir?: string): ImportResult {
  const home = homeDir ?? homedir();
  const entities = options.entities ?? ["servers", "instructions"];
  const warnings: string[] = [];
  const servers: ImportedServer[] = [];
  const instructions: ImportedInstruction[] = [];

  if (entities.includes("servers")) {
    // Global servers from ~/.gemini/settings.json
    const globalPath = join(home, ".gemini", "settings.json");
    const globalServers = readServersFromFile(globalPath, "global", warnings);
    servers.push(...globalServers);

    // Project servers from .gemini/settings.json
    if (options.projectPath) {
      const projectPath = join(options.projectPath, ".gemini", "settings.json");
      const projectServers = readServersFromFile(projectPath, "project", warnings);
      servers.push(...projectServers);
    }
  }

  if (entities.includes("instructions") && options.projectPath) {
    const geminiMd = readGeminiMd(options.projectPath, warnings);
    if (geminiMd) {
      instructions.push(geminiMd);
    }
  }

  return { servers, instructions, skills: [], warnings };
}

function readServersFromFile(
  filePath: string,
  scope: "global" | "project",
  warnings: string[],
): ImportedServer[] {
  if (!fileExistsSync(filePath)) {
    // Only warn for global config; project-level files are optional
    if (scope === "global") {
      warnings.push(`File not found: ${filePath}`);
    }
    return [];
  }

  let text: string;
  try {
    const fs = require("node:fs");
    text = fs.readFileSync(filePath, "utf-8");
  } catch {
    warnings.push(`Cannot read file: ${filePath}`);
    return [];
  }

  let json: GeminiSettings;
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
      enabled: true,
      ...(Object.keys(adapterExtras).length > 0 && { adapterExtras }),
    };

    results.push(server);
  }

  return results;
}

function readGeminiMd(projectPath: string, warnings: string[]): ImportedInstruction | null {
  const geminiMdPath = join(projectPath, "GEMINI.md");

  if (!fileExistsSync(geminiMdPath)) {
    // Project-level GEMINI.md is optional — silently skip
    return null;
  }

  try {
    const fs = require("node:fs");
    const content = fs.readFileSync(geminiMdPath, "utf-8");
    return {
      name: "gemini-md",
      content,
      scope: "always",
      description: "Project instructions from GEMINI.md",
      sourcePath: geminiMdPath,
    };
  } catch {
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
