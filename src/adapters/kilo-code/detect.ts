import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { DetectResult } from "../types.ts";
import { findFirstExistingVSCodeExtensionStorage } from "../vscode/paths.ts";

/**
 * Kilo marketplace extension ID casings (mixed case as registered, plus a
 * lowercase fallback for case-sensitive filesystems where VS Code may have
 * downcased on install).
 */
export const KILO_EXTENSION_IDS = ["kilocode.Kilo-Code", "kilocode.kilo-code"] as const;

/**
 * Return the VS Code extension globalStorage path for Kilo, if one exists.
 *
 * Checks every VS Code variant (stable, Insiders, VSCodium, Cursor, Windsurf)
 * and every extension-ID casing. Returns the first hit.
 */
export function findKiloExtensionStoragePath(homeDir?: string): string | undefined {
  const home = homeDir ?? homedir();
  return findFirstExistingVSCodeExtensionStorage([...KILO_EXTENSION_IDS], home);
}

/**
 * Detect whether Kilo Code is installed and discover config paths.
 *
 * Kilo ships as BOTH:
 *   - A CLI (`@kilocode/cli`) writing to `~/.config/kilo/kilo.jsonc`
 *   - A VS Code extension (`kilocode.Kilo-Code`) writing MCP settings to
 *     `<globalStorage>/settings/mcp_settings.json`
 *
 * We treat Kilo as installed if either surface is present.
 */
export function detect(homeDir?: string, projectPath?: string): DetectResult {
  const home = homeDir ?? homedir();
  const paths: Record<string, string> = {};

  // ── CLI surface ───────────────────────────────────────────────
  const globalConfigDir = join(home, ".config", "kilo");
  if (existsSync(globalConfigDir)) {
    paths.globalConfigDir = globalConfigDir;
  }

  const globalConfigNames = [
    "kilo.jsonc",
    "kilo.json",
    "config.json",
    "opencode.jsonc",
    "opencode.json",
  ];
  for (const name of globalConfigNames) {
    const configPath = join(globalConfigDir, name);
    if (existsSync(configPath)) {
      paths.globalConfig = configPath;
      break;
    }
  }

  const globalAgentsMd = join(globalConfigDir, "AGENTS.md");
  if (existsSync(globalAgentsMd)) paths.globalAgentsMd = globalAgentsMd;

  const globalRulesDir = join(home, ".kilocode", "rules");
  if (existsSync(globalRulesDir)) paths.globalRulesDir = globalRulesDir;

  const globalSkillsDir = join(home, ".kilocode", "skills");
  if (existsSync(globalSkillsDir)) paths.globalSkillsDir = globalSkillsDir;

  const globalAgentsDir = join(globalConfigDir, "agents");
  if (existsSync(globalAgentsDir)) paths.globalAgentsDir = globalAgentsDir;

  // ── VS Code extension surface ────────────────────────────────
  const extStorage = findKiloExtensionStoragePath(home);
  if (extStorage) {
    paths.extensionStorageDir = extStorage;
    const extMcp = join(extStorage, "settings", "mcp_settings.json");
    if (existsSync(extMcp)) paths.extensionMcpSettings = extMcp;
  }

  const installed =
    "globalConfigDir" in paths || "globalConfig" in paths || "extensionStorageDir" in paths;

  let version: string | undefined;
  if (installed) version = getKiloVersion();

  // ── Project-level paths ──────────────────────────────────────
  if (projectPath) {
    const dotKiloConfig = join(projectPath, ".kilo", "kilo.jsonc");
    if (existsSync(dotKiloConfig)) {
      paths.projectConfig = dotKiloConfig;
    } else {
      const rootConfig = join(projectPath, "kilo.jsonc");
      if (existsSync(rootConfig)) paths.projectConfig = rootConfig;
    }

    const kilocodeDir = join(projectPath, ".kilocode");
    if (existsSync(kilocodeDir)) paths.kilocodeDir = kilocodeDir;

    for (const name of ["AGENTS.md", "AGENT.md", "CLAUDE.md", "CONTEXT.md"]) {
      const p = join(projectPath, name);
      if (existsSync(p)) {
        paths.agentsMd = p;
        break;
      }
    }

    const projectRulesDir = join(projectPath, ".kilocode", "rules");
    if (existsSync(projectRulesDir)) paths.projectRulesDir = projectRulesDir;

    const projectSkillsDir = join(projectPath, ".kilocode", "skills");
    if (existsSync(projectSkillsDir)) paths.projectSkillsDir = projectSkillsDir;

    const projectAgentsDir = join(projectPath, ".kilo", "agents");
    if (existsSync(projectAgentsDir)) paths.projectAgentsDir = projectAgentsDir;
  }

  return { installed, version, paths };
}

function getKiloVersion(): string | undefined {
  try {
    const proc = Bun.spawnSync(["kilo", "--version"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    if (proc.exitCode === 0) {
      return proc.stdout.toString().trim();
    }
  } catch {
    // kilo CLI not in PATH
  }
  return undefined;
}
