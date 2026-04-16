/**
 * Codex CLI adapter: export resolved config to native format.
 *
 * Generates ~/.codex/config.toml (mcp_servers), AGENTS.md (instructions with
 * am:begin/am:end markers).
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { parse as parseTOML } from "@iarna/toml";
import { generateWikiContext, spliceWikiBlock } from "../../core/instructions.ts";
import { tomlStringify as stringifyTOML } from "../../lib/toml";
import { AM_BEGIN, AM_END, spliceMarkerBlock } from "../shared/utils.ts";
import type {
  ExportOptions,
  ExportResult,
  ResolvedConfig,
  ResolvedServer,
  WrittenFile,
} from "../types.ts";

/**
 * Export resolved config to Codex CLI native files.
 */
export async function exportConfig(
  config: ResolvedConfig,
  options: ExportOptions = {},
  homeDir?: string,
): Promise<ExportResult> {
  const home = homeDir ?? homedir();
  const files: WrittenFile[] = [];
  const warnings: string[] = [];

  // Partition servers by scope
  const globalServers: Record<string, ResolvedServer> = {};
  const projectServers: Record<string, ResolvedServer> = {};

  for (const [name, server] of Object.entries(config.servers)) {
    if (!server.enabled) continue;
    const codexAdapter = server.adapters?.["codex-cli"] ?? {};
    if (codexAdapter.scope === "project") {
      projectServers[name] = server;
    } else {
      globalServers[name] = server;
    }
  }

  // 1. Generate ~/.codex/config.toml
  const globalPath = join(home, ".codex", "config.toml");
  const globalContent = generateConfigToml(globalServers, globalPath, warnings);
  files.push({ path: globalPath, content: globalContent, written: false });

  // 2. Generate .codex/config.toml (project-scoped servers)
  if (options.projectPath && Object.keys(projectServers).length > 0) {
    const projectPath = join(options.projectPath, ".codex", "config.toml");
    const projectContent = generateConfigToml(projectServers, projectPath, warnings);
    files.push({ path: projectPath, content: projectContent, written: false });
  }

  // 3. Generate AGENTS.md (instructions + optional wiki context)
  if (options.projectPath) {
    const instructionContent = generateInstructionBlock(config);
    if (instructionContent) {
      const agentsMdPath = join(options.projectPath, "AGENTS.md");
      let agentsMdContent = generateAgentsMd(agentsMdPath, instructionContent, warnings);

      // Inject wiki context if enabled
      const configDir = options.projectPath;
      const wikiBlock = await generateWikiContext(configDir, config.settings);
      if (wikiBlock) {
        agentsMdContent = spliceWikiBlock(wikiBlock, agentsMdContent);
      }

      files.push({ path: agentsMdPath, content: agentsMdContent, written: false });
    }
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

/** Build config.toml content, preserving existing non-MCP fields. */
function generateConfigToml(
  servers: Record<string, ResolvedServer>,
  existingPath: string,
  warnings: string[],
): string {
  // Read existing file to preserve non-MCP fields
  let existing: Record<string, unknown> = {};
  try {
    const fs = require("node:fs");
    const text = fs.readFileSync(existingPath, "utf-8");
    existing = parseTOML(text) as unknown as Record<string, unknown>;
  } catch {
    // No existing file or malformed — start fresh
  }

  const mcpServers: Record<string, Record<string, unknown>> = {};
  for (const [name, server] of Object.entries(servers)) {
    const entry: Record<string, unknown> = {};

    const isHttp = server.transport === "streamable-http" || server.transport === "sse";
    if (isHttp) {
      entry.url = server.command;
    } else {
      entry.command = server.command;
      if (server.args.length > 0) entry.args = server.args;
    }

    if (Object.keys(server.env).length > 0) entry.env = server.env;

    // Map adapter-specific fields
    const codexExtras = server.adapters?.["codex-cli"] ?? {};
    for (const [key, value] of Object.entries(codexExtras)) {
      if (key === "scope") continue; // internal routing hint
      entry[key] = value;
    }

    mcpServers[name] = entry;
  }

  const output = { ...existing, mcp_servers: mcpServers };
  return stringifyTOML(output);
}

/** Concatenate all instructions into a single markdown block. */
function generateInstructionBlock(config: ResolvedConfig): string | null {
  const parts: string[] = [];
  for (const [, instr] of Object.entries(config.instructions)) {
    if (instr.targets.length > 0 && !instr.targets.includes("codex-cli")) {
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

  let existingContent: string | undefined;
  try {
    const fs = require("node:fs");
    existingContent = fs.readFileSync(existingPath, "utf-8");
  } catch {
    // No existing file
  }

  return spliceMarkerBlock(block, existingContent);
}
