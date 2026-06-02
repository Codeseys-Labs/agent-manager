/**
 * Continue adapter: export resolved config to native format.
 *
 * Default output: `~/.continue/config.yaml` in the modern Continue schema
 * (`schema: v1`, `mcpServers` array with `name`/`command`/`args`/`env`).
 *
 * Legacy compat: if only `config.json` exists (and no YAML), we continue to
 * write JSON (to avoid surprising users whose Continue install is on the
 * deprecated schema) and attach a deprecation warning.
 *
 * Rules: `.continue/rules/<name>.md` (project or global, matching legacy
 * behavior), and a `rules:` array of `uses: file://...` references embedded
 * in config.yaml / config.json.
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { generateWikiContext } from "../../core/instructions.ts";
import { sanitizePathSegment } from "../../lib/safe-path.ts";
import { writeExportFiles } from "../shared/export-utils.ts";
import type { ExportOptions, ExportResult, ResolvedConfig, WrittenFile } from "../types.ts";
import { parseYaml, stringifyYaml } from "./yaml.ts";

/**
 * Relative `uses: file://` reference for the managed apply-time wiki rule
 * (ADR-0054 R7). When wiki injection fires, this is appended to the `rules:`
 * array so Continue actually loads the `.continue/rules/am-wiki.md` body.
 */
const WIKI_RULE_REF = "file://.continue/rules/am-wiki.md";

const DEPRECATION_WARNING =
  "Continue has deprecated config.json; writing YAML alongside it. Migrate to config.yaml (see https://docs.continue.dev).";

/**
 * Export resolved config to Continue native files.
 */
export async function exportConfig(
  config: ResolvedConfig,
  options: ExportOptions = {},
  homeDir?: string,
): Promise<ExportResult> {
  const home = homeDir ?? homedir();
  const files: WrittenFile[] = [];
  const warnings: string[] = [];

  const configDir = join(home, ".continue");
  const yamlPath = join(configDir, "config.yaml");
  const jsonPath = join(configDir, "config.json");

  const yamlExists = existsSync(yamlPath);
  const jsonExistsOnly = !yamlExists && existsSync(jsonPath);

  // Rule .md files (per-instruction). Continue has no single canonical
  // instruction file — rules live in `.continue/rules/` and are referenced from
  // the config's `rules:` array. Build these first so we know whether the target
  // has any instruction surface to augment with apply-time wiki knowledge.
  const ruleFiles = generateRuleFiles(config, home, options.projectPath);

  // Inject apply-time wiki context (ADR-0054 R7). The wiki block lands in a
  // dedicated managed rule file `.continue/rules/am-wiki.md` and its reference
  // is appended to the `rules:` array so Continue actually loads it. It augments
  // an existing instruction surface, so we only emit it when this target has
  // rules — mirroring the reference adapters that splice wiki only alongside an
  // instruction file.
  let wikiRuleRef: string | undefined;
  if (ruleFiles.length > 0) {
    const wikiBlock = await generateWikiContext(options.projectPath ?? home, config.settings);
    if (wikiBlock) {
      wikiRuleRef = WIKI_RULE_REF;
      const basePath = options.projectPath ?? home;
      const wikiPath = join(basePath, ".continue", "rules", "am-wiki.md");
      ruleFiles.push({ path: wikiPath, content: `${wikiBlock}\n`, written: false });
    }
  }

  if (jsonExistsOnly) {
    // Legacy-only install. Preserve behavior by writing JSON back.
    warnings.push(DEPRECATION_WARNING);
    const content = generateJsonConfig(config, jsonPath, wikiRuleRef);
    files.push({ path: jsonPath, content, written: false });
  } else {
    // Modern install OR brand-new install: write YAML.
    const content = generateYamlConfig(config, yamlPath, wikiRuleRef);
    files.push({ path: yamlPath, content, written: false });
  }

  files.push(...ruleFiles);

  writeExportFiles(files, warnings, { dryRun: options.dryRun });

  return { files, warnings };
}

// ── YAML emission ───────────────────────────────────────────────

function generateYamlConfig(
  config: ResolvedConfig,
  existingPath: string,
  wikiRuleRef?: string,
): string {
  const existing = readExistingYaml(existingPath);

  const mcpServers = buildServerArray(config);
  const rules = buildRulesArray(config, wikiRuleRef);

  // Preserve existing top-level fields (name, version, schema, models, ...)
  // overriding only the managed keys.
  const output: Record<string, unknown> = {
    // Ensure required Continue envelope is present.
    name: (existing?.name as string) ?? "agent-manager",
    version: (existing?.version as string) ?? "0.0.1",
    schema: (existing?.schema as string) ?? "v1",
    ...existing,
    mcpServers,
  };
  if (rules.length > 0) output.rules = rules;
  else if (existing && "rules" in existing) {
    // Preserve existing rules if we have nothing to contribute.
    output.rules = (existing as Record<string, unknown>).rules;
  }

  return stringifyYaml(output);
}

function generateJsonConfig(
  config: ResolvedConfig,
  existingPath: string,
  wikiRuleRef?: string,
): string {
  const fs = require("node:fs");
  let existing: Record<string, unknown> = {};
  try {
    const text = fs.readFileSync(existingPath, "utf-8");
    existing = JSON.parse(text);
  } catch {
    /* no existing */
  }
  const mcpServers = buildServerArray(config);
  const rules = buildRulesArray(config, wikiRuleRef);

  const output: Record<string, unknown> = { ...existing, mcpServers };
  if (rules.length > 0) output.rules = rules;

  return `${JSON.stringify(output, null, 2)}\n`;
}

function readExistingYaml(path: string): Record<string, unknown> | null {
  const fs = require("node:fs");
  try {
    const text = fs.readFileSync(path, "utf-8");
    const parsed = parseYaml(text);
    if (parsed && typeof parsed === "object") return parsed as Record<string, unknown>;
  } catch {
    /* not present or malformed — start fresh */
  }
  return null;
}

// ── Shared server/rule building ─────────────────────────────────

function buildServerArray(config: ResolvedConfig): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const [name, server] of Object.entries(config.servers)) {
    if (!server.enabled) continue;

    const entry: Record<string, unknown> = {
      name,
      command: server.command,
    };
    if (server.args.length > 0) entry.args = server.args;
    if (Object.keys(server.env).length > 0) entry.env = server.env;

    const ctExtras = server.adapters?.continue ?? {};
    for (const [key, value] of Object.entries(ctExtras)) {
      entry[key] = value;
    }

    out.push(entry);
  }
  return out;
}

function buildRulesArray(config: ResolvedConfig, wikiRuleRef?: string): Record<string, unknown>[] {
  const rules: Record<string, unknown>[] = [];
  for (const [name, instr] of Object.entries(config.instructions)) {
    if (instr.targets.length > 0 && !instr.targets.includes("continue")) continue;
    if (isExternalRef(instr.content)) {
      rules.push({ uses: instr.content });
    } else {
      rules.push({ uses: `file://.continue/rules/${name}.md` });
    }
  }
  // ADR-0054 R7: register the managed apply-time wiki rule so Continue loads it.
  if (wikiRuleRef) {
    rules.push({ uses: wikiRuleRef });
  }
  return rules;
}

function isExternalRef(content: string): boolean {
  return (
    content.startsWith("file://") ||
    (content.includes("/") && !content.includes(" ") && !content.includes("\n"))
  );
}

// ── Rule .md emission ───────────────────────────────────────────

function generateRuleFiles(
  config: ResolvedConfig,
  home: string,
  projectPath?: string,
): WrittenFile[] {
  const files: WrittenFile[] = [];
  for (const [name, instr] of Object.entries(config.instructions)) {
    if (instr.targets.length > 0 && !instr.targets.includes("continue")) continue;
    if (isExternalRef(instr.content)) continue;

    const content = `${instr.content}\n`;
    const basePath = projectPath ?? home;
    const filePath = join(basePath, ".continue", "rules", `${sanitizePathSegment(name)}.md`);
    files.push({ path: filePath, content, written: false });
  }
  return files;
}
