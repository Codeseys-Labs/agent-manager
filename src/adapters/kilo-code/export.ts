/**
 * Kilo Code adapter: export resolved config to native format.
 *
 * Generates kilo.jsonc (global + project configs) using the new CLI-native
 * MCP format (`mcp` key with command arrays), and AGENTS.md with am markers.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import type {
  ExportOptions,
  ExportResult,
  ResolvedConfig,
  ResolvedServer,
  WrittenFile,
} from "../types.ts";
import { parseJsonc } from "./jsonc.ts";

const AM_BEGIN = "<!-- am:begin -->";
const AM_END = "<!-- am:end -->";

/**
 * Export resolved config to Kilo Code native files.
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
    const kcAdapter = server.adapters?.["kilo-code"] ?? {};
    if (kcAdapter.scope === "project") {
      projectServers[name] = server;
    } else {
      globalServers[name] = server;
    }
  }

  // 1. Generate global config: ~/.config/kilo/kilo.jsonc
  const globalConfigDir = join(home, ".config", "kilo");
  const globalPath = join(globalConfigDir, "kilo.jsonc");
  const globalContent = generateKiloConfig(globalServers, globalPath, warnings);
  files.push({ path: globalPath, content: globalContent, written: false });

  // 2. Generate project config: kilo.jsonc
  if (options.projectPath && Object.keys(projectServers).length > 0) {
    const projectPath = join(options.projectPath, "kilo.jsonc");
    const projectContent = generateKiloConfig(projectServers, projectPath, warnings);
    files.push({ path: projectPath, content: projectContent, written: false });
  }

  // 3. Generate AGENTS.md (instructions)
  if (options.projectPath) {
    const instructionContent = generateInstructionBlock(config);
    if (instructionContent) {
      const agentsMdPath = join(options.projectPath, "AGENTS.md");
      const agentsMdContent = generateAgentsMd(agentsMdPath, instructionContent, warnings);
      files.push({
        path: agentsMdPath,
        content: agentsMdContent,
        written: false,
      });
    }
  }

  // Write files unless dryRun
  if (!options.dryRun) {
    const fs = require("node:fs");
    for (const file of files) {
      try {
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

/** Build a kilo.jsonc config with `mcp` key, preserving existing non-MCP fields. */
function generateKiloConfig(
  servers: Record<string, ResolvedServer>,
  existingPath: string,
  warnings: string[],
): string {
  let existing: Record<string, unknown> = {};
  try {
    const fs = require("node:fs");
    const text = fs.readFileSync(existingPath, "utf-8");
    existing = parseJsonc(text) as Record<string, unknown>;
  } catch {
    // No existing file — start fresh
  }

  const mcp: Record<string, unknown> = {};
  for (const [name, server] of Object.entries(servers)) {
    if (server.transport === "streamable-http" || server.transport === "sse") {
      // Remote server
      const entry: Record<string, unknown> = {
        type: "remote",
        url: server.command,
      };
      if (Object.keys(server.env).length > 0) {
        entry.env = server.env;
      }
      mcp[name] = entry;
    } else {
      // Local server (stdio) — use command array format
      const cmdArray = [server.command, ...server.args];
      const entry: Record<string, unknown> = {
        type: "local",
        command: cmdArray,
      };
      if (Object.keys(server.env).length > 0) {
        entry.environment = server.env;
      }

      // Map adapter-specific fields
      const kcExtras = server.adapters?.["kilo-code"] ?? {};
      for (const [key, value] of Object.entries(kcExtras)) {
        if (key === "scope") continue;
        entry[key] = value;
      }

      mcp[name] = entry;
    }
  }

  const output = { ...existing, mcp };
  // Remove legacy mcpServers if we're writing new format
  output.mcpServers = undefined;

  return `${JSON.stringify(output, null, 2)}\n`;
}

/** Concatenate instructions targeted at kilo-code. */
function generateInstructionBlock(config: ResolvedConfig): string | null {
  const parts: string[] = [];
  for (const [, instr] of Object.entries(config.instructions)) {
    if (instr.targets.length > 0 && !instr.targets.includes("kilo-code")) {
      continue;
    }
    parts.push(instr.content);
  }
  if (parts.length === 0) return null;
  return parts.join("\n\n");
}

/** Generate AGENTS.md content, preserving content outside am markers. */
function generateAgentsMd(
  existingPath: string,
  managedContent: string,
  _warnings: string[],
): string {
  const block = `${AM_BEGIN}\n${managedContent}\n${AM_END}`;

  let existingContent = "";
  try {
    const fs = require("node:fs");
    existingContent = fs.readFileSync(existingPath, "utf-8");
  } catch {
    return `${block}\n`;
  }

  // Replace existing managed section
  const beginIdx = existingContent.indexOf(AM_BEGIN);
  const endIdx = existingContent.indexOf(AM_END);
  if (beginIdx !== -1 && endIdx !== -1) {
    const before = existingContent.slice(0, beginIdx);
    const after = existingContent.slice(endIdx + AM_END.length);
    return before + block + after;
  }

  return `${existingContent.trimEnd()}\n\n${block}\n`;
}
