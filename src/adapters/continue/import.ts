/**
 * Continue adapter: import native configs into core format.
 *
 * Storage evolution:
 *   - Modern (current): `~/.continue/config.yaml` with a `mcpServers` array,
 *     plus `~/.continue/mcpServers/<name>.yaml` per-server block files.
 *   - Legacy (deprecated): `~/.continue/config.json` with a `mcpServers` array.
 *
 * This importer reads BOTH and emits a deprecation warning when only the
 * legacy JSON is present. Each server becomes an `ImportedServer` with scope
 * `global` (user-level) or `project` (.continue/ inside a project dir).
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { fileExistsSync } from "../shared/utils.ts";
import type { ImportOptions, ImportResult, ImportedInstruction, ImportedServer } from "../types.ts";
import { listYamlFiles } from "./detect.ts";
import { extractPackageId } from "./identity.ts";
import { parseYaml } from "./yaml.ts";

interface ContinueServer {
  name: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  url?: string;
  type?: string;
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

const DEPRECATION_WARNING =
  "Continue has deprecated config.json, migrate to config.yaml (see https://docs.continue.dev).";

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
    // Global sources, preferring YAML over legacy JSON.
    const globalDir = join(home, ".continue");
    const globalYaml = join(globalDir, "config.yaml");
    const globalJson = join(globalDir, "config.json");
    const globalMcpDir = join(globalDir, "mcpServers");

    const hasYaml = fileExistsSync(globalYaml);
    const hasJson = fileExistsSync(globalJson);

    if (hasYaml) {
      const config = readYamlConfig(globalYaml, warnings);
      if (config) {
        servers.push(...extractServers(config, "global"));
      }
    }
    // Per-server YAML block files add to whatever came from the main config.
    servers.push(...readMcpServersDir(globalMcpDir, "global", warnings));

    if (hasJson) {
      if (hasYaml) {
        warnings.push(
          `Found both config.yaml and config.json in ${globalDir}. Using config.yaml; ${DEPRECATION_WARNING}`,
        );
      } else {
        warnings.push(DEPRECATION_WARNING);
      }
      const config = readJsonConfig(globalJson, warnings);
      if (config) servers.push(...extractServers(config, "global"));
    }

    // If nothing at all was readable, surface that as a warning (matches
    // legacy behavior: `File not found: ~/.continue/config.json`).
    if (!hasYaml && !hasJson) {
      warnings.push(`File not found: ${globalJson}`);
    }

    // Project scope
    if (options.projectPath) {
      const projDir = join(options.projectPath, ".continue");
      const projYaml = join(projDir, "config.yaml");
      const projJson = join(projDir, "config.json");
      const projMcpDir = join(projDir, "mcpServers");

      const pHasYaml = fileExistsSync(projYaml);
      const pHasJson = fileExistsSync(projJson);

      if (pHasYaml) {
        const config = readYamlConfig(projYaml, warnings);
        if (config) servers.push(...extractServers(config, "project"));
      }
      servers.push(...readMcpServersDir(projMcpDir, "project", warnings));
      if (pHasJson) {
        if (pHasYaml) {
          warnings.push(
            `Found both config.yaml and config.json in ${projDir}. Using config.yaml; ${DEPRECATION_WARNING}`,
          );
        } else {
          warnings.push(DEPRECATION_WARNING);
        }
        const config = readJsonConfig(projJson, warnings);
        if (config) servers.push(...extractServers(config, "project"));
      }
    }
  }

  if (entities.includes("instructions")) {
    // Rules live in either config.yaml, config.json (legacy), or .md files
    // under .continue/rules/. We prefer YAML.
    const globalDir = join(home, ".continue");
    const globalYaml = join(globalDir, "config.yaml");
    const globalJson = join(globalDir, "config.json");

    const yamlCfg = fileExistsSync(globalYaml) ? readYamlConfig(globalYaml, warnings) : null;
    if (yamlCfg) instructions.push(...extractRules(yamlCfg));

    const jsonCfg = fileExistsSync(globalJson) ? readJsonConfig(globalJson, warnings) : null;
    if (jsonCfg) instructions.push(...extractRules(jsonCfg));

    if (options.projectPath) {
      const projDir = join(options.projectPath, ".continue");
      const pYaml = join(projDir, "config.yaml");
      const pJson = join(projDir, "config.json");

      const pYamlCfg = fileExistsSync(pYaml) ? readYamlConfig(pYaml, warnings) : null;
      if (pYamlCfg) instructions.push(...extractRules(pYamlCfg));

      const pJsonCfg = fileExistsSync(pJson) ? readJsonConfig(pJson, warnings) : null;
      if (pJsonCfg) instructions.push(...extractRules(pJsonCfg));
    }
  }

  return { servers, instructions, skills: [], warnings };
}

const CORE_FIELDS = new Set(["name", "command", "args", "env", "url", "type"]);

function extractServers(config: ContinueConfig, scope: "global" | "project"): ImportedServer[] {
  const mcpServers = config.mcpServers;
  if (!Array.isArray(mcpServers)) return [];

  const results: ImportedServer[] = [];
  for (const entry of mcpServers) {
    if (!entry || typeof entry !== "object" || !entry.name) continue;
    // Support both stdio (command) and remote (url) entries. At least one must
    // be present.
    if (!entry.command && !entry.url) continue;

    const adapterExtras: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(entry)) {
      if (!CORE_FIELDS.has(key)) adapterExtras[key] = value;
    }

    const isRemote = Boolean(entry.url);
    const server: ImportedServer = {
      name: entry.name,
      command: entry.command ?? entry.url ?? "",
      scope,
      ...(entry.args && entry.args.length > 0 && { args: entry.args }),
      ...(entry.env && Object.keys(entry.env).length > 0 && { env: entry.env }),
      ...(isRemote && { transport: "streamable-http" as const }),
      enabled: true,
      ...(entry.command && { packageId: extractPackageId(entry.command, entry.args) }),
      ...(Object.keys(adapterExtras).length > 0 && { adapterExtras }),
    };

    results.push(server);
  }
  return results;
}

function extractRules(config: ContinueConfig): ImportedInstruction[] {
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

/** Derive a name from a `uses` reference or fall back to index. */
function deriveRuleName(uses: string, index: number): string {
  if (uses.startsWith("file://")) {
    const path = uses.slice(7);
    const base = path.split("/").pop() ?? "";
    const name = base.replace(/\.md$/, "");
    if (name) return name;
  }
  if (uses.includes("/") && !uses.includes("://")) {
    const parts = uses.split("/");
    return parts[parts.length - 1];
  }
  return `rule-${index}`;
}

function readYamlConfig(filePath: string, warnings: string[]): ContinueConfig | null {
  const fs = require("node:fs");
  let text: string;
  try {
    text = fs.readFileSync(filePath, "utf-8");
  } catch {
    warnings.push(`Cannot read file: ${filePath}`);
    return null;
  }
  try {
    const parsed = parseYaml(text);
    if (!parsed || typeof parsed !== "object") return null;
    return parsed as ContinueConfig;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    warnings.push(`Malformed YAML: ${filePath} — ${msg}`);
    return null;
  }
}

function readJsonConfig(filePath: string, warnings: string[]): ContinueConfig | null {
  const fs = require("node:fs");
  let text: string;
  try {
    text = fs.readFileSync(filePath, "utf-8");
  } catch {
    warnings.push(`Cannot read file: ${filePath}`);
    return null;
  }
  try {
    return JSON.parse(text) as ContinueConfig;
  } catch {
    warnings.push(`Malformed JSON: ${filePath}`);
    return null;
  }
}

/** Read each YAML file in `.continue/mcpServers/` and collect servers. */
function readMcpServersDir(
  dirPath: string,
  scope: "global" | "project",
  warnings: string[],
): ImportedServer[] {
  const results: ImportedServer[] = [];
  const files = listYamlFiles(dirPath);
  for (const file of files) {
    const fullPath = join(dirPath, file);
    const cfg = readYamlConfig(fullPath, warnings);
    if (!cfg) continue;
    results.push(...extractServers(cfg, scope));
  }
  return results;
}
