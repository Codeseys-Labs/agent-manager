/**
 * ForgeCode adapter: import native configs into core format.
 *
 * Reads .mcp.json (project-scoped MCP servers — identical format to Claude Code),
 * and AGENTS.md (instructions). Missing files are warned, not fatal.
 *
 * ForgeCode uses the same .mcp.json format as Claude Code, so MCP import
 * logic is shared.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { extractPackageId } from "../claude-code/identity.ts";
import { fileExistsSync } from "../shared/utils.ts";
import type {
  ImportOptions,
  ImportResult,
  ImportedInstruction,
  ImportedServer,
  ImportedSkill,
} from "../types.ts";

interface McpJsonServer {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  disable?: boolean;
  [key: string]: unknown;
}

interface McpJson {
  mcpServers?: Record<string, McpJsonServer>;
  [key: string]: unknown;
}

/**
 * Import ForgeCode native configs into core format.
 */
export function importConfig(options: ImportOptions = {}, homeDir?: string): ImportResult {
  const home = homeDir ?? homedir();
  const entities = options.entities ?? ["servers", "instructions", "skills"];
  const warnings: string[] = [];
  const servers: ImportedServer[] = [];
  const instructions: ImportedInstruction[] = [];
  const skills: ImportedSkill[] = [];

  if (entities.includes("servers")) {
    // Project servers from .mcp.json (same format as Claude Code)
    if (options.projectPath) {
      const mcpPath = join(options.projectPath, ".mcp.json");
      const projectServers = readServersFromFile(mcpPath, "project", warnings);
      servers.push(...projectServers);
    }
  }

  if (entities.includes("instructions") && options.projectPath) {
    const agentsMd = readAgentsMd(options.projectPath, home, warnings);
    if (agentsMd) {
      instructions.push(agentsMd);
    }
  }

  if (entities.includes("skills") && options.projectPath) {
    const projectSkills = readSkills(options.projectPath, warnings);
    skills.push(...projectSkills);
  }

  return { servers, instructions, skills, warnings };
}

/** Core fields that are part of ImportedServer — everything else goes to adapterExtras. */
const CORE_FIELDS = new Set(["command", "args", "env", "disable", "url"]);

function readServersFromFile(
  filePath: string,
  scope: "global" | "project",
  warnings: string[],
): ImportedServer[] {
  if (!fileExistsSync(filePath)) {
    warnings.push(`File not found: ${filePath}`);
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

  let json: McpJson;
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
    if (!entry || typeof entry !== "object") continue;
    // ForgeCode supports both command-based and url-based servers
    if (!entry.command && !entry.url) continue;

    const adapterExtras: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(entry)) {
      if (!CORE_FIELDS.has(key)) {
        adapterExtras[key] = value;
      }
    }

    const server: ImportedServer = {
      name,
      command: entry.command ?? entry.url ?? "",
      scope,
      ...(entry.args && { args: entry.args }),
      ...(entry.env && { env: entry.env }),
      ...(entry.url && { transport: "sse" as const }),
      enabled: entry.disable !== true,
      packageId: entry.command ? extractPackageId(entry.command, entry.args) : undefined,
      ...(Object.keys(adapterExtras).length > 0 && { adapterExtras }),
    };

    results.push(server);
  }

  return results;
}

function readAgentsMd(
  projectPath: string,
  homeDir: string,
  warnings: string[],
): ImportedInstruction | null {
  // ForgeCode searches: base path (~/forge) > git root > cwd (first found wins)
  const candidates = [join(projectPath, "AGENTS.md"), join(homeDir, "forge", "AGENTS.md")];

  for (const candidate of candidates) {
    if (fileExistsSync(candidate)) {
      return readAgentsMdFile(candidate);
    }
  }

  warnings.push(`No AGENTS.md found in ${projectPath}`);
  return null;
}

function readAgentsMdFile(filePath: string): ImportedInstruction | null {
  try {
    const fs = require("node:fs");
    const content = fs.readFileSync(filePath, "utf-8");
    return {
      name: "agents-md",
      content,
      scope: "always",
      description: "Project instructions from AGENTS.md",
      sourcePath: filePath,
    };
  } catch {
    return null;
  }
}

function readSkills(projectPath: string, warnings: string[]): ImportedSkill[] {
  const skillsDir = join(projectPath, ".forge", "skills");
  const fs = require("node:fs");

  if (!fileExistsSync(skillsDir)) {
    return [];
  }

  const skills: ImportedSkill[] = [];
  try {
    const entries = fs.readdirSync(skillsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const skillMd = join(skillsDir, entry.name, "SKILL.md");
      if (fileExistsSync(skillMd)) {
        skills.push({
          name: entry.name,
          path: skillMd,
          description: `Skill from .forge/skills/${entry.name}`,
        });
      }
    }
  } catch {
    warnings.push(`Cannot read skills directory: ${skillsDir}`);
  }

  return skills;
}

