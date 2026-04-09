/**
 * Copilot adapter: import native configs into core format.
 *
 * Reads .vscode/mcp.json (project MCP — uses "servers" key, NOT "mcpServers"),
 * .github/copilot-instructions.md (global instructions),
 * and .github/instructions/*.instructions.md (scoped instructions with applyTo frontmatter).
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { extractPackageId } from "../claude-code/identity.ts";
import type { ImportOptions, ImportResult, ImportedInstruction, ImportedServer } from "../types.ts";

interface CopilotServer {
  type?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  [key: string]: unknown;
}

interface CopilotMcpJson {
  servers?: Record<string, CopilotServer>;
  [key: string]: unknown;
}

/**
 * Import Copilot native configs into core format.
 */
export function importConfig(options: ImportOptions = {}, homeDir?: string): ImportResult {
  const home = homeDir ?? homedir();
  const entities = options.entities ?? ["servers", "instructions"];
  const warnings: string[] = [];
  const servers: ImportedServer[] = [];
  const instructions: ImportedInstruction[] = [];

  if (entities.includes("servers") && options.projectPath) {
    // Project MCP from .vscode/mcp.json (uses "servers" key)
    const mcpPath = join(options.projectPath, ".vscode", "mcp.json");
    const projectServers = readServersFromFile(mcpPath, "project", warnings);
    servers.push(...projectServers);
  }

  if (entities.includes("instructions") && options.projectPath) {
    // Global instructions: .github/copilot-instructions.md
    const globalInstr = readGlobalInstructions(options.projectPath, warnings);
    if (globalInstr) {
      instructions.push(globalInstr);
    }

    // Scoped instructions: .github/instructions/*.instructions.md
    const scopedInstr = readScopedInstructions(options.projectPath, warnings);
    instructions.push(...scopedInstr);
  }

  return { servers, instructions, skills: [], warnings };
}

/** Core fields that are part of ImportedServer — everything else goes to adapterExtras. */
const CORE_FIELDS = new Set(["command", "args", "env", "type", "url"]);

function readServersFromFile(
  filePath: string,
  scope: "global" | "project",
  warnings: string[],
): ImportedServer[] {
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

  let json: CopilotMcpJson;
  try {
    json = JSON.parse(text);
  } catch {
    warnings.push(`Malformed JSON: ${filePath}`);
    return [];
  }

  // Copilot VS Code uses "servers" key, NOT "mcpServers"
  const serversObj = json.servers;
  if (!serversObj || typeof serversObj !== "object") {
    return [];
  }

  const results: ImportedServer[] = [];
  for (const [name, entry] of Object.entries(serversObj)) {
    if (!entry || typeof entry !== "object") continue;
    // HTTP servers have url but no command
    if (!entry.command && !entry.url) continue;

    const adapterExtras: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(entry)) {
      if (!CORE_FIELDS.has(key)) {
        adapterExtras[key] = value;
      }
    }

    // Determine transport from type field
    let transport: "stdio" | "streamable-http" | "sse" | undefined;
    if (entry.type === "http" || entry.url) {
      transport = "streamable-http";
    } else {
      transport = "stdio";
    }

    // Preserve the Copilot-specific "type" field in adapterExtras
    if (entry.type) {
      adapterExtras.type = entry.type;
    }

    const server: ImportedServer = {
      name,
      command: entry.command ?? entry.url ?? "",
      scope,
      ...(entry.args && { args: entry.args }),
      ...(entry.env && { env: entry.env }),
      ...(transport && { transport }),
      enabled: true,
      packageId: entry.command ? extractPackageId(entry.command, entry.args) : undefined,
      ...(Object.keys(adapterExtras).length > 0 && { adapterExtras }),
    };

    results.push(server);
  }

  return results;
}

function readGlobalInstructions(
  projectPath: string,
  warnings: string[],
): ImportedInstruction | null {
  const fs = require("node:fs");
  const instrPath = join(projectPath, ".github", "copilot-instructions.md");

  if (!fileExistsSync(instrPath)) return null;

  try {
    const content = fs.readFileSync(instrPath, "utf-8");
    return {
      name: "copilot-instructions",
      content: content.trim(),
      scope: "always",
      description: "Repository-wide Copilot instructions",
      sourcePath: instrPath,
    };
  } catch {
    warnings.push(`Cannot read instructions: ${instrPath}`);
    return null;
  }
}

/**
 * Parse frontmatter from a scoped instruction file.
 * Expects YAML-like frontmatter with applyTo field.
 */
function parseFrontmatter(content: string): {
  body: string;
  applyTo?: string;
} {
  const match = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) return { body: content };

  const frontmatter = match[1];
  const body = match[2];

  let applyTo: string | undefined;
  for (const line of frontmatter.split("\n")) {
    const applyToMatch = line.match(/^applyTo:\s*(.+)$/);
    if (applyToMatch) applyTo = applyToMatch[1].trim().replace(/^["']|["']$/g, "");
  }

  return { body, applyTo };
}

function readScopedInstructions(projectPath: string, warnings: string[]): ImportedInstruction[] {
  const fs = require("node:fs");
  const instrDir = join(projectPath, ".github", "instructions");

  if (!fileExistsSync(instrDir)) return [];

  let entries: string[];
  try {
    entries = fs.readdirSync(instrDir);
  } catch {
    warnings.push(`Cannot read instructions directory: ${instrDir}`);
    return [];
  }

  const instructions: ImportedInstruction[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".instructions.md")) continue;
    const filePath = join(instrDir, entry);
    try {
      const content = fs.readFileSync(filePath, "utf-8");
      const { body, applyTo } = parseFrontmatter(content);
      const name = entry.replace(/\.instructions\.md$/, "");

      instructions.push({
        name,
        content: body.trim(),
        scope: applyTo ? "glob" : "always",
        description: applyTo ? `Applies to: ${applyTo}` : undefined,
        sourcePath: filePath,
      });
    } catch {
      warnings.push(`Cannot read instruction file: ${filePath}`);
    }
  }

  return instructions;
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
