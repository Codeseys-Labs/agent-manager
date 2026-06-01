/**
 * Workspace-to-profile import: scan project for existing AI tool configs,
 * deduplicate, and generate .agent-manager.toml.
 *
 * Implements ADR-0014.
 */

import { existsSync } from "node:fs";
import { basename, isAbsolute, join, relative, sep } from "node:path";
import { getAdapter, listAdapters } from "../adapters/registry";
import type { ImportedInstruction, ImportedServer } from "../adapters/types";
import { writeProjectConfig } from "../core/config";
import type { Instruction, ProjectConfig, Server } from "../core/schema";
import { debug, error, info, output } from "../lib/output";
import type { OutputOptions } from "../lib/output";
import { extractServerIdentity } from "./import";

interface ScanResult {
  adapter: string;
  displayName: string;
  servers: ImportedServer[];
  instructions: ImportedInstruction[];
}

/**
 * Is `child` a path strictly inside `parent`?
 *
 * Uses path.relative() so it is separator-agnostic. A naive
 * `child.startsWith(`${parent}/`)` check is POSIX-only: on Windows
 * `join()` produces backslash separators, so the hardcoded forward slash
 * never matches and project-scoped instructions are silently dropped.
 * `relative()` returns "" for an identical path, a `..`-prefixed path for
 * something outside, or an absolute path on a different drive — none of
 * which count as "inside".
 */
function isInsideProject(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

/**
 * Scan a project directory for existing AI tool configs, deduplicate,
 * and write .agent-manager.toml.
 */
export async function initProject(
  projectPath: string,
  opts: OutputOptions,
): Promise<{ written: boolean; config?: ProjectConfig }> {
  const outputPath = join(projectPath, ".agent-manager.toml");

  // Check if already exists
  if (existsSync(outputPath)) {
    process.exitCode = 1;
    error(`Already initialized. .agent-manager.toml exists at ${outputPath}`, opts);
    return { written: false };
  }

  // 1. Scan all registered adapters
  const scanResults = await scanAdapters(projectPath, opts);

  if (scanResults.length === 0) {
    info("No AI tool configs detected in this workspace.", opts);
    return { written: false };
  }

  // Report what was found
  for (const result of scanResults) {
    const parts: string[] = [];
    if (result.servers.length > 0) {
      parts.push(
        `${result.servers.length} server(s): ${result.servers.map((s) => s.name).join(", ")}`,
      );
    }
    if (result.instructions.length > 0) {
      parts.push(`${result.instructions.length} instruction(s)`);
    }
    info(`  ${result.displayName}: ${parts.join(", ")}`, opts);
  }

  // 2. Merge and deduplicate
  const { servers, duplicates, serverWarnings } = deduplicateServers(scanResults, opts);
  const instructions = mergeInstructions(scanResults, projectPath, opts);

  if (servers.length === 0 && Object.keys(instructions).length === 0) {
    info("Nothing to import after deduplication.", opts);
    return { written: false };
  }

  // 3. Build ProjectConfig
  const projectName = basename(projectPath);
  const projectConfig: ProjectConfig = {
    project: {
      name: projectName,
      description: "Imported from workspace AI configs",
    },
  };

  if (servers.length > 0) {
    const serverMap: Record<string, Server> = {};
    for (const srv of servers) {
      const entry: Server = {
        command: srv.command,
        transport: srv.transport ?? "stdio",
        enabled: srv.enabled ?? true,
      };
      if (srv.args && srv.args.length > 0) entry.args = srv.args;
      if (srv.env && Object.keys(srv.env).length > 0) entry.env = srv.env;
      if (srv.description) entry.description = srv.description;
      if (srv.tags && srv.tags.length > 0) entry.tags = srv.tags;
      serverMap[srv.name] = entry;
    }
    projectConfig.servers = serverMap;
  }

  if (Object.keys(instructions).length > 0) {
    projectConfig.instructions = instructions;
  }

  // 4. Write .agent-manager.toml
  await writeProjectConfig(outputPath, projectConfig);

  // 5. Report
  info(
    `Imported ${servers.length} unique server(s)${duplicates > 0 ? `, ${duplicates} duplicate(s) reconciled` : ""}`,
    opts,
  );
  info(`Imported ${Object.keys(instructions).length} instruction(s)`, opts);
  info(`Created ${outputPath}`, opts);

  if (opts.json) {
    output(
      {
        action: "init-project",
        projectPath,
        outputPath,
        servers: servers.map((s) => s.name),
        instructions: Object.keys(instructions),
        duplicates,
        adaptersScanned: scanResults.map((r) => r.adapter),
        warnings: serverWarnings,
      },
      opts,
    );
  }

  return { written: true, config: projectConfig };
}

/** Scan all registered adapters for project-level configs. */
async function scanAdapters(projectPath: string, opts: OutputOptions): Promise<ScanResult[]> {
  const results: ScanResult[] = [];

  for (const name of listAdapters()) {
    const adapter = await getAdapter(name);
    if (!adapter) continue;

    // Only check adapters that support MCP or instructions
    const caps = adapter.meta.capabilities;
    if (!caps.includes("mcp") && !caps.includes("instructions")) continue;

    // Detect with project scope
    let detected;
    try {
      detected = await adapter.detect();
    } catch {
      debug(`${adapter.meta.displayName}: detect() failed`, opts);
      continue;
    }

    // Also try import with projectPath even if not "installed" globally,
    // since we care about project-level configs
    let imported;
    try {
      imported = await adapter.import({ projectPath });
    } catch {
      debug(`${adapter.meta.displayName}: import() failed`, opts);
      continue;
    }

    // Filter to project-scoped content only — exclude global configs
    const projectServers = imported.servers.filter((s) => s.scope === "project");
    const projectInstructions = imported.instructions.filter((i) => {
      // Include instructions with a sourcePath inside the project
      if (i.sourcePath && isInsideProject(projectPath, i.sourcePath)) return true;
      // Exclude instructions from global paths (home dir, ~/.config, etc.)
      if (i.sourcePath) return false;
      // No sourcePath — include only if we also found project servers
      // (implies this adapter has project-level presence)
      return projectServers.length > 0;
    });
    const hasContent = projectServers.length > 0 || projectInstructions.length > 0;

    if (hasContent) {
      results.push({
        adapter: name,
        displayName: adapter.meta.displayName,
        servers: projectServers,
        instructions: projectInstructions,
      });
    }
  }

  return results;
}

/** Deduplicate servers across adapters using identity resolution. */
function deduplicateServers(
  scanResults: ScanResult[],
  opts: OutputOptions,
): {
  servers: ImportedServer[];
  duplicates: number;
  serverWarnings: string[];
} {
  const servers: ImportedServer[] = [];
  const identityMap = new Map<string, string>(); // identity -> first server name
  const nameSet = new Set<string>();
  let duplicates = 0;
  const warnings: string[] = [];

  for (const result of scanResults) {
    for (const srv of result.servers) {
      // Check name collision first
      if (nameSet.has(srv.name)) {
        debug(`Skipping "${srv.name}" from ${result.displayName} — name already taken`, opts);
        duplicates++;
        continue;
      }

      // Check identity-based dedup
      const identity = extractServerIdentity(srv.command, srv.args);
      const existingName = identityMap.get(identity);
      if (existingName) {
        debug(
          `Skipping "${srv.name}" from ${result.displayName} — duplicate of "${existingName}" (identity: ${identity})`,
          opts,
        );
        duplicates++;
        warnings.push(
          `"${srv.name}" (${result.displayName}) is a duplicate of "${existingName}" (identity: ${identity})`,
        );
        continue;
      }

      servers.push(srv);
      nameSet.add(srv.name);
      identityMap.set(identity, srv.name);
    }
  }

  return { servers, duplicates, serverWarnings: warnings };
}

/** Merge instructions, preferring content_file references where possible. */
function mergeInstructions(
  scanResults: ScanResult[],
  projectPath: string,
  opts: OutputOptions,
): Record<string, Instruction> {
  const instructions: Record<string, Instruction> = {};
  const nameSet = new Set<string>();

  for (const result of scanResults) {
    for (const instr of result.instructions) {
      // Avoid name collisions
      let name = instr.name;
      if (nameSet.has(name)) {
        name = `${result.adapter}-${name}`;
        if (nameSet.has(name)) continue; // skip if still collides
      }
      nameSet.add(name);

      // Use content_file if we have a sourcePath within the project
      if (instr.sourcePath && isInsideProject(projectPath, instr.sourcePath)) {
        // Normalise to forward slashes so the stored content_file reference is
        // portable: a config committed on Windows must resolve on POSIX and
        // vice versa. relative() returns native separators (backslash on Win).
        const relPath = relative(projectPath, instr.sourcePath).split(sep).join("/");
        instructions[name] = {
          content_file: relPath,
          scope: instr.scope,
          ...(instr.description && { description: instr.description }),
        };
      } else {
        instructions[name] = {
          content: instr.content,
          scope: instr.scope,
          ...(instr.description && { description: instr.description }),
        };
      }
    }
  }

  return instructions;
}
