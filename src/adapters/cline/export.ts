/**
 * Cline adapter: export resolved config to native format.
 *
 * Generates cline_mcp_settings.json (MCP servers) and
 * .clinerules/*.md (instructions).
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
 * Export resolved config to Cline native files.
 */
export async function exportConfig(
  config: ResolvedConfig,
  options: ExportOptions = {},
  homeDir?: string,
): Promise<ExportResult> {
  const home = homeDir ?? homedir();
  const files: WrittenFile[] = [];
  const warnings: string[] = [];

  // 1. Generate cline_mcp_settings.json
  const enabledServers: Record<string, ResolvedServer> = {};
  for (const [name, server] of Object.entries(config.servers)) {
    if (server.enabled) enabledServers[name] = server;
  }
  const mcpPath = join(getGlobalStoragePath(home), "settings", "cline_mcp_settings.json");
  const mcpContent = buildMcpServersJson(enabledServers, mcpPath, { adapterKey: "cline" });
  files.push({ path: mcpPath, content: mcpContent, written: false });

  // 2. Generate .clinerules/*.md (instructions)
  if (options.projectPath) {
    const ruleFiles = generateRuleFiles(config, options.projectPath);
    files.push(...ruleFiles);

    // 3. Inject apply-time wiki context (ADR-0054 R7). Cline has no single
    //    canonical instruction file (it uses the per-rule `.clinerules/`
    //    directory), so the wiki block lands in a dedicated managed rule file
    //    `.clinerules/am-wiki.md`. It augments an existing instruction surface,
    //    so we only emit it when this target actually has rules — mirroring the
    //    reference adapters that splice wiki only alongside an instruction file.
    if (ruleFiles.length > 0) {
      const wikiBlock = await generateWikiContext(options.projectPath, config.settings);
      if (wikiBlock) {
        const wikiPath = join(options.projectPath, ".clinerules", "am-wiki.md");
        files.push({ path: wikiPath, content: `${wikiBlock}\n`, written: false });
      }
    }
  }

  writeExportFiles(files, warnings, { dryRun: options.dryRun });

  return { files, warnings };
}

/** Generate .clinerules/*.md files from instructions. */
function generateRuleFiles(config: ResolvedConfig, projectPath: string): WrittenFile[] {
  const files: WrittenFile[] = [];

  for (const [name, instr] of Object.entries(config.instructions)) {
    if (instr.targets.length > 0 && !instr.targets.includes("cline")) {
      continue;
    }

    const content = `${instr.content}\n`;
    const filePath = join(projectPath, ".clinerules", `${sanitizePathSegment(name)}.md`);
    files.push({ path: filePath, content, written: false });
  }

  return files;
}
