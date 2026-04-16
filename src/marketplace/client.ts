/**
 * Marketplace client: add, update, remove, and list marketplace repos.
 *
 * Marketplaces are git repos cloned into ~/.config/agent-manager/marketplaces/<name>/.
 * A marketplaces.json index tracks added repos.
 */
import * as fs from "node:fs";
import { join } from "node:path";
import git from "isomorphic-git";
import http from "isomorphic-git/http/node";
import { resolveConfigDir } from "../core/config";
import type { MarketplaceEntry, MarketplaceSource, MarketplacesFile } from "./types";

const MARKETPLACES_DIR = "marketplaces";
const MARKETPLACES_JSON = "marketplaces.json";
const GIT_AUTHOR = { name: "agent-manager", email: "am@localhost" };

/** Resolve the marketplaces root directory. */
export function resolveMarketplacesDir(): string {
  return join(resolveConfigDir(), MARKETPLACES_DIR);
}

/** Resolve the path to marketplaces.json. */
function resolveMarketplacesFile(): string {
  return join(resolveConfigDir(), MARKETPLACES_DIR, MARKETPLACES_JSON);
}

/** Read marketplaces.json, returning empty list if missing. */
export async function readMarketplacesFile(): Promise<MarketplacesFile> {
  const filePath = resolveMarketplacesFile();
  try {
    const raw = await fs.promises.readFile(filePath, "utf-8");
    return JSON.parse(raw) as MarketplacesFile;
  } catch {
    return { marketplaces: [] };
  }
}

/** Write marketplaces.json. */
async function writeMarketplacesFile(data: MarketplacesFile): Promise<void> {
  const filePath = resolveMarketplacesFile();
  await fs.promises.mkdir(join(filePath, ".."), { recursive: true });
  await fs.promises.writeFile(filePath, `${JSON.stringify(data, null, 2)}\n`);
}

/** Detect marketplace source from URL. */
function detectSource(url: string): MarketplaceSource {
  if (url.startsWith("/") || url.startsWith("./") || url.startsWith("..")) return "local";
  if (url.includes("gitlab")) return "gitlab";
  return "github";
}

/** Derive a default name from a git URL. */
export function deriveMarketplaceName(url: string): string {
  // Strip trailing .git and slashes
  const cleaned = url.replace(/\.git\/?$/, "").replace(/\/+$/, "");
  // Take the last path segment
  const segments = cleaned.split("/");
  return segments[segments.length - 1] || "marketplace";
}

/**
 * Add a marketplace by cloning a git repo.
 * Returns the created entry.
 */
export async function addMarketplace(url: string, name?: string): Promise<MarketplaceEntry> {
  const marketplacesDir = resolveMarketplacesDir();
  await fs.promises.mkdir(marketplacesDir, { recursive: true });

  const resolvedName = name ?? deriveMarketplaceName(url);

  // Check for duplicate
  const existing = await readMarketplacesFile();
  if (existing.marketplaces.some((m) => m.name === resolvedName)) {
    throw new MarketplaceError(
      `Marketplace "${resolvedName}" already exists. Use a different --name or remove it first.`,
    );
  }

  const cloneDir = join(marketplacesDir, resolvedName);
  const source = detectSource(url);

  if (source === "local") {
    // For local paths, create a symlink instead of cloning
    const resolvedUrl = url.startsWith("/") ? url : join(process.cwd(), url);
    try {
      await fs.promises.access(resolvedUrl);
    } catch {
      throw new MarketplaceError(`Local path "${resolvedUrl}" does not exist.`);
    }
    await fs.promises.symlink(resolvedUrl, cloneDir, "dir");
  } else {
    // Clone the git repo
    try {
      await git.clone({
        fs,
        http,
        dir: cloneDir,
        url,
        singleBranch: true,
        depth: 1,
      });
    } catch (err) {
      // Clean up partial clone on failure
      try {
        await fs.promises.rm(cloneDir, { recursive: true, force: true });
      } catch {
        // ignore cleanup errors
      }
      throw new MarketplaceError(`Failed to clone "${url}": ${(err as Error).message}`);
    }
  }

  const entry: MarketplaceEntry = {
    name: resolvedName,
    url,
    source,
    added_at: new Date().toISOString(),
  };

  existing.marketplaces.push(entry);
  await writeMarketplacesFile(existing);

  return entry;
}

/**
 * Update a marketplace repo (git pull).
 * If no name given, updates all marketplaces.
 */
export async function updateMarketplace(name?: string): Promise<MarketplaceEntry[]> {
  const data = await readMarketplacesFile();
  const targets = name ? data.marketplaces.filter((m) => m.name === name) : data.marketplaces;

  if (name && targets.length === 0) {
    throw new MarketplaceError(`Marketplace "${name}" not found.`);
  }

  const marketplacesDir = resolveMarketplacesDir();
  const updated: MarketplaceEntry[] = [];

  for (const entry of targets) {
    if (entry.source === "local") {
      // Local symlinks don't need updating
      entry.updated_at = new Date().toISOString();
      updated.push(entry);
      continue;
    }

    const dir = join(marketplacesDir, entry.name);
    try {
      await git.pull({
        fs,
        http,
        dir,
        ref: "main",
        author: GIT_AUTHOR,
      });
      entry.updated_at = new Date().toISOString();
      updated.push(entry);
    } catch (err) {
      // Try default branch fallback
      try {
        await git.pull({
          fs,
          http,
          dir,
          ref: "master",
          author: GIT_AUTHOR,
        });
        entry.updated_at = new Date().toISOString();
        updated.push(entry);
      } catch {
        throw new MarketplaceError(`Failed to update "${entry.name}": ${(err as Error).message}`);
      }
    }
  }

  await writeMarketplacesFile(data);
  return updated;
}

/**
 * Remove a marketplace repo and its entry.
 */
export async function removeMarketplace(name: string): Promise<void> {
  const data = await readMarketplacesFile();
  const idx = data.marketplaces.findIndex((m) => m.name === name);
  if (idx === -1) {
    throw new MarketplaceError(`Marketplace "${name}" not found.`);
  }

  const marketplacesDir = resolveMarketplacesDir();
  const dir = join(marketplacesDir, name);

  // Remove the directory (or symlink)
  try {
    const stat = await fs.promises.lstat(dir);
    if (stat.isSymbolicLink()) {
      await fs.promises.unlink(dir);
    } else {
      await fs.promises.rm(dir, { recursive: true, force: true });
    }
  } catch {
    // Directory may already be gone
  }

  data.marketplaces.splice(idx, 1);
  await writeMarketplacesFile(data);
}

/**
 * List all registered marketplaces.
 */
export async function listMarketplaces(): Promise<MarketplaceEntry[]> {
  const data = await readMarketplacesFile();
  return data.marketplaces;
}

// ── Error class ─────────────────────────────────────────────────

export class MarketplaceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MarketplaceError";
  }
}
