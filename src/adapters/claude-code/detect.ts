import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { DetectResult } from "../types.ts";

/**
 * Detect whether Claude Code is installed and discover config paths.
 *
 * @param homeDir - Override home directory (useful for testing)
 * @param projectPath - Optional project directory to check for project-level configs
 */
export function detect(homeDir?: string, projectPath?: string): DetectResult {
  const home = homeDir ?? homedir();
  const paths: Record<string, string> = {};

  // Global config: ~/.claude.json
  const globalConfig = join(home, ".claude.json");
  if (existsSync(globalConfig)) {
    paths.globalConfig = globalConfig;
  }

  // Config directory: ~/.claude/
  const configDir = join(home, ".claude");
  if (existsSync(configDir)) {
    paths.configDir = configDir;
  }

  const installed = "globalConfig" in paths || "configDir" in paths;

  // Try to get version
  let version: string | undefined;
  if (installed) {
    version = getClaudeVersion();
  }

  // Project-level paths
  if (projectPath) {
    const mcpJson = join(projectPath, ".mcp.json");
    if (existsSync(mcpJson)) {
      paths.projectMcpConfig = mcpJson;
    }

    const claudeMd = join(projectPath, "CLAUDE.md");
    if (existsSync(claudeMd)) {
      paths.claudeMd = claudeMd;
    }

    const claudeMdDotDir = join(projectPath, ".claude", "CLAUDE.md");
    if (existsSync(claudeMdDotDir)) {
      paths.claudeMdDotDir = claudeMdDotDir;
    }
  }

  return { installed, version, paths };
}

function getClaudeVersion(): string | undefined {
  try {
    const proc = Bun.spawnSync(["claude", "--version"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    if (proc.exitCode === 0) {
      return proc.stdout.toString().trim();
    }
  } catch {
    // claude CLI not in PATH — that's fine, installed detection is file-based
  }
  return undefined;
}
