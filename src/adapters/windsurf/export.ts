/**
 * Windsurf adapter: export resolved config to native format.
 *
 * Generates ~/.codeium/windsurf/mcp_config.json (mcpServers)
 * and .windsurf/rules/*.md (instructions with frontmatter).
 */

import { homedir } from "node:os";
import { join } from "node:path";
import {
  generateAgentsMd,
  generateWikiContext,
  generateWindsurfRule,
  spliceWikiBlock,
} from "../../core/instructions.ts";
import { filterByTarget } from "../../core/instructions.ts";
import { sanitizePathSegment } from "../../lib/safe-path.ts";
import { buildMcpServersJson, writeExportFiles } from "../shared/export-utils.ts";
import type {
  ExportOptions,
  ExportResult,
  ResolvedConfig,
  ResolvedServer,
  WrittenFile,
} from "../types.ts";

/**
 * Export resolved config to Windsurf native files.
 */
export async function exportConfig(
  config: ResolvedConfig,
  options: ExportOptions = {},
  homeDir?: string,
): Promise<ExportResult> {
  const home = homeDir ?? homedir();
  const files: WrittenFile[] = [];
  const warnings: string[] = [];

  // 1. Generate ~/.codeium/windsurf/mcp_config.json
  const enabledServers: Record<string, ResolvedServer> = {};
  for (const [name, server] of Object.entries(config.servers)) {
    if (server.enabled) enabledServers[name] = server;
  }
  const mcpPath = join(home, ".codeium", "windsurf", "mcp_config.json");
  const mcpContent = buildMcpServersJson(enabledServers, mcpPath, {
    adapterKey: "windsurf",
    skipExtras: ["scope"],
  });
  files.push({ path: mcpPath, content: mcpContent, written: false });

  // 2. Generate .windsurf/rules/*.md (instructions)
  if (options.projectPath) {
    const ruleFiles = generateRuleFiles(config, options.projectPath);
    files.push(...ruleFiles);
  }

  // 3. Generate AGENTS.md (Windsurf 2.0.44+) (instructions + optional wiki context)
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
      let agentsMdContent = generateAgentsMd(targetInstructions, existingContent, warnings);
      if (agentsMdContent) {
        // Inject wiki context if enabled (ADR-0054 R7)
        const configDir = options.projectPath;
        const wikiBlock = await generateWikiContext(configDir, config.settings);
        if (wikiBlock) {
          agentsMdContent = spliceWikiBlock(wikiBlock, agentsMdContent, warnings, "AGENTS.md");
        }
        files.push({ path: agentsMdPath, content: agentsMdContent, written: false });
      }
    }
  }

  // 4. Generate .windsurf/skills/ (Windsurf 2.0.44+)
  if (options.projectPath && Object.keys(config.skills).length > 0) {
    const skillFiles = generateSkillFiles(config, options.projectPath);
    files.push(...skillFiles);
  }

  writeExportFiles(files, warnings, { dryRun: options.dryRun });

  return { files, warnings };
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

    const skillDir = join(projectPath, ".windsurf", "skills", sanitizePathSegment(name));
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

    const content = generateWindsurfRule(instr);
    const filePath = join(projectPath, ".windsurf", "rules", `${sanitizePathSegment(name)}.md`);
    files.push({ path: filePath, content, written: false });
  }

  return files;
}
