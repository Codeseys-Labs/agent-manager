/**
 * Marketplace client: add, update, remove, and list marketplace repos.
 *
 * @deprecated Marketplace v1 is retired per ADR-0039. This module is frozen for
 * compatibility and scheduled for removal; use the MCP Registry for servers and
 * git-subtree/git-submodule bundles for skills/instructions/agents. See
 * ADRs/0039-marketplace-v1-scope-decision.md.
 *
 * Marketplaces are git repos cloned into ~/.config/agent-manager/marketplaces/<name>/.
 * A marketplaces.json index tracks added repos.
 *
 * Supply-chain controls (see src/marketplace/security.ts):
 *  - URL scheme / credential / port validation
 *  - Clone size + timeout caps
 *  - SHA pinning in marketplaces.json
 *  - Trust-on-first-use prompt
 */
import * as fs from "node:fs";
import { isAbsolute, join } from "node:path";
import git from "isomorphic-git";
import http from "isomorphic-git/http/node";
import { atomicWriteFile } from "../core/atomic-write";
import { resolveConfigDir } from "../core/config";
import {
  DEFAULT_CLONE_TIMEOUT_MS,
  DEFAULT_MAX_CLONE_BYTES,
  MarketplaceSecurityError,
  type MarketplaceSecurityOptions,
  enforceCloneSize,
  isLocalPath,
  promptShaChange,
  promptTrustOnFirstUse,
  resolveHeadSha,
  validateMarketplaceUrl,
  withCloneTimeout,
} from "./security";
import type { MarketplaceEntry, MarketplaceSource, MarketplacesFile } from "./types";

const MARKETPLACES_DIR = "marketplaces";
const MARKETPLACES_JSON = "marketplaces.json";
const GIT_AUTHOR = { name: "agent-manager", email: "am@localhost" };

/**
 * Valid marketplace name: lowercase alphanumerics, dash, underscore. Must start
 * with alnum. 1–64 chars. This mirrors the adapter-name rule
 * (src/commands/adapter.ts) — the subset of POSIX-safe directory names that are
 * also a single path segment.
 *
 * Rejects: path traversal (`..`, `/`, `\`), empty strings, uppercase,
 * whitespace, leading dash/underscore, and anything > 64 chars.
 */
const MARKETPLACE_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/**
 * Validate a marketplace name (user-supplied `--name` or one derived from a
 * URL) before it is used to build a filesystem path. The resolved name is
 * fed to `join(marketplacesDir, name)` which then drives `symlink()`,
 * `git.clone()`, and `rm()` — a traversal value such as `../../etc` would
 * escape the marketplaces directory and let an `rm` delete arbitrary paths.
 *
 * Throws {@link MarketplaceError} (fail closed) so every entry point rejects
 * before any filesystem mutation. Exported so tests and other call sites can
 * reuse the same rule.
 */
export function validateMarketplaceName(name: string): void {
  if (!name || typeof name !== "string") {
    throw new MarketplaceError("Invalid marketplace name: empty or non-string value.");
  }
  // Reject obvious separator/traversal abuse first for an actionable message.
  if (name.includes("..") || name.includes("/") || name.includes("\\")) {
    throw new MarketplaceError(
      `Invalid marketplace name "${name}": must not contain "..", "/", or "\\" (would escape the marketplaces directory).`,
    );
  }
  if (!MARKETPLACE_NAME_RE.test(name)) {
    throw new MarketplaceError(
      `Invalid marketplace name "${name}": must match /^[a-z0-9][a-z0-9_-]{0,63}$/ (lowercase letters/digits, dash, underscore; start with alnum; 1–64 chars). Pass a valid --name.`,
    );
  }
}

/** Extra options accepted by addMarketplace. */
export interface AddMarketplaceOptions extends MarketplaceSecurityOptions {
  /** Skip the TOFU prompt. */
  yes?: boolean;
}

/** Extra options accepted by updateMarketplace. */
export interface UpdateMarketplaceOptions {
  /** Skip SHA-change confirmation. */
  yes?: boolean;
}

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
  await atomicWriteFile(filePath, `${JSON.stringify(data, null, 2)}\n`);
}

/** Detect marketplace source from URL. */
function detectSource(url: string): MarketplaceSource {
  if (isLocalPath(url) || url.startsWith("file:")) return "local";
  if (url.includes("gitlab")) return "gitlab";
  return "github";
}

/** Derive a default name from a git URL or local path. */
export function deriveMarketplaceName(url: string): string {
  // Strip trailing .git and trailing separators (either slash style).
  const cleaned = url.replace(/\.git[/\\]?$/, "").replace(/[/\\]+$/, "");
  // Take the last path segment. Split on BOTH separators so a Windows local
  // path (`C:\repos\my-market`) derives `my-market`, not the whole path.
  const segments = cleaned.split(/[/\\]/);
  return segments[segments.length - 1] || "marketplace";
}

/**
 * Add a marketplace by cloning a git repo.
 *
 * Flow for remote URLs:
 *   1. URL validation (scheme, credentials, port).
 *   2. TOFU prompt (skipped with {yes: true}).
 *   3. Clone with timeout + size cap.
 *   4. Resolve HEAD SHA and persist to marketplaces.json.
 *
 * Local paths remain symlinked and are not subject to SHA pinning.
 */
export async function addMarketplace(
  url: string,
  name?: string,
  opts: AddMarketplaceOptions = {},
): Promise<MarketplaceEntry> {
  const resolvedName = name ?? deriveMarketplaceName(url);

  // Validate BEFORE any filesystem op. resolvedName flows into
  // join(marketplacesDir, …) → symlink()/clone()/rm(); a traversal value such
  // as "../../etc" would escape the marketplaces directory. Validate the
  // resolved name (not just the user-supplied --name) so a crafted URL whose
  // derived basename traverses is rejected too. Fail closed.
  validateMarketplaceName(resolvedName);

  const marketplacesDir = resolveMarketplacesDir();
  await fs.promises.mkdir(marketplacesDir, { recursive: true });

  // Check for duplicate
  const existing = await readMarketplacesFile();
  if (existing.marketplaces.some((m) => m.name === resolvedName)) {
    throw new MarketplaceError(
      `Marketplace "${resolvedName}" already exists. Use a different --name or remove it first.`,
    );
  }

  const cloneDir = join(marketplacesDir, resolvedName);
  const localPath = isLocalPath(url);
  const source: MarketplaceSource = detectSource(url);

  if (localPath) {
    // For local filesystem paths (no scheme), create a symlink instead of cloning.
    // These are not URL-validated (there is no scheme to check) and are not SHA-pinned.
    // isAbsolute() is platform-native: it recognizes C:\… / UNC on Windows and
    // /… on POSIX, so a Windows absolute path is not re-rooted under cwd.
    const resolvedUrl = isAbsolute(url) ? url : join(process.cwd(), url);
    try {
      await fs.promises.access(resolvedUrl);
    } catch {
      throw new MarketplaceError(`Local path "${resolvedUrl}" does not exist.`);
    }
    await fs.promises.symlink(resolvedUrl, cloneDir, "dir");

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

  // Remote URL: run full security pipeline.
  try {
    validateMarketplaceUrl(url, opts);
  } catch (err) {
    if (err instanceof MarketplaceSecurityError) {
      throw new MarketplaceError(err.message);
    }
    throw err;
  }

  // TOFU prompt BEFORE clone. We cannot show the SHA until after clone,
  // but the prompt clarifies pinning will happen.
  const trusted = await promptTrustOnFirstUse(url, null, { yes: opts.yes });
  if (!trusted) {
    throw new MarketplaceError(
      `Marketplace "${url}" was not trusted. Re-run with --yes to auto-accept or confirm interactively.`,
    );
  }

  const maxBytes = opts.maxCloneBytes ?? DEFAULT_MAX_CLONE_BYTES;
  const timeoutMs = opts.cloneTimeoutMs ?? DEFAULT_CLONE_TIMEOUT_MS;

  try {
    await withCloneTimeout(
      git.clone({
        fs,
        http,
        dir: cloneDir,
        url,
        singleBranch: true,
        depth: 1,
      }),
      timeoutMs,
    );
    await enforceCloneSize(cloneDir, maxBytes);
  } catch (err) {
    // Clean up partial clone on failure
    try {
      await fs.promises.rm(cloneDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
    if (err instanceof MarketplaceSecurityError) {
      throw new MarketplaceError(err.message);
    }
    throw new MarketplaceError(`Failed to clone "${url}": ${(err as Error).message}`);
  }

  const commit = await resolveHeadSha(cloneDir);

  const entry: MarketplaceEntry = {
    name: resolvedName,
    url,
    source,
    added_at: new Date().toISOString(),
    ...(commit ? { commit, pinned: true } : {}),
  };

  existing.marketplaces.push(entry);
  await writeMarketplacesFile(existing);

  return entry;
}

/**
 * Update a marketplace repo (git pull).
 * If no name given, updates all marketplaces.
 *
 * Pinned marketplaces require {yes: true} or interactive confirmation before
 * accepting a new SHA; otherwise the update is rejected and the pin remains.
 */
export async function updateMarketplace(
  name?: string,
  opts: UpdateMarketplaceOptions = {},
): Promise<MarketplaceEntry[]> {
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
    const oldSha = entry.commit ?? (await resolveHeadSha(dir));

    try {
      await git.pull({
        fs,
        http,
        dir,
        ref: "main",
        author: GIT_AUTHOR,
      });
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
      } catch {
        throw new MarketplaceError(`Failed to update "${entry.name}": ${(err as Error).message}`);
      }
    }

    const newSha = await resolveHeadSha(dir);
    if (entry.pinned && oldSha && newSha && oldSha !== newSha) {
      const accepted = await promptShaChange(entry.name, entry.url, oldSha, newSha, {
        yes: opts.yes,
      });
      if (!accepted) {
        // Reset the working tree back to the pinned SHA and refuse the update.
        try {
          await git.checkout({ fs, dir, ref: oldSha, force: true });
        } catch {
          // ignore — worst case, the user has to reset manually
        }
        throw new MarketplaceError(
          `Refusing to accept new SHA for "${entry.name}" (pinned=${oldSha.slice(0, 12)}, ` +
            `remote=${newSha.slice(0, 12)}). Pass --yes to confirm or run \`am marketplace remove\` first.`,
        );
      }
      entry.commit = newSha;
    } else if (newSha) {
      // Record SHA on first successful update even if previously unpinned.
      entry.commit = newSha;
      if (entry.pinned === undefined) entry.pinned = true;
    }
    entry.updated_at = new Date().toISOString();
    updated.push(entry);
  }

  await writeMarketplacesFile(data);
  return updated;
}

/**
 * Remove a marketplace repo and its entry.
 */
export async function removeMarketplace(name: string): Promise<void> {
  // Validate BEFORE join()/rm(): a traversal name (whether passed directly or
  // forged into marketplaces.json) would otherwise let rm delete an arbitrary
  // path outside the marketplaces directory. Fail closed.
  validateMarketplaceName(name);

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

/**
 * Look up a marketplace entry by name. Returns null if not registered.
 */
export async function findMarketplaceEntry(name: string): Promise<MarketplaceEntry | null> {
  const data = await readMarketplacesFile();
  return data.marketplaces.find((m) => m.name === name) ?? null;
}

/**
 * Verify a marketplace's working-tree HEAD matches its pinned commit.
 * No-op for local and unpinned entries. Throws on mismatch.
 */
export async function verifyMarketplacePin(entry: MarketplaceEntry): Promise<void> {
  if (entry.source === "local") return;
  if (!entry.pinned || !entry.commit) return;

  const dir = join(resolveMarketplacesDir(), entry.name);
  const currentSha = await resolveHeadSha(dir);
  if (!currentSha) {
    throw new MarketplaceError(
      `Marketplace "${entry.name}" is pinned to ${entry.commit.slice(0, 12)} but its working tree has no resolvable HEAD. Re-add the marketplace.`,
    );
  }
  if (currentSha !== entry.commit) {
    throw new MarketplaceError(
      `Marketplace "${entry.name}" HEAD (${currentSha.slice(0, 12)}) does not match pinned SHA (${entry.commit.slice(0, 12)}). Run \`am marketplace update ${entry.name}\` to review and accept the change.`,
    );
  }
}

// ── Error class ─────────────────────────────────────────────────

export class MarketplaceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MarketplaceError";
  }
}
