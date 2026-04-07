import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { DetectResult } from "../types.ts";

/**
 * Detect whether Codex CLI is installed and discover config paths.
 *
 * @param homeDir - Override home directory (useful for testing)
 * @param projectPath - Optional project directory to check for project-level configs
 */
export function detect(homeDir?: string, projectPath?: string): DetectResult {
  const home = homeDir ?? homedir();
  const paths: Record<string, string> = {};

  // User config: ~/.codex/config.toml
  const userConfig = join(home, ".codex", "config.toml");
  if (existsSync(userConfig)) {
    paths.userConfig = userConfig;
  }

  // Config directory: ~/.codex/
  const configDir = join(home, ".codex");
  if (existsSync(configDir)) {
    paths.configDir = configDir;
  }

  // Global AGENTS.md: ~/.codex/AGENTS.md
  const globalAgentsMd = join(home, ".codex", "AGENTS.md");
  if (existsSync(globalAgentsMd)) {
    paths.globalAgentsMd = globalAgentsMd;
  }

  // Global agents directory: ~/.codex/agents/
  const globalAgentsDir = join(home, ".codex", "agents");
  if (existsSync(globalAgentsDir)) {
    paths.globalAgentsDir = globalAgentsDir;
  }

  const installed = "userConfig" in paths || "configDir" in paths;

  // Try to get version
  let version: string | undefined;
  if (installed) {
    version = getCodexVersion();
  }

  // Project-level paths
  if (projectPath) {
    const projectConfig = join(projectPath, ".codex", "config.toml");
    if (existsSync(projectConfig)) {
      paths.projectConfig = projectConfig;
    }

    const agentsMd = join(projectPath, "AGENTS.md");
    if (existsSync(agentsMd)) {
      paths.agentsMd = agentsMd;
    }

    const projectAgentsDir = join(projectPath, ".codex", "agents");
    if (existsSync(projectAgentsDir)) {
      paths.projectAgentsDir = projectAgentsDir;
    }
  }

  return { installed, version, paths };
}

function getCodexVersion(): string | undefined {
  try {
    const proc = Bun.spawnSync(["codex", "--version"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    if (proc.exitCode === 0) {
      return proc.stdout.toString().trim();
    }
  } catch {
    // codex CLI not in PATH — that's fine, installed detection is file-based
  }
  return undefined;
}
