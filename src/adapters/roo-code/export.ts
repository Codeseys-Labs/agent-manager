/**
 * Roo Code adapter: export resolved config to native format.
 *
 * Generates mcp_settings.json (global MCP servers via VS Code globalStorage),
 * .roo/mcp.json (project MCP servers), and .roo/rules/*.md (instructions).
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { generateWikiContext } from "../../core/instructions.ts";
import { sanitizePathSegment } from "../../lib/safe-path.ts";
import { buildMcpServersJson, writeExportFiles } from "../shared/export-utils.ts";
import type {
  ExportOptions,
  ExportResult,
  ResolvedConfig,
  ResolvedServer,
  WrittenFile,
} from "../types.ts";
import { getGlobalStoragePath } from "./detect.ts";

/**
 * Export resolved config to Roo Code native files.
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
    const rooAdapter = server.adapters?.["roo-code"] ?? {};
    if (rooAdapter.scope === "project") {
      projectServers[name] = server;
    } else {
      globalServers[name] = server;
    }
  }

  // 1. Generate global mcp_settings.json
  const mcpPath = join(getGlobalStoragePath(home), "settings", "mcp_settings.json");
  const mcpContent = buildMcpServersJson(globalServers, mcpPath, {
    adapterKey: "roo-code",
    skipExtras: ["scope"],
  });
  files.push({ path: mcpPath, content: mcpContent, written: false });

  // 2. Generate .roo/mcp.json (project-scoped servers)
  if (options.projectPath && Object.keys(projectServers).length > 0) {
    const projectMcpPath = join(options.projectPath, ".roo", "mcp.json");
    const projectMcpContent = buildMcpServersJson(projectServers, projectMcpPath, {
      adapterKey: "roo-code",
      skipExtras: ["scope"],
    });
    files.push({
      path: projectMcpPath,
      content: projectMcpContent,
      written: false,
    });
  }

  // 3. Generate .roo/rules/*.md (instructions)
  if (options.projectPath) {
    const ruleFiles = generateRuleFiles(config, options.projectPath);
    files.push(...ruleFiles);

    // 4. Inject apply-time wiki context (ADR-0054 R7). Roo Code has no single
    //    canonical instruction file (it uses the per-rule `.roo/rules/`
    //    directory), so the wiki block lands in a dedicated managed rule file
    //    `.roo/rules/am-wiki.md`. It augments an existing instruction surface,
    //    so we only emit it when this target actually has rules — mirroring the
    //    reference adapters that splice wiki only alongside an instruction file.
    if (ruleFiles.length > 0) {
      const wikiBlock = await generateWikiContext(options.projectPath, config.settings);
      if (wikiBlock) {
        const wikiPath = join(options.projectPath, ".roo", "rules", "am-wiki.md");
        files.push({ path: wikiPath, content: `${wikiBlock}\n`, written: false });
      }
    }
  }

  writeExportFiles(files, warnings, { dryRun: options.dryRun });

  return { files, warnings };
}

/** Generate .roo/rules/*.md files from instructions. */
function generateRuleFiles(config: ResolvedConfig, projectPath: string): WrittenFile[] {
  const files: WrittenFile[] = [];

  for (const [name, instr] of Object.entries(config.instructions)) {
    if (instr.targets.length > 0 && !instr.targets.includes("roo-code")) {
      continue;
    }

    const content = `${instr.content}\n`;
    const filePath = join(projectPath, ".roo", "rules", `${sanitizePathSegment(name)}.md`);
    files.push({ path: filePath, content, written: false });
  }

  return files;
}
