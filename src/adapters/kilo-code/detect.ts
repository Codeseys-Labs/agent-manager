import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { DetectResult } from "../types.ts";

/**
 * Detect whether Kilo Code is installed and discover config paths.
 *
 * Detection strategy (ordered by specificity):
 *   1. .kilo/kilo.jsonc in project root (new, highest priority)
 *   2. kilo.jsonc in project root (new)
 *   3. .kilocode/ directory in project root (legacy)
 *   4. ~/.config/kilo/ directory (global config)
 *   5. `kilo` CLI in PATH
 */
export function detect(homeDir?: string, projectPath?: string): DetectResult {
  const home = homeDir ?? homedir();
  const paths: Record<string, string> = {};

  // Global config directory: ~/.config/kilo/
  const globalConfigDir = join(home, ".config", "kilo");
  if (existsSync(globalConfigDir)) {
    paths.globalConfigDir = globalConfigDir;
  }

  // Global config files (check multiple names in priority order)
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

  // Global AGENTS.md
  const globalAgentsMd = join(globalConfigDir, "AGENTS.md");
  if (existsSync(globalAgentsMd)) {
    paths.globalAgentsMd = globalAgentsMd;
  }

  // Global rules: ~/.kilocode/rules/
  const globalRulesDir = join(home, ".kilocode", "rules");
  if (existsSync(globalRulesDir)) {
    paths.globalRulesDir = globalRulesDir;
  }

  // Global skills: ~/.kilocode/skills/
  const globalSkillsDir = join(home, ".kilocode", "skills");
  if (existsSync(globalSkillsDir)) {
    paths.globalSkillsDir = globalSkillsDir;
  }

  // Global agent markdown files: ~/.config/kilo/agents/
  const globalAgentsDir = join(globalConfigDir, "agents");
  if (existsSync(globalAgentsDir)) {
    paths.globalAgentsDir = globalAgentsDir;
  }

  const installed =
    "globalConfigDir" in paths || "globalConfig" in paths;

  // Try to get version from CLI
  let version: string | undefined;
  if (installed) {
    version = getKiloVersion();
  }

  // Project-level paths
  if (projectPath) {
    // .kilo/kilo.jsonc takes priority
    const dotKiloConfig = join(projectPath, ".kilo", "kilo.jsonc");
    if (existsSync(dotKiloConfig)) {
      paths.projectConfig = dotKiloConfig;
    } else {
      const rootConfig = join(projectPath, "kilo.jsonc");
      if (existsSync(rootConfig)) {
        paths.projectConfig = rootConfig;
      }
    }

    // Legacy .kilocode/ directory
    const kilocodeDir = join(projectPath, ".kilocode");
    if (existsSync(kilocodeDir)) {
      paths.kilocodeDir = kilocodeDir;
    }

    // AGENTS.md (and fallbacks)
    for (const name of ["AGENTS.md", "AGENT.md", "CLAUDE.md", "CONTEXT.md"]) {
      const p = join(projectPath, name);
      if (existsSync(p)) {
        paths.agentsMd = p;
        break;
      }
    }

    // Project rules: .kilocode/rules/
    const projectRulesDir = join(projectPath, ".kilocode", "rules");
    if (existsSync(projectRulesDir)) {
      paths.projectRulesDir = projectRulesDir;
    }

    // Project skills: .kilocode/skills/
    const projectSkillsDir = join(projectPath, ".kilocode", "skills");
    if (existsSync(projectSkillsDir)) {
      paths.projectSkillsDir = projectSkillsDir;
    }

    // Project agent markdown files: .kilo/agents/
    const projectAgentsDir = join(projectPath, ".kilo", "agents");
    if (existsSync(projectAgentsDir)) {
      paths.projectAgentsDir = projectAgentsDir;
    }
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
