/**
 * Continue adapter: export resolved config to native format.
 *
 * Generates ~/.continue/config.json with mcpServers as an ARRAY
 * (Continue's format uses name-bearing array entries, not object maps).
 * Also writes .continue/rules/<name>.md (project scope) or
 * ~/.continue/rules/<name>.md (global scope) for instructions.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import type { ExportOptions, ExportResult, ResolvedConfig, WrittenFile } from "../types.ts";

/**
 * Export resolved config to Continue native files.
 */
export function exportConfig(
  config: ResolvedConfig,
  options: ExportOptions = {},
  homeDir?: string,
): ExportResult {
  const home = homeDir ?? homedir();
  const files: WrittenFile[] = [];
  const warnings: string[] = [];

  // Generate ~/.continue/config.json
  const configPath = join(home, ".continue", "config.json");
  const configContent = generateConfig(config, configPath);
  files.push({ path: configPath, content: configContent, written: false });

  // Generate rule .md files for instructions
  const ruleFiles = generateRuleFiles(config, home, options.projectPath);
  files.push(...ruleFiles);

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

/** Generate config.json, preserving existing non-MCP fields. */
function generateConfig(config: ResolvedConfig, existingPath: string): string {
  const fs = require("node:fs");

  let existing: Record<string, unknown> = {};
  try {
    const text = fs.readFileSync(existingPath, "utf-8");
    existing = JSON.parse(text);
  } catch {
    // No existing file — start fresh
  }

  // Convert server map to array (Continue's format)
  const mcpServers: Record<string, unknown>[] = [];
  for (const [name, server] of Object.entries(config.servers)) {
    if (!server.enabled) continue;

    const entry: Record<string, unknown> = {
      name,
      command: server.command,
    };
    if (server.args.length > 0) entry.args = server.args;
    if (Object.keys(server.env).length > 0) entry.env = server.env;

    // Map adapter-specific fields
    const ctExtras = server.adapters?.continue ?? {};
    for (const [key, value] of Object.entries(ctExtras)) {
      entry[key] = value;
    }

    mcpServers.push(entry);
  }

  // Build rules array from instructions
  const rules: Record<string, unknown>[] = [];
  for (const [name, instr] of Object.entries(config.instructions)) {
    if (instr.targets.length > 0 && !instr.targets.includes("continue")) {
      continue;
    }

    // If the content looks like a uses reference, preserve it
    if (
      instr.content.startsWith("file://") ||
      (instr.content.includes("/") && !instr.content.includes(" "))
    ) {
      rules.push({ uses: instr.content });
    } else {
      rules.push({ uses: `file://.continue/rules/${name}.md` });
    }
  }

  const output: Record<string, unknown> = { ...existing, mcpServers };
  if (rules.length > 0) {
    output.rules = rules;
  }

  return `${JSON.stringify(output, null, 2)}\n`;
}

/** Generate .continue/rules/*.md files from instructions. */
function generateRuleFiles(
  config: ResolvedConfig,
  home: string,
  projectPath?: string,
): WrittenFile[] {
  const files: WrittenFile[] = [];

  for (const [name, instr] of Object.entries(config.instructions)) {
    if (instr.targets.length > 0 && !instr.targets.includes("continue")) {
      continue;
    }

    // Skip instructions that are external references (not inline content)
    if (
      instr.content.startsWith("file://") ||
      (instr.content.includes("/") && !instr.content.includes(" "))
    ) {
      continue;
    }

    const content = `${instr.content}\n`;
    // Write to project .continue/rules/ if projectPath is available, otherwise global
    const basePath = projectPath ?? home;
    const filePath = join(basePath, ".continue", "rules", `${name}.md`);
    files.push({ path: filePath, content, written: false });
  }

  return files;
}
