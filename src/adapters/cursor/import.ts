/**
 * Cursor adapter: import native configs into core format.
 *
 * Reads ~/.cursor/mcp.json (global), .cursor/mcp.json (project),
 * .cursor/rules/*.mdc (instructions), .cursorrules (legacy),
 * and .cursor/agents/*.md (agents). Missing files are warned, not fatal.
 */

import { join } from "node:path";
import { homedir } from "node:os";
import { extractPackageId } from "../claude-code/identity.ts";
import type {
  ImportOptions,
  ImportResult,
  ImportedServer,
  ImportedInstruction,
} from "../types.ts";

interface CursorMcpServer {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  disabled?: boolean;
  [key: string]: unknown;
}

interface CursorMcpJson {
  mcpServers?: Record<string, CursorMcpServer>;
  [key: string]: unknown;
}

interface MdcFrontmatter {
  description?: string;
  globs?: string[];
  alwaysApply?: boolean;
}

/**
 * Import Cursor native configs into core format.
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
    // Global servers from ~/.cursor/mcp.json
    const globalPath = join(home, ".cursor", "mcp.json");
    const globalServers = readServersFromFile(globalPath, "global", warnings);
    servers.push(...globalServers);

    // Project servers from .cursor/mcp.json
    if (options.projectPath) {
      const mcpPath = join(options.projectPath, ".cursor", "mcp.json");
      const projectServers = readServersFromFile(mcpPath, "project", warnings);
      servers.push(...projectServers);
    }
  }

  if (entities.includes("instructions") && options.projectPath) {
    // .cursor/rules/*.mdc files
    const mdcInstructions = readMdcRules(options.projectPath, warnings);
    instructions.push(...mdcInstructions);

    // Legacy .cursorrules file
    const legacy = readLegacyRules(options.projectPath, warnings);
    if (legacy) {
      instructions.push(legacy);
    }
  }

  return { servers, instructions, skills: [], warnings };
}

const CORE_FIELDS = new Set([
  "command",
  "args",
  "env",
  "url",
  "headers",
  "disabled",
]);

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

  let json: CursorMcpJson;
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
    // Cursor supports both command-based and URL-based servers
    if (!entry.command && !entry.url) continue;

    const adapterExtras: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(entry)) {
      if (!CORE_FIELDS.has(key)) {
        adapterExtras[key] = value;
      }
    }

    // URL-based servers are streamable-http or SSE
    if (entry.url) {
      adapterExtras.url = entry.url;
      if (entry.headers) {
        adapterExtras.headers = entry.headers;
      }
    }

    const transport: "stdio" | "streamable-http" | "sse" = entry.url
      ? "streamable-http"
      : "stdio";

    const server: ImportedServer = {
      name,
      command: entry.command ?? entry.url ?? "",
      scope,
      transport,
      ...(entry.args && { args: entry.args }),
      ...(entry.env && { env: entry.env }),
      enabled: entry.disabled !== true,
      packageId: entry.command
        ? extractPackageId(entry.command, entry.args)
        : undefined,
      ...(Object.keys(adapterExtras).length > 0 && { adapterExtras }),
    };

    results.push(server);
  }

  return results;
}

/**
 * Read .cursor/rules/*.mdc files as instructions.
 *
 * .mdc format: YAML frontmatter (description, globs, alwaysApply) + markdown body.
 */
function readMdcRules(
  projectPath: string,
  warnings: string[],
): ImportedInstruction[] {
  const rulesDir = join(projectPath, ".cursor", "rules");
  const fs = require("node:fs");

  let entries: string[];
  try {
    entries = fs.readdirSync(rulesDir);
  } catch {
    // No rules directory — not an error
    return [];
  }

  const instructions: ImportedInstruction[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".mdc")) continue;
    const filePath = join(rulesDir, entry);
    try {
      const content = fs.readFileSync(filePath, "utf-8");
      const parsed = parseMdc(content);
      const name = entry.replace(/\.mdc$/, "");

      let scope: ImportedInstruction["scope"];
      if (parsed.frontmatter.alwaysApply) {
        scope = "always";
      } else if (
        parsed.frontmatter.globs &&
        parsed.frontmatter.globs.length > 0
      ) {
        scope = "glob";
      } else if (parsed.frontmatter.description) {
        scope = "agent-decision";
      } else {
        scope = "manual";
      }

      instructions.push({
        name,
        content: parsed.body,
        scope,
        description: parsed.frontmatter.description,
        sourcePath: filePath,
      });
    } catch {
      warnings.push(`Failed to read rule: ${filePath}`);
    }
  }

  return instructions;
}

/**
 * Read legacy .cursorrules file as a single instruction.
 */
function readLegacyRules(
  projectPath: string,
  warnings: string[],
): ImportedInstruction | null {
  const filePath = join(projectPath, ".cursorrules");
  if (!fileExistsSync(filePath)) return null;

  try {
    const fs = require("node:fs");
    const content = fs.readFileSync(filePath, "utf-8");
    return {
      name: "cursorrules-legacy",
      content,
      scope: "always",
      description: "Legacy .cursorrules project instructions (deprecated)",
      sourcePath: filePath,
    };
  } catch {
    warnings.push(`Failed to read: ${filePath}`);
    return null;
  }
}

/**
 * Parse .mdc format: YAML frontmatter delimited by --- + markdown body.
 */
export function parseMdc(raw: string): {
  frontmatter: MdcFrontmatter;
  body: string;
} {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("---")) {
    return { frontmatter: {}, body: trimmed };
  }

  const endIdx = trimmed.indexOf("---", 3);
  if (endIdx === -1) {
    return { frontmatter: {}, body: trimmed };
  }

  const yamlBlock = trimmed.slice(3, endIdx).trim();
  const body = trimmed.slice(endIdx + 3).trim();

  const frontmatter: MdcFrontmatter = {};
  for (const line of yamlBlock.split("\n")) {
    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    const value = line.slice(colonIdx + 1).trim();

    if (key === "description") {
      frontmatter.description = stripQuotes(value);
    } else if (key === "alwaysApply") {
      frontmatter.alwaysApply = value === "true";
    } else if (key === "globs") {
      frontmatter.globs = parseYamlArray(value);
    }
  }

  return { frontmatter, body };
}

function stripQuotes(s: string): string {
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1);
  }
  return s;
}

function parseYamlArray(value: string): string[] {
  // Inline array: ["*.ts", "*.tsx"]
  const trimmed = value.trim();
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    const inner = trimmed.slice(1, -1);
    return inner
      .split(",")
      .map((s) => stripQuotes(s.trim()))
      .filter(Boolean);
  }
  // Single value
  if (trimmed) return [stripQuotes(trimmed)];
  return [];
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
