/**
 * Codex CLI adapter: import native configs into core format.
 *
 * Reads ~/.codex/config.toml (global mcp_servers), .codex/config.toml (project-scoped),
 * AGENTS.md (instructions), and .codex/agents/*.toml (agent definitions).
 * Missing files are warned, not fatal.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { parse as parseTOML } from "@iarna/toml";
import type {
  ImportOptions,
  ImportResult,
  ImportedInstruction,
  ImportedServer,
  ImportedSkill,
} from "../types.ts";

interface CodexMcpServer {
  // stdio transport
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  env_vars?: string[];
  cwd?: string;
  // HTTP transport
  url?: string;
  bearer_token_env_var?: string;
  http_headers?: Record<string, string>;
  env_http_headers?: Record<string, string>;
  // common
  enabled?: boolean;
  required?: boolean;
  startup_timeout_sec?: number;
  tool_timeout_sec?: number;
  enabled_tools?: string[];
  disabled_tools?: string[];
  scopes?: string[];
  oauth_resource?: string;
  [key: string]: unknown;
}

interface CodexConfig {
  mcp_servers?: Record<string, CodexMcpServer>;
  [key: string]: unknown;
}

/** Core fields mapped directly to ImportedServer — everything else goes to adapterExtras. */
const CORE_FIELDS = new Set(["command", "args", "env", "url", "enabled"]);

/**
 * Import Codex CLI native configs into core format.
 */
export function importConfig(options: ImportOptions = {}, homeDir?: string): ImportResult {
  const home = homeDir ?? homedir();
  const entities = options.entities ?? ["servers", "instructions"];
  const warnings: string[] = [];
  const servers: ImportedServer[] = [];
  const instructions: ImportedInstruction[] = [];
  const skills: ImportedSkill[] = [];

  if (entities.includes("servers")) {
    // Global servers from ~/.codex/config.toml
    const globalPath = join(home, ".codex", "config.toml");
    const globalServers = readServersFromToml(globalPath, "global", warnings);
    servers.push(...globalServers);

    // Project servers from .codex/config.toml
    if (options.projectPath) {
      const projectPath = join(options.projectPath, ".codex", "config.toml");
      const projectServers = readServersFromToml(projectPath, "project", warnings);
      servers.push(...projectServers);
    }
  }

  if (entities.includes("instructions")) {
    // Global AGENTS.md
    const globalAgentsMd = join(home, ".codex", "AGENTS.md");
    const globalInstr = readAgentsMd(globalAgentsMd, "global");
    if (globalInstr) {
      instructions.push(globalInstr);
    }

    // Project AGENTS.md
    if (options.projectPath) {
      const projectAgentsMd = join(options.projectPath, "AGENTS.md");
      const projectInstr = readAgentsMd(projectAgentsMd, "project");
      if (projectInstr) {
        instructions.push(projectInstr);
      }
    }
  }

  return { servers, instructions, skills, warnings };
}

function readServersFromToml(
  filePath: string,
  scope: "global" | "project",
  warnings: string[],
): ImportedServer[] {
  const fs = require("node:fs");

  let text: string;
  try {
    text = fs.readFileSync(filePath, "utf-8");
  } catch {
    warnings.push(`File not found: ${filePath}`);
    return [];
  }

  let config: CodexConfig;
  try {
    config = parseTOML(text) as unknown as CodexConfig;
  } catch {
    warnings.push(`Malformed TOML: ${filePath}`);
    return [];
  }

  const mcpServers = config.mcp_servers;
  if (!mcpServers || typeof mcpServers !== "object") {
    return [];
  }

  const results: ImportedServer[] = [];
  for (const [name, entry] of Object.entries(mcpServers)) {
    if (!entry || typeof entry !== "object") continue;

    const isHttp = !!entry.url;
    const isStdio = !!entry.command;
    if (!isHttp && !isStdio) continue;

    const adapterExtras: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(entry)) {
      if (!CORE_FIELDS.has(key)) {
        adapterExtras[key] = value;
      }
    }

    const server: ImportedServer = {
      name,
      command: isStdio ? (entry.command ?? "") : (entry.url ?? ""),
      scope,
      transport: isHttp ? "streamable-http" : "stdio",
      ...(isHttp && entry.url && { url: entry.url }),
      ...(entry.args && { args: entry.args }),
      ...(entry.env && { env: entry.env }),
      enabled: entry.enabled !== false,
      ...(Object.keys(adapterExtras).length > 0 && { adapterExtras }),
    };

    results.push(server);
  }

  return results;
}

function readAgentsMd(filePath: string, scope: "global" | "project"): ImportedInstruction | null {
  try {
    const fs = require("node:fs");
    const content = fs.readFileSync(filePath, "utf-8");
    return {
      name: scope === "global" ? "agents-md-global" : "agents-md",
      content,
      scope: "always",
      description: `Instructions from ${scope} AGENTS.md`,
      sourcePath: filePath,
    };
  } catch {
    return null;
  }
}
