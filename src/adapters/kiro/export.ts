/**
 * Kiro adapter: export resolved config to native format.
 *
 * Generates .kiro/settings/mcp.json (MCP servers), .kiro/steering/*.md
 * (instructions with am:begin/am:end markers), and .kiro/agents/*.json
 * (agent definitions).
 */

import { join } from "node:path";
import { homedir } from "node:os";
import type {
  ExportOptions,
  ExportResult,
  ResolvedConfig,
  ResolvedServer,
  WrittenFile,
} from "../types.ts";

const AM_BEGIN = "<!-- am:begin -->";
const AM_END = "<!-- am:end -->";

/**
 * Export resolved config to Kiro native files.
 */
export function exportConfig(
  config: ResolvedConfig,
  options: ExportOptions = {},
  homeDir?: string,
): ExportResult {
  const home = homeDir ?? homedir();
  const files: WrittenFile[] = [];
  const warnings: string[] = [];

  // Partition servers by scope
  const globalServers: Record<string, ResolvedServer> = {};
  const projectServers: Record<string, ResolvedServer> = {};

  for (const [name, server] of Object.entries(config.servers)) {
    if (!server.enabled) continue;
    const kiroAdapter = server.adapters?.["kiro"] ?? {};
    if (kiroAdapter.scope === "project") {
      projectServers[name] = server;
    } else {
      globalServers[name] = server;
    }
  }

  // 1. Generate ~/.kiro/settings/mcp.json (global servers)
  const globalPath = join(home, ".kiro", "settings", "mcp.json");
  const globalContent = generateMcpJson(globalServers, globalPath, warnings);
  files.push({ path: globalPath, content: globalContent, written: false });

  // 2. Generate .kiro/settings/mcp.json (project-scoped servers)
  if (options.projectPath && Object.keys(projectServers).length > 0) {
    const projectMcpPath = join(options.projectPath, ".kiro", "settings", "mcp.json");
    const projectContent = generateMcpJson(projectServers, projectMcpPath, warnings);
    files.push({ path: projectMcpPath, content: projectContent, written: false });
  }

  // 3. Generate steering files (instructions)
  if (options.projectPath) {
    const steeringFiles = generateSteeringFiles(config, options.projectPath, warnings);
    files.push(...steeringFiles);
  }

  // Write files unless dryRun
  if (!options.dryRun) {
    for (const file of files) {
      try {
        const fs = require("node:fs");
        const dir = file.path.substring(0, file.path.lastIndexOf("/"));
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(file.path, file.content, "utf-8");
        file.written = true;
      } catch (err) {
        warnings.push(
          `Failed to write ${file.path}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  return { files, warnings };
}

/** Build mcp.json content, preserving existing non-MCP fields. */
function generateMcpJson(
  servers: Record<string, ResolvedServer>,
  existingPath: string,
  warnings: string[],
): string {
  // Read existing file to preserve non-MCP fields
  let existing: Record<string, unknown> = {};
  try {
    const fs = require("node:fs");
    const text = fs.readFileSync(existingPath, "utf-8");
    existing = JSON.parse(text);
  } catch {
    // No existing file or malformed — start fresh
  }

  const mcpServers: Record<string, unknown> = {};
  for (const [name, server] of Object.entries(servers)) {
    const isHttp = server.transport === "streamable-http" || server.transport === "sse";
    const entry: Record<string, unknown> = {};

    if (isHttp) {
      entry.url = server.command;
    } else {
      entry.command = server.command;
      if (server.args.length > 0) entry.args = server.args;
    }

    if (Object.keys(server.env).length > 0) entry.env = server.env;

    // Map adapter-specific fields (autoApprove, disabledTools, timeout, etc.)
    const kiroExtras = server.adapters?.["kiro"] ?? {};
    for (const [key, value] of Object.entries(kiroExtras)) {
      if (key === "scope") continue; // internal routing hint
      entry[key] = value;
    }

    mcpServers[name] = entry;
  }

  const output = { ...existing, mcpServers };
  return JSON.stringify(output, null, 2) + "\n";
}

/** Map scope values to Kiro inclusion modes. */
function scopeToInclusion(scope: string): string {
  switch (scope) {
    case "always":
      return "always";
    case "agent-decision":
      return "auto";
    case "glob":
      return "fileMatch";
    case "manual":
      return "manual";
    default:
      return "always";
  }
}

/** Generate steering markdown files from instructions. */
function generateSteeringFiles(
  config: ResolvedConfig,
  projectPath: string,
  warnings: string[],
): WrittenFile[] {
  const files: WrittenFile[] = [];

  for (const [name, instr] of Object.entries(config.instructions)) {
    if (instr.targets.length > 0 && !instr.targets.includes("kiro")) {
      continue;
    }

    const inclusion = scopeToInclusion(instr.scope);
    const steeringName = name.replace(/^steering-/, "");
    const filePath = join(projectPath, ".kiro", "steering", `${steeringName}.md`);

    // Wrap managed content in am markers
    const managedBlock = `${AM_BEGIN}\n${instr.content}\n${AM_END}`;

    let content: string;
    // Try to read existing file and replace managed section
    try {
      const fs = require("node:fs");
      const existingContent = fs.readFileSync(filePath, "utf-8");
      const beginIdx = existingContent.indexOf(AM_BEGIN);
      const endIdx = existingContent.indexOf(AM_END);
      if (beginIdx !== -1 && endIdx !== -1) {
        const before = existingContent.slice(0, beginIdx);
        const after = existingContent.slice(endIdx + AM_END.length);
        content = before + managedBlock + after;
      } else {
        content = existingContent.trimEnd() + "\n\n" + managedBlock + "\n";
      }
    } catch {
      // No existing file — generate with frontmatter
      content = `---\ninclusion: ${inclusion}\ndescription: "${instr.description}"\n---\n\n${managedBlock}\n`;
    }

    files.push({ path: filePath, content, written: false });
  }

  return files;
}
