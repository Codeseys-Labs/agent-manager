/**
 * Claude Code adapter: import native configs into core format.
 *
 * Reads ~/.claude.json (global mcpServers), .mcp.json (project-scoped),
 * and CLAUDE.md (instructions). Missing files are warned, not fatal.
 */

import { join } from "node:path";
import { homedir } from "node:os";
import { extractPackageId } from "./identity.ts";
import type {
  ImportOptions,
  ImportResult,
  ImportedServer,
  ImportedInstruction,
} from "../types.ts";

interface ClaudeJsonServer {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  disabled?: boolean;
  [key: string]: unknown;
}

interface ClaudeJson {
  mcpServers?: Record<string, ClaudeJsonServer>;
  [key: string]: unknown;
}

/**
 * Import Claude Code native configs into core format.
 */
export function importConfig(
  options: ImportOptions = {},
  homeDir?: string,
): ImportResult {
  const home = homeDir ?? homedir();
  const entities = options.entities ?? ["servers", "instructions"];
  const warnings: string[] = [];
  const servers: ImportedServer[] = [];
  const instructions: ImportedInstruction[] = [];

  if (entities.includes("servers")) {
    // Global servers from ~/.claude.json
    const globalPath = join(home, ".claude.json");
    const globalServers = readServersFromFile(globalPath, "global", warnings);
    servers.push(...globalServers);

    // Project servers from .mcp.json
    if (options.projectPath) {
      const mcpPath = join(options.projectPath, ".mcp.json");
      const projectServers = readServersFromFile(mcpPath, "project", warnings);
      servers.push(...projectServers);
    }
  }

  if (entities.includes("instructions") && options.projectPath) {
    const claudeMd = readClaudeMd(options.projectPath, warnings);
    if (claudeMd) {
      instructions.push(claudeMd);
    }
  }

  return { servers, instructions, skills: [], warnings };
}

/** Core fields that are part of ImportedServer — everything else goes to adapterExtras. */
const CORE_FIELDS = new Set([
  "command",
  "args",
  "env",
  "disabled",
]);

function readServersFromFile(
  filePath: string,
  scope: "global" | "project",
  warnings: string[],
): ImportedServer[] {
  const file = Bun.file(filePath);

  let text: string;
  try {
    // Bun.file().text() is async; use the sync approach for file existence
    if (!fileExistsSync(filePath)) {
      warnings.push(`File not found: ${filePath}`);
      return [];
    }
    // Read synchronously via Node fs for simplicity in sync adapter
    const fs = require("node:fs");
    text = fs.readFileSync(filePath, "utf-8");
  } catch {
    warnings.push(`Cannot read file: ${filePath}`);
    return [];
  }

  let json: ClaudeJson;
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

function readClaudeMd(
  projectPath: string,
  warnings: string[],
): ImportedInstruction | null {
  const claudeMdPath = join(projectPath, "CLAUDE.md");

  if (!fileExistsSync(claudeMdPath)) {
    // Also check .claude/CLAUDE.md
    const dotClaudeMd = join(projectPath, ".claude", "CLAUDE.md");
    if (!fileExistsSync(dotClaudeMd)) {
      warnings.push(`No CLAUDE.md found in ${projectPath}`);
      return null;
    }
    return readClaudeMdFile(dotClaudeMd);
  }

  return readClaudeMdFile(claudeMdPath);
}

function readClaudeMdFile(filePath: string): ImportedInstruction | null {
  try {
    const fs = require("node:fs");
    const content = fs.readFileSync(filePath, "utf-8");
    return {
      name: "claude-md",
      content,
      scope: "always",
      description: "Project instructions from CLAUDE.md",
      sourcePath: filePath,
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
