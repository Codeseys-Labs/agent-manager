import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { DetectResult } from "../types.ts";

/**
 * Detect whether ForgeCode is installed and discover config paths.
 *
 * Checks for ~/forge/ (global config dir), .forge/ (project config dir),
 * and .forge.toml (project settings).
 *
 * @param homeDir - Override home directory (useful for testing)
 * @param projectPath - Optional project directory to check for project-level configs
 */
export function detect(homeDir?: string, projectPath?: string): DetectResult {
  const home = homeDir ?? homedir();
  const paths: Record<string, string> = {};

  // Global config directory: ~/forge/
  const globalConfigDir = join(home, "forge");
  if (existsSync(globalConfigDir)) {
    paths.globalConfigDir = globalConfigDir;
  }

  // Global settings: ~/.forge.toml
  const globalSettings = join(home, ".forge.toml");
  if (existsSync(globalSettings)) {
    paths.globalSettings = globalSettings;
  }

  const installed = "globalConfigDir" in paths || "globalSettings" in paths;

  // Try to get version
  let version: string | undefined;
  if (installed) {
    version = getForgeVersion();
  }

  // Project-level paths
  if (projectPath) {
    const forgeDir = join(projectPath, ".forge");
    if (existsSync(forgeDir)) {
      paths.projectConfigDir = forgeDir;
    }

    const mcpJson = join(projectPath, ".mcp.json");
    if (existsSync(mcpJson)) {
      paths.projectMcpConfig = mcpJson;
    }

    const agentsMd = join(projectPath, "AGENTS.md");
    if (existsSync(agentsMd)) {
      paths.agentsMd = agentsMd;
    }

    const forgeToml = join(projectPath, ".forge.toml");
    if (existsSync(forgeToml)) {
      paths.projectSettings = forgeToml;
    }
  }

  return { installed, version, paths };
}

function getForgeVersion(): string | undefined {
  try {
    const proc = Bun.spawnSync(["forge", "--version"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    if (proc.exitCode === 0) {
      return proc.stdout.toString().trim();
    }
  } catch {
    // forge CLI not in PATH — that's fine, installed detection is file-based
  }
  return undefined;
}
