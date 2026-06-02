/**
 * Gemini CLI adapter: export resolved config to native format.
 *
 * Generates ~/.gemini/settings.json (mcpServers),
 * .gemini/settings.json (project servers),
 * and GEMINI.md (instructions with am:begin/am:end markers).
 */

import { homedir } from "node:os";
import { join } from "node:path";
import {
  filterByTarget,
  generateGeminiMd,
  generateWikiContext,
  spliceWikiBlock,
} from "../../core/instructions.ts";
import { buildMcpServersJson, writeExportFiles } from "../shared/export-utils.ts";
import type {
  ExportOptions,
  ExportResult,
  ResolvedConfig,
  ResolvedServer,
  WrittenFile,
} from "../types.ts";

/**
 * Export resolved config to Gemini CLI native files.
 */
export async function exportConfig(
  config: ResolvedConfig,
  options: ExportOptions = {},
  homeDir?: string,
): Promise<ExportResult> {
  const home = homeDir ?? homedir();
  const files: WrittenFile[] = [];
  const warnings: string[] = [];

  // Partition servers by scope (presence of gemini-cli adapter scope hint)
  const globalServers: Record<string, ResolvedServer> = {};
  const projectServers: Record<string, ResolvedServer> = {};

  for (const [name, server] of Object.entries(config.servers)) {
    if (!server.enabled) continue;
    const gcAdapter = server.adapters?.["gemini-cli"] ?? {};
    if (gcAdapter.scope === "project") {
      projectServers[name] = server;
    } else {
      globalServers[name] = server;
    }
  }

  // 1. Generate ~/.gemini/settings.json
  const globalPath = join(home, ".gemini", "settings.json");
  const globalContent = buildMcpServersJson(globalServers, globalPath, {
    adapterKey: "gemini-cli",
    skipExtras: ["scope"],
  });
  files.push({
    path: globalPath,
    content: globalContent,
    written: false,
  });

  // 2. Generate .gemini/settings.json (project-scoped servers)
  if (options.projectPath && Object.keys(projectServers).length > 0) {
    const projectSettingsPath = join(options.projectPath, ".gemini", "settings.json");
    const projectContent = buildMcpServersJson(projectServers, projectSettingsPath, {
      adapterKey: "gemini-cli",
      skipExtras: ["scope"],
    });
    files.push({
      path: projectSettingsPath,
      content: projectContent,
      written: false,
    });
  }

  // 3. Generate GEMINI.md (instructions + optional wiki context)
  if (options.projectPath) {
    const targeted = filterByTarget(config.instructions, "gemini-cli");
    if (Object.keys(targeted).length > 0) {
      const geminiMdPath = join(options.projectPath, "GEMINI.md");
      let existingContent: string | undefined;
      try {
        const fs = require("node:fs");
        existingContent = fs.readFileSync(geminiMdPath, "utf-8");
      } catch {
        // No existing file
      }
      let geminiMdContent = generateGeminiMd(targeted, existingContent);

      // Inject wiki context if enabled (ADR-0054 R7)
      const configDir = options.projectPath;
      const wikiBlock = await generateWikiContext(configDir, config.settings);
      if (wikiBlock) {
        geminiMdContent = spliceWikiBlock(wikiBlock, geminiMdContent);
      }

      files.push({
        path: geminiMdPath,
        content: geminiMdContent,
        written: false,
      });
    }
  }

  writeExportFiles(files, warnings, { dryRun: options.dryRun });

  return { files, warnings };
}
