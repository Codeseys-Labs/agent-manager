/**
 * Copilot adapter: export resolved config to native format.
 *
 * Generates .vscode/mcp.json (using "servers" key, NOT "mcpServers"),
 * .github/copilot-instructions.md, and .github/instructions/*.instructions.md.
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { atomicWriteFileSync } from "../../core/atomic-write.ts";
import { sanitizePathSegment } from "../../lib/safe-path.ts";
import { resolveVSCodeUserMcpJson } from "../shared/vscode-paths.ts";
import type {
  ExportOptions,
  ExportResult,
  ResolvedConfig,
  ResolvedServer,
  WrittenFile,
} from "../types.ts";

/**
 * Export resolved config to Copilot native files.
 */
export function exportConfig(
  config: ResolvedConfig,
  options: ExportOptions = {},
  homeDir?: string,
): ExportResult {
  const home = homeDir ?? homedir();
  const files: WrittenFile[] = [];
  const warnings: string[] = [];

  // Partition servers by scope for user-vs-project routing.
  const userServers: Record<string, ResolvedServer> = {};
  const projectServers: Record<string, ResolvedServer> = {};
  for (const [name, server] of Object.entries(config.servers)) {
    if (!server.enabled) continue;
    const cpExtras = server.adapters?.copilot ?? {};
    if (cpExtras.scope === "global") userServers[name] = server;
    else projectServers[name] = server;
  }

  // 1. User-scope mcp.json — only write if an existing file is already at one
  //    of the candidate paths (so we don't accidentally create a Code variant
  //    that the user doesn't actually use).
  if (Object.keys(userServers).length > 0) {
    const target = pickExistingUserMcp(home);
    if (target) {
      const content = generateServersJson(userServers, target);
      files.push({ path: target, content, written: false });
    } else {
      warnings.push(
        "No user-scope VS Code mcp.json exists; skipping user-scope export. Create one via 'MCP: Open User Configuration' in VS Code.",
      );
    }
  }

  if (options.projectPath) {
    // 2. Generate .vscode/mcp.json with "servers" key
    const mcpPath = join(options.projectPath, ".vscode", "mcp.json");
    const mcpContent = generateMcpJson({ ...config, servers: projectServers }, mcpPath, warnings);
    files.push({ path: mcpPath, content: mcpContent, written: false });

    // 3. Generate .github/copilot-instructions.md (always-scoped instructions)
    const globalInstr = generateGlobalInstructions(config);
    if (globalInstr) {
      const instrPath = join(options.projectPath, ".github", "copilot-instructions.md");
      files.push({ path: instrPath, content: globalInstr, written: false });
    }

    // 4. Generate .github/instructions/*.instructions.md (glob-scoped)
    const scopedFiles = generateScopedInstructions(config, options.projectPath);
    files.push(...scopedFiles);
  }

  // Write files unless dryRun
  if (!options.dryRun) {
    const fs = require("node:fs");
    for (const file of files) {
      try {
        const dir = file.path.substring(0, file.path.lastIndexOf("/"));
        fs.mkdirSync(dir, { recursive: true });
        atomicWriteFileSync(file.path, file.content);
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

/**
 * Return the first existing user-scope mcp.json across all VS Code variants,
 * or undefined if none exist.
 */
function pickExistingUserMcp(home: string): string | undefined {
  for (const candidate of resolveVSCodeUserMcpJson(home)) {
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

/**
 * Build the on-disk user-scope `{ "servers": { ... } }` JSON, preserving any
 * existing top-level keys we don't manage.
 */
function generateServersJson(
  serversMap: Record<string, ResolvedServer>,
  existingPath: string,
): string {
  const fs = require("node:fs");
  let existing: Record<string, unknown> = {};
  try {
    const text = fs.readFileSync(existingPath, "utf-8");
    existing = JSON.parse(text);
  } catch {
    /* fresh file */
  }

  const servers: Record<string, unknown> = {};
  for (const [name, server] of Object.entries(serversMap)) {
    const cpExtras = server.adapters?.copilot ?? {};
    const serverType = (cpExtras.type as string) ?? "stdio";
    if (server.transport === "streamable-http" || serverType === "http") {
      servers[name] = { type: "http", url: cpExtras.url ?? server.command };
    } else {
      const entry: Record<string, unknown> = { command: server.command };
      if (server.args.length > 0) entry.args = server.args;
      if (Object.keys(server.env).length > 0) entry.env = server.env;
      for (const [key, value] of Object.entries(cpExtras)) {
        if (key === "scope" || key === "type" || key === "url") continue;
        entry[key] = value;
      }
      servers[name] = entry;
    }
  }
  const output = { ...existing, servers };
  return `${JSON.stringify(output, null, 2)}\n`;
}

/** Generate .vscode/mcp.json, preserving existing non-server fields. */
function generateMcpJson(config: ResolvedConfig, existingPath: string, warnings: string[]): string {
  const fs = require("node:fs");

  let existing: Record<string, unknown> = {};
  try {
    const text = fs.readFileSync(existingPath, "utf-8");
    existing = JSON.parse(text);
  } catch {
    // No existing file — start fresh
  }

  const servers: Record<string, unknown> = {};
  for (const [name, server] of Object.entries(config.servers)) {
    if (!server.enabled) continue;

    const cpExtras = server.adapters?.copilot ?? {};
    const serverType = (cpExtras.type as string) ?? "stdio";

    if (server.transport === "streamable-http" || serverType === "http") {
      // HTTP server
      const entry: Record<string, unknown> = {
        type: "http",
        url: cpExtras.url ?? server.command,
      };
      servers[name] = entry;
    } else {
      // stdio server
      const entry: Record<string, unknown> = { command: server.command };
      if (server.args.length > 0) entry.args = server.args;
      if (Object.keys(server.env).length > 0) entry.env = server.env;

      // Map adapter-specific fields (excluding internal routing hints)
      for (const [key, value] of Object.entries(cpExtras)) {
        if (key === "scope" || key === "type" || key === "url") continue;
        entry[key] = value;
      }

      servers[name] = entry;
    }
  }

  // Use "servers" key (NOT "mcpServers")
  const output = { ...existing, servers };
  return `${JSON.stringify(output, null, 2)}\n`;
}

/** Collect always-scoped instructions into a single copilot-instructions.md. */
function generateGlobalInstructions(config: ResolvedConfig): string | null {
  const parts: string[] = [];
  for (const [, instr] of Object.entries(config.instructions)) {
    if (instr.targets.length > 0 && !instr.targets.includes("copilot")) {
      continue;
    }
    if (instr.scope !== "always") continue;
    parts.push(instr.content);
  }
  if (parts.length === 0) return null;
  return `${parts.join("\n\n")}\n`;
}

/** Generate .github/instructions/*.instructions.md for glob-scoped instructions. */
function generateScopedInstructions(config: ResolvedConfig, projectPath: string): WrittenFile[] {
  const files: WrittenFile[] = [];

  for (const [name, instr] of Object.entries(config.instructions)) {
    if (instr.targets.length > 0 && !instr.targets.includes("copilot")) {
      continue;
    }
    if (instr.scope !== "glob" || instr.globs.length === 0) continue;

    const applyTo = instr.globs.join(",");
    const content = `---\napplyTo: "${applyTo}"\n---\n\n${instr.content}\n`;
    const filePath = join(
      projectPath,
      ".github",
      "instructions",
      `${sanitizePathSegment(name)}.instructions.md`,
    );
    files.push({ path: filePath, content, written: false });
  }

  return files;
}
