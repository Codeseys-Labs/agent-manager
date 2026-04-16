/**
 * Shared VS Code extension marketplace scanner.
 * Works for VS Code (Copilot), Cursor, Kiro, and Windsurf — same extension
 * format, different install paths.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import type {
  ImportedServer,
  MarketplaceItem,
  MarketplaceResult,
  MarketplaceSource,
} from "../types.ts";

interface ExtensionPackageJson {
  name?: string;
  displayName?: string;
  version?: string;
  publisher?: string;
  repository?: { url?: string } | string;
  contributes?: {
    mcpServers?: Record<string, { command: string; args?: string[]; env?: Record<string, string> }>;
  };
}

/** Extension directory locations per tool, per platform. */
const EXTENSION_DIRS: Record<string, { darwin: string; linux: string }> = {
  copilot: {
    darwin: "Library/Application Support/Code/User/extensions",
    linux: ".vscode/extensions",
  },
  cursor: {
    darwin: "Library/Application Support/Cursor/User/extensions",
    linux: ".cursor/extensions",
  },
  kiro: {
    darwin: "Library/Application Support/Kiro/User/extensions",
    linux: ".kiro/extensions",
  },
  windsurf: {
    darwin: "Library/Application Support/Windsurf/User/extensions",
    linux: ".windsurf/extensions",
  },
};

/** Map adapter names to MarketplaceSource values. */
const SOURCE_MAP: Record<string, MarketplaceSource> = {
  copilot: "vscode-extension",
  cursor: "cursor-extension",
  kiro: "kiro-extension",
  windsurf: "windsurf-extension",
};

/**
 * Resolve `${extensionPath}` variables in extension configs.
 */
export function resolveExtensionVars(value: string, extPath: string): string {
  return value.replace(/\$\{extensionPath\}/g, extPath);
}

/**
 * Get the extensions directory for a given adapter on the current platform.
 */
export function getExtensionsDir(adapterName: string, homeDir?: string): string | undefined {
  const home = homeDir ?? homedir();
  const paths = EXTENSION_DIRS[adapterName];
  if (!paths) return undefined;

  const plat = process.platform === "darwin" ? "darwin" : "linux";
  return join(home, paths[plat]);
}

/**
 * Scan VS Code-family extension directories for extensions that register MCP servers.
 */
export function scanVSCodeExtensions(adapterName: string, homeDir?: string): MarketplaceResult {
  const items: MarketplaceItem[] = [];
  const warnings: string[] = [];
  const source = SOURCE_MAP[adapterName];
  if (!source) {
    warnings.push(`No marketplace source mapping for adapter: ${adapterName}`);
    return { items, warnings };
  }

  const extensionsDir = getExtensionsDir(adapterName, homeDir);
  if (!extensionsDir) {
    warnings.push(`No extensions directory mapping for adapter: ${adapterName}`);
    return { items, warnings };
  }

  const fs = require("node:fs");

  // Check if extensions directory exists
  let dirEntries: string[];
  try {
    dirEntries = fs.readdirSync(extensionsDir);
  } catch {
    // Directory doesn't exist — not an error, tool may not have extensions
    return { items, warnings };
  }

  for (const dir of dirEntries) {
    const extPath = join(extensionsDir, dir);

    let stat: { isDirectory(): boolean };
    try {
      stat = fs.statSync(extPath);
    } catch {
      continue;
    }
    if (!stat.isDirectory()) continue;

    const pkgPath = join(extPath, "package.json");
    let pkg: ExtensionPackageJson;
    try {
      const text = fs.readFileSync(pkgPath, "utf-8");
      pkg = JSON.parse(text);
    } catch {
      continue;
    }

    // Check for contributes.mcpServers
    const mcpServers = pkg.contributes?.mcpServers;
    if (!mcpServers || typeof mcpServers !== "object") continue;

    const servers: ImportedServer[] = [];
    for (const [name, config] of Object.entries(mcpServers)) {
      if (!config || !config.command) continue;
      servers.push({
        name,
        command: resolveExtensionVars(config.command, extPath),
        args: (config.args ?? []).map((a) => resolveExtensionVars(a, extPath)),
        env: config.env,
        scope: "global",
        tags: [`extension:${pkg.publisher}.${pkg.name}`],
      });
    }

    if (servers.length > 0) {
      const repoUrl = typeof pkg.repository === "string" ? pkg.repository : pkg.repository?.url;

      items.push({
        id: `${pkg.publisher}.${pkg.name}`,
        name: pkg.displayName ?? pkg.name ?? dir,
        version: pkg.version ?? "unknown",
        source,
        servers,
        skills: [],
        metadata: {
          publisher: pkg.publisher,
          repository: repoUrl,
          installPath: extPath,
          manifestPath: pkgPath,
        },
      });
    }
  }

  return { items, warnings };
}
