/**
 * Windsurf adapter: export resolved config to native format.
 *
 * Generates ~/.codeium/windsurf/mcp_config.json (mcpServers)
 * and .windsurf/rules/*.md (instructions with frontmatter).
 */

import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { generateAgentsMd } from "../../core/instructions.ts";
import { filterByTarget } from "../../core/instructions.ts";
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

  // 3. Generate AGENTS.md (Windsurf 2.0.44+)
  if (options.projectPath) {
    const targetInstructions = filterByTarget(config.instructions, "windsurf");
    if (Object.keys(targetInstructions).length > 0) {
      const agentsMdPath = join(options.projectPath, "AGENTS.md");
      let existingContent: string | undefined;
      try {
        const fs = require("node:fs");
        existingContent = fs.readFileSync(agentsMdPath, "utf-8");
      } catch {
        // No existing file
      }
      const agentsMdContent = generateAgentsMd(targetInstructions, existingContent);
      if (agentsMdContent) {
        files.push({ path: agentsMdPath, content: agentsMdContent, written: false });
      }
    }
  }

  // 4. Generate .windsurf/skills/ (Windsurf 2.0.44+)
  if (options.projectPath && Object.keys(config.skills).length > 0) {
    const skillFiles = generateSkillFiles(config, options.projectPath);
    files.push(...skillFiles);
  }

  // Write files unless dryRun
  if (!options.dryRun) {
    const fs = require("node:fs");
    for (const file of files) {
      try {
        const dir = dirname(file.path);
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

/** Generate .windsurf/skills/ files from resolved skills. */
function generateSkillFiles(config: ResolvedConfig, projectPath: string): WrittenFile[] {
  const files: WrittenFile[] = [];

  for (const [name, skill] of Object.entries(config.skills)) {
    // Check if skill targets windsurf (or has no specific targets)
    const wsAdapter = skill.adapters?.windsurf ?? {};
    const targets = (wsAdapter.targets as string[]) ?? [];
    if (targets.length > 0 && !targets.includes("windsurf")) {
      continue;
    }

    const skillDir = join(projectPath, ".windsurf", "skills", name);
    const skillMdPath = join(skillDir, "SKILL.md");
    const content = `# ${name}\n\n${skill.description}\n`;
    files.push({ path: skillMdPath, content, written: false });
  }

  return files;
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
