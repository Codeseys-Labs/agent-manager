/**
 * Kilo Code adapter: import native configs into core format.
 *
 * Reads kilo.jsonc (global + project), .kilocode/rules/ (instructions),
 * AGENTS.md, .kilocode/skills/, and agent definitions.
 *
 * Handles both new CLI-native MCP format (`mcp` key) and legacy
 * Cline/Roo-compatible format (`mcpServers` key).
 */

import { homedir } from "node:os";
import { join } from "node:path";
import type {
  ImportOptions,
  ImportResult,
  ImportedInstruction,
  ImportedServer,
  ImportedSkill,
} from "../types.ts";
import { findKiloExtensionStoragePath } from "./detect.ts";
import { extractPackageId } from "./identity.ts";
import { parseJsonc } from "./jsonc.ts";

// ── New CLI-native MCP format ───────────────────────────────────

interface KiloMcpEntry {
  type?: "local" | "remote";
  command?: string[];
  url?: string;
  environment?: Record<string, string>;
  headers?: Record<string, string>;
  enabled?: boolean;
  timeout?: number;
  oauth?: boolean;
  [key: string]: unknown;
}

// ── Legacy Cline/Roo-compatible MCP format ──────────────────────

interface LegacyMcpEntry {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  alwaysAllow?: string[];
  disabled?: boolean;
  timeout?: number;
  [key: string]: unknown;
}

// ── Kilo config shape ───────────────────────────────────────────

interface KiloConfig {
  mcp?: Record<string, KiloMcpEntry>;
  mcpServers?: Record<string, LegacyMcpEntry>;
  instructions?: string[];
  agent?: Record<string, KiloAgentEntry>;
  [key: string]: unknown;
}

interface KiloAgentEntry {
  description?: string;
  mode?: string;
  model?: string;
  prompt?: string;
  permission?: Record<string, string>;
  [key: string]: unknown;
}

/**
 * Import Kilo Code native configs into core format.
 */
export function importConfig(options: ImportOptions = {}, homeDir?: string): ImportResult {
  const home = homeDir ?? homedir();
  const entities = options.entities ?? ["servers", "instructions", "skills"];
  const warnings: string[] = [];
  const servers: ImportedServer[] = [];
  const instructions: ImportedInstruction[] = [];
  const skills: ImportedSkill[] = [];

  // Load global config
  const globalConfig = loadGlobalConfig(home, warnings);
  // Load project config
  const projectConfig = options.projectPath
    ? loadProjectConfig(options.projectPath, warnings)
    : null;

  if (entities.includes("servers")) {
    // CLI surface: global servers
    if (globalConfig) {
      servers.push(...extractServers(globalConfig, "global"));
    }

    // CLI surface: project servers
    if (projectConfig) {
      servers.push(...extractServers(projectConfig, "project"));
    }

    // VS Code extension surface: merge with CLI. Extension wins on name
    // collisions (its UI is usually the user's most recent edit).
    const extServers = loadExtensionServers(home, warnings);
    if (extServers.length > 0) {
      const cliNames = new Set(servers.map((s) => s.name));
      const overrides: string[] = [];
      for (const extServer of extServers) {
        if (cliNames.has(extServer.name)) overrides.push(extServer.name);
        // Remove any CLI entry with the same name so the extension wins.
        for (let i = servers.length - 1; i >= 0; i--) {
          if (servers[i].name === extServer.name) servers.splice(i, 1);
        }
        servers.push(extServer);
      }
      if (overrides.length > 0) {
        warnings.push(
          `Kilo VS Code extension overrode CLI-defined servers: ${overrides.join(", ")}`,
        );
      }
    }
  }

  if (entities.includes("instructions")) {
    // Global AGENTS.md
    const globalAgentsMd = join(home, ".config", "kilo", "AGENTS.md");
    const globalInstr = readMarkdownInstruction(
      globalAgentsMd,
      "kilo-global-agents-md",
      "Global instructions from ~/.config/kilo/AGENTS.md",
    );
    if (globalInstr) instructions.push(globalInstr);

    // Global custom rules: ~/.kilocode/rules/
    const globalRulesDir = join(home, ".kilocode", "rules");
    instructions.push(...readRulesDir(globalRulesDir, "global", warnings));

    // Config-level instructions (paths/globs/URLs)
    if (globalConfig?.instructions) {
      for (const path of globalConfig.instructions) {
        instructions.push({
          name: `kilo-instruction-${basename(path)}`,
          content: path,
          scope: "always",
          description: `Kilo config instruction reference: ${path}`,
        });
      }
    }

    if (options.projectPath) {
      // Project AGENTS.md (and fallbacks)
      for (const name of ["AGENTS.md", "AGENT.md", "CLAUDE.md", "CONTEXT.md"]) {
        const p = join(options.projectPath, name);
        const instr = readMarkdownInstruction(
          p,
          `kilo-${name.toLowerCase().replace(".", "-")}`,
          `Project instructions from ${name}`,
        );
        if (instr) {
          instructions.push(instr);
          break;
        }
      }

      // Project custom rules: .kilocode/rules/
      const projectRulesDir = join(options.projectPath, ".kilocode", "rules");
      instructions.push(...readRulesDir(projectRulesDir, "project", warnings));

      // Project config instructions
      if (projectConfig?.instructions) {
        for (const path of projectConfig.instructions) {
          instructions.push({
            name: `kilo-proj-instruction-${basename(path)}`,
            content: path,
            scope: "always",
            description: `Kilo project config instruction reference: ${path}`,
          });
        }
      }
    }
  }

  if (entities.includes("skills") && options.projectPath) {
    // Project skills: .kilocode/skills/
    const projectSkillsDir = join(options.projectPath, ".kilocode", "skills");
    skills.push(...readSkillsDir(projectSkillsDir, warnings));

    // Global skills: ~/.kilocode/skills/
    const globalSkillsDir = join(home, ".kilocode", "skills");
    skills.push(...readSkillsDir(globalSkillsDir, warnings));
  }

  return { servers, instructions, skills, warnings };
}

// ── Config loading ──────────────────────────────────────────────

const GLOBAL_CONFIG_NAMES = [
  "kilo.jsonc",
  "kilo.json",
  "config.json",
  "opencode.jsonc",
  "opencode.json",
];

function loadGlobalConfig(home: string, warnings: string[]): KiloConfig | null {
  const configDir = join(home, ".config", "kilo");
  for (const name of GLOBAL_CONFIG_NAMES) {
    const configPath = join(configDir, name);
    const config = readJsoncFile(configPath, warnings);
    if (config) return config as KiloConfig;
  }
  warnings.push(`No Kilo global config found in ${configDir}`);
  return null;
}

/**
 * Load MCP servers from the Kilo VS Code extension's globalStorage.
 *
 * File lives at:
 *   <globalStorage>/settings/mcp_settings.json
 *
 * Schema mirrors Cline/Roo (Kilo is a Cline fork): a `mcpServers` object map.
 */
function loadExtensionServers(home: string, warnings: string[]): ImportedServer[] {
  const ext = findKiloExtensionStoragePath(home);
  if (!ext) return [];
  const file = join(ext, "settings", "mcp_settings.json");
  const fs = require("node:fs");
  try {
    fs.accessSync(file);
  } catch {
    return [];
  }
  let text: string;
  try {
    text = fs.readFileSync(file, "utf-8");
  } catch {
    warnings.push(`Cannot read file: ${file}`);
    return [];
  }
  let parsed: { mcpServers?: Record<string, LegacyMcpEntry> };
  try {
    parsed = JSON.parse(text);
  } catch {
    if (text.trim() !== "") warnings.push(`Malformed JSON: ${file}`);
    return [];
  }
  const entries = parsed?.mcpServers;
  if (!entries || typeof entries !== "object") return [];

  const servers: ImportedServer[] = [];
  for (const [name, entry] of Object.entries(entries)) {
    if (!entry || typeof entry !== "object" || !entry.command) continue;

    const adapterExtras: Record<string, unknown> = { source: "vscode-extension" };
    for (const [key, value] of Object.entries(entry)) {
      if (!LEGACY_CORE_FIELDS.has(key)) adapterExtras[key] = value;
    }
    if (entry.alwaysAllow) adapterExtras.alwaysAllow = entry.alwaysAllow;

    servers.push({
      name,
      command: entry.command,
      scope: "global",
      ...(entry.args && { args: entry.args }),
      ...(entry.env && { env: entry.env }),
      enabled: entry.disabled !== true,
      packageId: extractPackageId(entry.command, entry.args),
      adapterExtras,
    });
  }
  return servers;
}

function loadProjectConfig(projectPath: string, warnings: string[]): KiloConfig | null {
  // .kilo/kilo.jsonc takes priority over kilo.jsonc
  const dotKiloConfig = join(projectPath, ".kilo", "kilo.jsonc");
  const dotKiloResult = readJsoncFile(dotKiloConfig, []);
  if (dotKiloResult) return dotKiloResult as KiloConfig;

  const rootConfig = join(projectPath, "kilo.jsonc");
  const rootResult = readJsoncFile(rootConfig, []);
  if (rootResult) return rootResult as KiloConfig;

  // Not a warning — many projects won't have kilo config
  return null;
}

function readJsoncFile(filePath: string, warnings: string[]): unknown | null {
  const fs = require("node:fs");
  try {
    fs.accessSync(filePath);
  } catch {
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
    return parseJsonc(text);
  } catch {
    if (text.trim() !== "") warnings.push(`Malformed JSONC: ${filePath}`);
    return null;
  }
}

// ── Server extraction (dual format) ────────────────────────────

const NEW_FORMAT_CORE_FIELDS = new Set([
  "type",
  "command",
  "url",
  "environment",
  "headers",
  "enabled",
  "timeout",
  "oauth",
]);

const LEGACY_CORE_FIELDS = new Set([
  "command",
  "args",
  "env",
  "disabled",
  "alwaysAllow",
  "timeout",
]);

function extractServers(config: KiloConfig, scope: "global" | "project"): ImportedServer[] {
  const servers: ImportedServer[] = [];

  // New format: `mcp` key
  if (config.mcp && typeof config.mcp === "object") {
    for (const [name, entry] of Object.entries(config.mcp)) {
      if (!entry || typeof entry !== "object") continue;

      const adapterExtras: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(entry)) {
        if (!NEW_FORMAT_CORE_FIELDS.has(key)) {
          adapterExtras[key] = value;
        }
      }

      if (entry.type === "remote" && entry.url) {
        // Remote server (HTTP/SSE)
        servers.push({
          name,
          command: entry.url,
          scope,
          transport: "streamable-http",
          url: entry.url,
          enabled: entry.enabled !== false,
          ...(entry.environment && { env: entry.environment }),
          ...(Object.keys(adapterExtras).length > 0 && { adapterExtras }),
        });
      } else if (entry.command && Array.isArray(entry.command)) {
        // Local server (stdio) — command is an array
        const [cmd, ...args] = entry.command;
        servers.push({
          name,
          command: cmd,
          scope,
          ...(args.length > 0 && { args }),
          ...(entry.environment && { env: entry.environment }),
          enabled: entry.enabled !== false,
          packageId: extractPackageId(entry.command),
          ...(Object.keys(adapterExtras).length > 0 && { adapterExtras }),
        });
      }
    }
  }

  // Legacy format: `mcpServers` key
  if (config.mcpServers && typeof config.mcpServers === "object") {
    for (const [name, entry] of Object.entries(config.mcpServers)) {
      if (!entry || typeof entry !== "object" || !entry.command) continue;

      const adapterExtras: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(entry)) {
        if (!LEGACY_CORE_FIELDS.has(key)) {
          adapterExtras[key] = value;
        }
      }

      // Carry alwaysAllow into extras
      if (entry.alwaysAllow) {
        adapterExtras.alwaysAllow = entry.alwaysAllow;
      }

      servers.push({
        name,
        command: entry.command,
        scope,
        ...(entry.args && { args: entry.args }),
        ...(entry.env && { env: entry.env }),
        enabled: entry.disabled !== true,
        packageId: extractPackageId(entry.command, entry.args),
        ...(Object.keys(adapterExtras).length > 0 && { adapterExtras }),
      });
    }
  }

  return servers;
}

// ── Instructions / Rules ────────────────────────────────────────

function readMarkdownInstruction(
  filePath: string,
  name: string,
  description: string,
): ImportedInstruction | null {
  const fs = require("node:fs");
  try {
    fs.accessSync(filePath);
    const content = fs.readFileSync(filePath, "utf-8");
    return { name, content, scope: "always", description, sourcePath: filePath };
  } catch {
    return null;
  }
}

function readRulesDir(
  dirPath: string,
  scope: "global" | "project",
  warnings: string[],
): ImportedInstruction[] {
  const fs = require("node:fs");
  const results: ImportedInstruction[] = [];

  try {
    fs.accessSync(dirPath);
  } catch {
    return results;
  }

  let entries: string[];
  try {
    entries = fs.readdirSync(dirPath);
  } catch {
    warnings.push(`Cannot read rules directory: ${dirPath}`);
    return results;
  }

  for (const entry of entries) {
    if (!entry.endsWith(".md")) continue;
    const filePath = join(dirPath, entry);
    try {
      const content = fs.readFileSync(filePath, "utf-8");
      const name = `kilo-rule-${scope}-${entry.replace(".md", "")}`;
      results.push({
        name,
        content,
        scope: "always",
        description: `Kilo ${scope} rule: ${entry}`,
        sourcePath: filePath,
      });
    } catch {
      warnings.push(`Cannot read rule file: ${filePath}`);
    }
  }

  return results;
}

// ── Skills ──────────────────────────────────────────────────────

function readSkillsDir(dirPath: string, warnings: string[]): ImportedSkill[] {
  const fs = require("node:fs");
  const results: ImportedSkill[] = [];

  try {
    fs.accessSync(dirPath);
  } catch {
    return results;
  }

  let entries: string[];
  try {
    entries = fs.readdirSync(dirPath);
  } catch {
    warnings.push(`Cannot read skills directory: ${dirPath}`);
    return results;
  }

  for (const entry of entries) {
    const skillMd = join(dirPath, entry, "SKILL.md");
    try {
      fs.accessSync(skillMd);
      // Read frontmatter for description
      const content = fs.readFileSync(skillMd, "utf-8");
      const description = extractSkillDescription(content);
      results.push({
        name: entry,
        path: join(dirPath, entry),
        description,
      });
    } catch {
      // Not a valid skill directory — skip
    }
  }

  return results;
}

function extractSkillDescription(content: string): string | undefined {
  const match = content.match(/^---\s*\n([\s\S]*?)\n---/);
  if (!match) return undefined;
  const frontmatter = match[1];
  const descLine = frontmatter.split("\n").find((l) => l.startsWith("description:"));
  if (!descLine) return undefined;
  return descLine
    .replace("description:", "")
    .trim()
    .replace(/^["']|["']$/g, "");
}

function basename(path: string): string {
  const lastSlash = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return lastSlash === -1 ? path : path.slice(lastSlash + 1);
}
