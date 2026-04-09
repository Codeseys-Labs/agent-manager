/**
 * Windsurf adapter: export resolved config to native format.
 *
 * Generates ~/.codeium/windsurf/mcp_config.json (mcpServers)
 * and .windsurf/rules/*.md (instructions with frontmatter).
 */

import { homedir } from "node:os";
import { join } from "node:path";
import type {
  ExportOptions,
  ExportResult,
  ResolvedConfig,
  ResolvedInstruction,
  WrittenFile,
} from "../types.ts";

/**
 * Export resolved config to Windsurf native files.
 */
export function exportConfig(
  config: ResolvedConfig,
  options: ExportOptions = {},
  homeDir?: string,
): ExportResult {
  const home = homeDir ?? homedir();
  const files: WrittenFile[] = [];
  const warnings: string[] = [];

  // 1. Generate ~/.codeium/windsurf/mcp_config.json
  const mcpPath = join(home, ".codeium", "windsurf", "mcp_config.json");
  const mcpContent = generateMcpConfig(config, mcpPath, warnings);
  files.push({ path: mcpPath, content: mcpContent, written: false });

  // 2. Generate .windsurf/rules/*.md (instructions)
  if (options.projectPath) {
    const ruleFiles = generateRuleFiles(config, options.projectPath);
    files.push(...ruleFiles);
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

/** Generate mcp_config.json, preserving existing non-MCP fields. */
function generateMcpConfig(
  config: ResolvedConfig,
  existingPath: string,
  warnings: string[],
): string {
  const fs = require("node:fs");

  let existing: Record<string, unknown> = {};
  try {
    const text = fs.readFileSync(existingPath, "utf-8");
    existing = JSON.parse(text);
  } catch {
    // No existing file — start fresh
  }

  const mcpServers: Record<string, unknown> = {};
  for (const [name, server] of Object.entries(config.servers)) {
    if (!server.enabled) continue;

    const entry: Record<string, unknown> = { command: server.command };
    if (server.args.length > 0) entry.args = server.args;
    if (Object.keys(server.env).length > 0) entry.env = server.env;

    // Map adapter-specific fields
    const wsExtras = server.adapters?.windsurf ?? {};
    for (const [key, value] of Object.entries(wsExtras)) {
      if (key === "scope") continue;
      entry[key] = value;
    }

    mcpServers[name] = entry;
  }

  const output = { ...existing, mcpServers };
  return `${JSON.stringify(output, null, 2)}\n`;
}

/** Map our scope enum to Windsurf trigger values. */
function scopeToTrigger(scope: "always" | "glob" | "agent-decision" | "manual"): string {
  switch (scope) {
    case "always":
      return "always_on";
    case "glob":
      return "glob";
    case "agent-decision":
      return "model_decision";
    case "manual":
      return "manual";
  }
}

/** Generate .windsurf/rules/*.md files from instructions. */
function generateRuleFiles(config: ResolvedConfig, projectPath: string): WrittenFile[] {
  const files: WrittenFile[] = [];

  for (const [name, instr] of Object.entries(config.instructions)) {
    if (instr.targets.length > 0 && !instr.targets.includes("windsurf")) {
      continue;
    }

    const trigger = scopeToTrigger(instr.scope);
    let frontmatter = `---\ntrigger: ${trigger}\n`;
    if (instr.scope === "glob" && instr.globs.length > 0) {
      frontmatter += `globs: "${instr.globs.join(",")}"\n`;
    }
    frontmatter += "---\n";

    const content = `${frontmatter}\n${instr.content}\n`;
    const filePath = join(projectPath, ".windsurf", "rules", `${name}.md`);
    files.push({ path: filePath, content, written: false });
  }

  return files;
}
