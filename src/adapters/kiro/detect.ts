import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { DetectResult } from "../types.ts";

/**
 * Detect whether Kiro is installed and discover config paths.
 *
 * @param homeDir - Override home directory (useful for testing)
 * @param projectPath - Optional project directory to check for project-level configs
 */
export function detect(homeDir?: string, projectPath?: string): DetectResult {
  const home = homeDir ?? homedir();
  const paths: Record<string, string> = {};

  // Global config directory: ~/.kiro/
  const globalConfigDir = join(home, ".kiro");
  if (existsSync(globalConfigDir)) {
    paths.globalConfigDir = globalConfigDir;
  }

  // Global MCP config: ~/.kiro/settings/mcp.json
  const globalMcpConfig = join(home, ".kiro", "settings", "mcp.json");
  if (existsSync(globalMcpConfig)) {
    paths.globalMcpConfig = globalMcpConfig;
  }

  // Global steering: ~/.kiro/steering/
  const globalSteeringDir = join(home, ".kiro", "steering");
  if (existsSync(globalSteeringDir)) {
    paths.globalSteeringDir = globalSteeringDir;
  }

  // Global agents: ~/.kiro/agents/
  const globalAgentsDir = join(home, ".kiro", "agents");
  if (existsSync(globalAgentsDir)) {
    paths.globalAgentsDir = globalAgentsDir;
  }

  // Global skills: ~/.kiro/skills/
  const globalSkillsDir = join(home, ".kiro", "skills");
  if (existsSync(globalSkillsDir)) {
    paths.globalSkillsDir = globalSkillsDir;
  }

  const installed = "globalConfigDir" in paths || "globalMcpConfig" in paths;

  // Try to get version
  let version: string | undefined;
  if (installed) {
    version = getKiroVersion();
  }

  // Project-level paths
  if (projectPath) {
    const projectDir = join(projectPath, ".kiro");
    if (existsSync(projectDir)) {
      paths.projectDir = projectDir;
    }

    const projectMcpConfig = join(projectPath, ".kiro", "settings", "mcp.json");
    if (existsSync(projectMcpConfig)) {
      paths.projectMcpConfig = projectMcpConfig;
    }

    const projectSteeringDir = join(projectPath, ".kiro", "steering");
    if (existsSync(projectSteeringDir)) {
      paths.projectSteeringDir = projectSteeringDir;
    }

    const projectAgentsDir = join(projectPath, ".kiro", "agents");
    if (existsSync(projectAgentsDir)) {
      paths.projectAgentsDir = projectAgentsDir;
    }

    const projectSkillsDir = join(projectPath, ".kiro", "skills");
    if (existsSync(projectSkillsDir)) {
      paths.projectSkillsDir = projectSkillsDir;
    }
  }

  return { installed, version, paths };
}

function getKiroVersion(): string | undefined {
  try {
    const proc = Bun.spawnSync(["kiro", "--version"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    if (proc.exitCode === 0) {
      return proc.stdout.toString().trim();
    }
  } catch {
    // kiro CLI not in PATH — that's fine, installed detection is file-based
  }
  return undefined;
}
