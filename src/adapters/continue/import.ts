/**
 * Continue adapter: import native configs into core format.
 *
 * Reads ~/.continue/config.json (global MCP servers as array)
 * and rules from the config's rules section.
 *
 * Key difference: Continue stores mcpServers as an ARRAY with a `name` field,
 * not as an object map like other tools.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { fileExistsSync } from "../shared/utils.ts";
import type { ImportOptions, ImportResult, ImportedInstruction, ImportedServer } from "../types.ts";
import { extractPackageId } from "./identity.ts";

interface ContinueServer {
  name: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  [key: string]: unknown;
}

interface ContinueRule {
  uses?: string;
  content?: string;
  name?: string;
  [key: string]: unknown;
}

interface ContinueConfig {
  mcpServers?: ContinueServer[];
  rules?: ContinueRule[];
  [key: string]: unknown;
}

/**
 * Import Continue native configs into core format.
 */
export function importConfig(options: ImportOptions = {}, homeDir?: string): ImportResult {
  const home = homeDir ?? homedir();
  const entities = options.entities ?? ["servers", "instructions"];
  const warnings: string[] = [];
  const servers: ImportedServer[] = [];
  const instructions: ImportedInstruction[] = [];

  if (entities.includes("servers")) {
    // Global servers from ~/.continue/config.json
    const globalConfigPath = join(home, ".continue", "config.json");
    const globalServers = readServersFromFile(globalConfigPath, "global", warnings);
    servers.push(...globalServers);

    // Project servers from .continue/config.json
    if (options.projectPath) {
      const projectConfigPath = join(options.projectPath, ".continue", "config.json");
      const projectServers = readServersFromFile(projectConfigPath, "project", warnings);
      servers.push(...projectServers);
    }
  }

  if (entities.includes("instructions")) {
    // Global rules
    const globalConfigPath = join(home, ".continue", "config.json");
    const globalRules = readRulesFromFile(globalConfigPath, warnings);
    instructions.push(...globalRules);

    // Project rules
    if (options.projectPath) {
      const projectConfigPath = join(options.projectPath, ".continue", "config.json");
      const projectRules = readRulesFromFile(projectConfigPath, warnings);
      instructions.push(...projectRules);
    }
  }

  return { servers, instructions, skills: [], warnings };
}

const CORE_FIELDS = new Set(["name", "command", "args", "env"]);

function readServersFromFile(
  filePath: string,
  scope: "global" | "project",
  warnings: string[],
): ImportedServer[] {
  const config = readConfigFile(filePath, warnings, scope === "global");
  if (!config) return [];

  const mcpServers = config.mcpServers;
  if (!Array.isArray(mcpServers)) return [];

  const results: ImportedServer[] = [];
  for (const entry of mcpServers) {
    if (!entry || typeof entry !== "object" || !entry.command || !entry.name) continue;

    const adapterExtras: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(entry)) {
      if (!CORE_FIELDS.has(key)) {
        adapterExtras[key] = value;
      }
    }

    const server: ImportedServer = {
      name: entry.name,
      command: entry.command,
      scope,
      ...(entry.args && { args: entry.args }),
      ...(entry.env && { env: entry.env }),
      enabled: true,
      packageId: extractPackageId(entry.command, entry.args),
      ...(Object.keys(adapterExtras).length > 0 && { adapterExtras }),
    };

    results.push(server);
  }

  return results;
}

function readRulesFromFile(filePath: string, warnings: string[]): ImportedInstruction[] {
  const config = readConfigFile(filePath, warnings, false);
  if (!config) return [];

  const rules = config.rules;
  if (!Array.isArray(rules)) return [];

  const instructions: ImportedInstruction[] = [];
  for (let i = 0; i < rules.length; i++) {
    const rule = rules[i];
    if (!rule || typeof rule !== "object") continue;

    if (typeof rule.uses === "string") {
      const name = rule.name ?? deriveRuleName(rule.uses, i);
      instructions.push({
        name,
        content: rule.uses,
        scope: "always",
        description: `Continue rule reference: ${rule.uses}`,
      });
    }
  }

  return instructions;
}

/** Derive a name from a uses reference or fall back to index. */
function deriveRuleName(uses: string, index: number): string {
  // file://path/to/rules.md -> rules
  if (uses.startsWith("file://")) {
    const path = uses.slice(7);
    const base = path.split("/").pop() ?? "";
    const name = base.replace(/\.md$/, "");
    if (name) return name;
  }
  // org/ruleset-name -> ruleset-name
  if (uses.includes("/") && !uses.includes("://")) {
    const parts = uses.split("/");
    return parts[parts.length - 1];
  }
  return `rule-${index}`;
}

function readConfigFile(
  filePath: string,
  warnings: string[],
  warnIfMissing: boolean,
): ContinueConfig | null {
  const fs = require("node:fs");

  if (!fileExistsSync(filePath)) {
    if (warnIfMissing) {
      warnings.push(`File not found: ${filePath}`);
    }
    return null;
  }

  let text: string;
  try {
    text = fs.readFileSync(filePath, "utf-8");
  } catch {
    warnings.push(`Cannot read file: ${filePath}`);
    return null;
  }

  try {
    return JSON.parse(text);
  } catch {
    warnings.push(`Malformed JSON: ${filePath}`);
    return null;
  }
}
