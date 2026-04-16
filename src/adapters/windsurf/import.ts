/**
 * Windsurf adapter: import native configs into core format.
 *
 * Reads ~/.codeium/windsurf/mcp_config.json (global MCP servers)
 * and .windsurf/rules/*.md (project instructions with frontmatter).
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
  const entities = options.entities ?? ["servers", "instructions", "skills"];
  const warnings: string[] = [];
  const servers: ImportedServer[] = [];
  const instructions: ImportedInstruction[] = [];
  const skills: ImportedSkill[] = [];

  if (entities.includes("servers")) {
    const mcpPath = join(home, ".codeium", "windsurf", "mcp_config.json");
    const mcpServers = readServersFromFile(mcpPath, warnings);
    servers.push(...mcpServers);
  }

  if (entities.includes("instructions") && options.projectPath) {
    const projectInstructions = readRulesDir(options.projectPath, warnings);
    instructions.push(...projectInstructions);

    // AGENTS.md (Windsurf 2.0.44+)
    const agentsMd = readAgentsMd(options.projectPath, warnings);
    if (agentsMd) {
      instructions.push(agentsMd);
    }

    // Legacy .windsurfrules
    const legacy = readLegacyRules(options.projectPath, warnings);
    if (legacy) {
      instructions.push(legacy);
    }
  }

  if (entities.includes("skills") && options.projectPath) {
    const projectSkills = readSkillsDir(options.projectPath, warnings);
    skills.push(...projectSkills);
  }

  return { servers, instructions, skills, warnings };
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

function readAgentsMd(projectPath: string, warnings: string[]): ImportedInstruction | null {
  const fs = require("node:fs");
  const agentsMdPath = join(projectPath, "AGENTS.md");

  if (!fileExistsSync(agentsMdPath)) return null;

  try {
    const content = fs.readFileSync(agentsMdPath, "utf-8");
    return {
      name: "agents-md",
      content: content.trim(),
      scope: "always",
      description: "Project instructions from AGENTS.md",
      sourcePath: agentsMdPath,
    };
  } catch {
    warnings.push(`Cannot read AGENTS.md: ${agentsMdPath}`);
    return null;
  }
}

function readSkillsDir(projectPath: string, warnings: string[]): ImportedSkill[] {
  const fs = require("node:fs");
  const path = require("node:path");
  const skillsDir = join(projectPath, ".windsurf", "skills");

  if (!fileExistsSync(skillsDir)) {
    return [];
  }

  let entries: string[];
  try {
    entries = fs.readdirSync(skillsDir);
  } catch {
    warnings.push(`Cannot read skills directory: ${skillsDir}`);
    return [];
  }

  const skills: ImportedSkill[] = [];
  for (const entry of entries) {
    const entryPath = join(skillsDir, entry);
    let stat: { isDirectory(): boolean };
    try {
      stat = fs.statSync(entryPath);
    } catch {
      continue;
    }

    if (stat.isDirectory()) {
      // Skill directories contain a SKILL.md file
      const skillMd = join(entryPath, "SKILL.md");
      if (fileExistsSync(skillMd)) {
        let description: string | undefined;
        try {
          const content = fs.readFileSync(skillMd, "utf-8");
          // Extract first line or heading as description
          const firstLine = content.split("\n").find((l: string) => l.trim().length > 0);
          if (firstLine) {
            description = firstLine.replace(/^#\s+/, "").trim();
          }
        } catch {
          // Description is optional
        }
        skills.push({ name: entry, path: entryPath, description });
      }
    } else if (entry.endsWith(".md")) {
      // Standalone skill files
      const name = path.basename(entry, ".md");
      let description: string | undefined;
      try {
        const content = fs.readFileSync(entryPath, "utf-8");
        const firstLine = content.split("\n").find((l: string) => l.trim().length > 0);
        if (firstLine) {
          description = firstLine.replace(/^#\s+/, "").trim();
        }
      } catch {
        // Description is optional
      }
      skills.push({ name, path: entryPath, description });
    }
  }

  return skills;
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
