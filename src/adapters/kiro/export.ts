/**
 * Kiro adapter: export resolved config to native format.
 *
 * Generates .kiro/settings/mcp.json (MCP servers), .kiro/steering/*.md
 * (instructions with am:begin/am:end markers), and .kiro/agents/*.json
 * (agent definitions).
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { generateKiroSteering, generateWikiContext } from "../../core/instructions.ts";
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
 * Export resolved config to Kiro native files.
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
    const kiroAdapter = server.adapters?.kiro ?? {};
    if (kiroAdapter.scope === "project") {
      projectServers[name] = server;
    } else {
      globalServers[name] = server;
    }
  }

  // 1. Generate ~/.kiro/settings/mcp.json (global servers)
  const globalPath = join(home, ".kiro", "settings", "mcp.json");
  const globalContent = buildMcpServersJson(globalServers, globalPath, {
    adapterKey: "kiro",
    skipExtras: ["scope"],
    remote: true,
  });
  files.push({ path: globalPath, content: globalContent, written: false });

  // 2. Generate .kiro/settings/mcp.json (project-scoped servers)
  if (options.projectPath && Object.keys(projectServers).length > 0) {
    const projectMcpPath = join(options.projectPath, ".kiro", "settings", "mcp.json");
    const projectContent = buildMcpServersJson(projectServers, projectMcpPath, {
      adapterKey: "kiro",
      skipExtras: ["scope"],
      remote: true,
    });
    files.push({ path: projectMcpPath, content: projectContent, written: false });
  }

  // 3. Generate steering files (instructions)
  if (options.projectPath) {
    const steeringFiles = generateSteeringFiles(config, options.projectPath);
    files.push(...steeringFiles);

    // 4. Inject apply-time wiki context (ADR-0054 R7). Kiro has no single
    //    canonical instruction file (it uses the per-rule `.kiro/steering/`
    //    directory), so the wiki block lands in a dedicated managed steering
    //    file `.kiro/steering/am-wiki.md` with `inclusion: always`. It augments
    //    an existing instruction surface, so we only emit it when this target
    //    actually has steering files — mirroring the reference adapters that
    //    splice wiki only alongside an instruction file.
    if (steeringFiles.length > 0) {
      const wikiBlock = await generateWikiContext(options.projectPath, config.settings);
      if (wikiBlock) {
        const wikiContent = `---\ninclusion: always\ndescription: "Agent knowledge (managed by agent-manager)"\n---\n\n${wikiBlock}\n`;
        const wikiPath = join(options.projectPath, ".kiro", "steering", "am-wiki.md");
        files.push({ path: wikiPath, content: wikiContent, written: false });
      }
    }
  }

  writeExportFiles(files, warnings, { dryRun: options.dryRun });

  return { files, warnings };
}

/** Generate steering markdown files from instructions. */
function generateSteeringFiles(config: ResolvedConfig, projectPath: string): WrittenFile[] {
  const files: WrittenFile[] = [];

  for (const [name, instr] of Object.entries(config.instructions)) {
    if (instr.targets.length > 0 && !instr.targets.includes("kiro")) {
      continue;
    }

    const steeringName = sanitizePathSegment(name.replace(/^steering-/, ""));
    const filePath = join(projectPath, ".kiro", "steering", `${steeringName}.md`);

    // Try to read existing file so the shared generator can splice the managed
    // section while preserving hand-written content outside the am markers.
    let existingContent: string | undefined;
    try {
      const fs = require("node:fs");
      existingContent = fs.readFileSync(filePath, "utf-8");
    } catch {
      // No existing file
    }

    const content = generateKiroSteering(instr, existingContent);
    files.push({ path: filePath, content, written: false });
  }

  return files;
}
