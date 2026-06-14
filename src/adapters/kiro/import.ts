/**
 * Kiro adapter: import native configs into core format.
 *
 * Reads mcp.json (workspace and global MCP servers), steering markdown files
 * (instructions), agent JSON files (profiles), and skills (SKILL.md).
 * Missing files produce warnings, not errors.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import type {
  ImportOptions,
  ImportResult,
  ImportedInstruction,
  ImportedServer,
  ImportedSkill,
} from "../types.ts";
import { extractPackageId } from "./identity.ts";

interface KiroMcpServer {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  disabled?: boolean;
  autoApprove?: string[];
  disabledTools?: string[];
  timeout?: number;
  url?: string;
  headers?: Record<string, string>;
  oauth?: Record<string, unknown>;
  [key: string]: unknown;
}

interface KiroMcpJson {
  mcpServers?: Record<string, KiroMcpServer>;
  [key: string]: unknown;
}

/** Core fields mapped directly to ImportedServer — everything else goes to adapterExtras. */
const CORE_FIELDS = new Set(["command", "args", "env", "disabled", "url"]);

/**
 * Import Kiro native configs into core format.
 */
export function importConfig(options: ImportOptions = {}, homeDir?: string): ImportResult {
  const home = homeDir ?? homedir();
  const entities = options.entities ?? ["servers", "instructions", "skills"];
  const warnings: string[] = [];
  const servers: ImportedServer[] = [];
  const instructions: ImportedInstruction[] = [];
  const skills: ImportedSkill[] = [];

  if (entities.includes("servers")) {
    // Global servers from ~/.kiro/settings/mcp.json
    const globalPath = join(home, ".kiro", "settings", "mcp.json");
    const globalServers = readServersFromFile(globalPath, "global", warnings);
    servers.push(...globalServers);

    // Project servers from .kiro/settings/mcp.json
    if (options.projectPath) {
      const projectPath = join(options.projectPath, ".kiro", "settings", "mcp.json");
      const projectServers = readServersFromFile(projectPath, "project", warnings);
      servers.push(...projectServers);
    }
  }

  if (entities.includes("instructions")) {
    // Global steering files
    const globalSteeringDir = join(home, ".kiro", "steering");
    const globalSteering = readSteeringDir(globalSteeringDir, "global");
    instructions.push(...globalSteering);

    // Project steering files
    if (options.projectPath) {
      const projectSteeringDir = join(options.projectPath, ".kiro", "steering");
      const projectSteering = readSteeringDir(projectSteeringDir, "project");
      instructions.push(...projectSteering);
    }
  }

  if (entities.includes("skills") && options.projectPath) {
    const projectSkillsDir = join(options.projectPath, ".kiro", "skills");
    const projectSkills = readSkillsDir(projectSkillsDir);
    skills.push(...projectSkills);
  }

  return { servers, instructions, skills, warnings };
}

function readServersFromFile(
  filePath: string,
  scope: "global" | "project",
  warnings: string[],
): ImportedServer[] {
  const fs = require("node:fs");

  let text: string;
  try {
    text = fs.readFileSync(filePath, "utf-8");
  } catch {
    warnings.push(`File not found: ${filePath}`);
    return [];
  }

  let json: KiroMcpJson;
  try {
    json = JSON.parse(text);
  } catch {
    if (text.trim() !== "") warnings.push(`Malformed JSON: ${filePath}`);
    return [];
  }

  const mcpServers = json.mcpServers;
  if (!mcpServers || typeof mcpServers !== "object") {
    return [];
  }

  const results: ImportedServer[] = [];
  for (const [name, entry] of Object.entries(mcpServers)) {
    if (!entry || typeof entry !== "object") continue;

    const isHttp = !!entry.url;
    const isStdio = !!entry.command;
    if (!isHttp && !isStdio) continue;

    const adapterExtras: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(entry)) {
      if (!CORE_FIELDS.has(key)) {
        adapterExtras[key] = value;
      }
    }

    const server: ImportedServer = {
      name,
      command: isStdio ? (entry.command ?? "") : (entry.url ?? ""),
      scope,
      transport: isHttp ? "streamable-http" : "stdio",
      ...(isHttp && entry.url && { url: entry.url }),
      ...(entry.args && { args: entry.args }),
      ...(entry.env && { env: entry.env }),
      enabled: entry.disabled !== true,
      packageId: isStdio ? extractPackageId(entry.command ?? "", entry.args) : undefined,
      ...(Object.keys(adapterExtras).length > 0 && { adapterExtras }),
    };

    results.push(server);
  }

  return results;
}

/**
 * Parse steering file frontmatter to extract inclusion mode.
 * Steering files use YAML frontmatter with an `inclusion` field.
 */
function parseSteeringFrontmatter(content: string): {
  mode: ImportedInstruction["scope"];
  description?: string;
  body: string;
} {
  const fmMatch = content.match(/^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/);
  if (!fmMatch) {
    return { mode: "always", body: content };
  }

  const frontmatter = fmMatch[1];
  const body = fmMatch[2];

  let mode: ImportedInstruction["scope"] = "always";
  let description: string | undefined;

  for (const line of frontmatter.split("\n")) {
    const inclusionMatch = line.match(/^\s*inclusion\s*:\s*(.+)$/);
    if (inclusionMatch) {
      const raw = inclusionMatch[1].trim().replace(/^["']|["']$/g, "");
      switch (raw) {
        case "always":
          mode = "always";
          break;
        case "auto":
          mode = "agent-decision";
          break;
        case "fileMatch":
          mode = "glob";
          break;
        case "manual":
          mode = "manual";
          break;
        default:
          mode = "always";
      }
    }

    const descMatch = line.match(/^\s*description\s*:\s*(.+)$/);
    if (descMatch) {
      description = descMatch[1].trim().replace(/^["']|["']$/g, "");
    }
  }

  return { mode, description, body };
}

function readSteeringDir(dirPath: string, scope: "global" | "project"): ImportedInstruction[] {
  const fs = require("node:fs");
  const path = require("node:path");

  let entries: string[];
  try {
    entries = fs.readdirSync(dirPath);
  } catch {
    return [];
  }

  const results: ImportedInstruction[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".md")) continue;
    const filePath = path.join(dirPath, entry);
    try {
      const content = fs.readFileSync(filePath, "utf-8");
      const parsed = parseSteeringFrontmatter(content);
      const name = entry.replace(/\.md$/, "");
      results.push({
        name: scope === "global" ? `steering-global-${name}` : `steering-${name}`,
        content: parsed.body,
        scope: parsed.mode,
        description: parsed.description ?? `Steering file: ${entry}`,
        sourcePath: filePath,
      });
    } catch {
      // Skip unreadable files
    }
  }

  return results;
}

function readSkillsDir(dirPath: string): ImportedSkill[] {
  const fs = require("node:fs");
  const path = require("node:path");

  let entries: string[];
  try {
    entries = fs.readdirSync(dirPath);
  } catch {
    return [];
  }

  const results: ImportedSkill[] = [];
  for (const entry of entries) {
    const skillMd = path.join(dirPath, entry, "SKILL.md");
    try {
      const content = fs.readFileSync(skillMd, "utf-8");
      // Extract description from frontmatter
      let description: string | undefined;
      const fmMatch = content.match(/^---\s*\n([\s\S]*?)\n---/);
      if (fmMatch) {
        const descMatch = fmMatch[1].match(/^\s*description\s*:\s*(.+)$/m);
        if (descMatch) {
          description = descMatch[1].trim().replace(/^["']|["']$/g, "");
        }
      }

      results.push({
        name: entry,
        path: skillMd,
        description,
      });
    } catch {
      // Skip directories without SKILL.md
    }
  }

  return results;
}
