/**
 * Marketplace supply-chain security helpers.
 *
 * This module centralises:
 *  - URL validation for marketplace add/update (scheme, credential, port).
 *  - Path-traversal checks for plugin manifest path-valued fields.
 *  - Clone size enforcement and timeout wrapping.
 *  - Trust-on-first-use (TOFU) prompting for newly-added marketplace URLs.
 *  - SHA pinning helpers that resolve the current HEAD of a clone.
 */
import * as fs from "node:fs";
import { resolve as resolvePath, sep } from "node:path";
import * as clack from "@clack/prompts";
import git from "isomorphic-git";

/** Default clone size cap in bytes (100 MiB). */
export const DEFAULT_MAX_CLONE_BYTES = 100 * 1024 * 1024;

/** Default clone timeout in milliseconds. */
export const DEFAULT_CLONE_TIMEOUT_MS = 60_000;

/** Options shared across marketplace security controls. */
export interface MarketplaceSecurityOptions {
  /** Allow file:// URLs (used by local-testing harnesses). Defaults to false. */
  allowFile?: boolean;
  /** Allow http:// URLs. Defaults to false. */
  allowHttp?: boolean;
  /** Allow non-standard ports (anything other than 443 for https / 80 for http). Defaults to false. */
  allowNonstandardPort?: boolean;
  /** Skip the TOFU prompt — used by --yes. Defaults to false. */
  yes?: boolean;
  /** Override the max clone size (bytes). */
  maxCloneBytes?: number;
  /** Override the clone timeout (ms). */
  cloneTimeoutMs?: number;
}

/** Errors raised by the security layer. Kept separate so callers can distinguish. */
export class MarketplaceSecurityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MarketplaceSecurityError";
  }
}

// ── URL validation ───────────────────────────────────────────────

/**
 * Detect whether a candidate string looks like a git URL that should go
 * through URL validation, as opposed to a local filesystem path.
 */
export function isLocalPath(url: string): boolean {
  if (!url) return false;
  if (url.startsWith("/")) return true;
  if (url.startsWith("./")) return true;
  if (url.startsWith("../")) return true;
  if (url === ".." || url === ".") return true;
  return false;
}

const STANDARD_PORTS: Record<string, string> = {
  "https:": "443",
  "http:": "80",
};

/**
 * Validate a marketplace URL against the supply-chain rules:
 *   - Only https:// (and optionally file:// or http:// via flags).
 *   - No embedded credentials (user:pass@host).
 *   - Standard port only (unless allowNonstandardPort).
 *
 * Throws MarketplaceSecurityError on violation. Returns the parsed URL.
 */
export function validateMarketplaceUrl(url: string, opts: MarketplaceSecurityOptions = {}): URL {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new MarketplaceSecurityError(
      `Invalid marketplace URL "${url}". Expected https:// URL or local path.`,
    );
  }

  // Scheme
  const scheme = parsed.protocol;
  const allowed = new Set<string>(["https:"]);
  if (opts.allowFile) allowed.add("file:");
  if (opts.allowHttp) allowed.add("http:");
  if (!allowed.has(scheme)) {
    const allowedList = Array.from(allowed).join(", ");
    throw new MarketplaceSecurityError(
      `Refusing to add marketplace URL "${url}": scheme "${scheme}" is not allowed. ` +
        `Allowed schemes: ${allowedList}. Use --allow-http or --allow-file to relax.`,
    );
  }

  // Credentials
  if (parsed.username || parsed.password) {
    throw new MarketplaceSecurityError(
      `Refusing to add marketplace URL "${url}": embedded credentials ("user:pass@host") are not allowed. Remove credentials from the URL and use a credential helper instead.`,
    );
  }

  // Port — file:// has no meaningful port
  if (scheme !== "file:") {
    const port = parsed.port;
    if (port) {
      const standard = STANDARD_PORTS[scheme];
      if (port !== standard && !opts.allowNonstandardPort) {
        throw new MarketplaceSecurityError(
          `Refusing to add marketplace URL "${url}": non-standard port ${port} ` +
            `for ${scheme}. Pass --allow-nonstandard-port to override.`,
        );
      }
    }
  }

  return parsed;
}

// ── Path traversal scrubbing ─────────────────────────────────────

/**
 * Resolve a user-supplied relative-or-absolute path *inside* the plugin's
 * clone directory and refuse any resolution that escapes.
 *
 *  - Relative paths are resolved against `pluginDir`.
 *  - Absolute paths are only allowed if they already fall inside `pluginDir`.
 *  - Trailing-separator normalisation guards against the classic
 *    `/base` vs `/base-evil` startsWith bypass.
 *
 * Throws MarketplaceSecurityError on escape.
 */
export function safeResolveInsidePlugin(
  pluginDir: string,
  candidate: string,
  fieldLabel: string,
): string {
  if (!candidate || typeof candidate !== "string") {
    throw new MarketplaceSecurityError(
      `Plugin manifest field ${fieldLabel} must be a non-empty string.`,
    );
  }
  // Reject NUL byte explicitly
  if (candidate.includes("\0")) {
    throw new MarketplaceSecurityError(`Plugin manifest field ${fieldLabel} contains a NUL byte.`);
  }

  const resolvedBase = resolvePath(pluginDir);
  const resolved = resolvePath(resolvedBase, candidate);

  const basePrefix = resolvedBase.endsWith(sep) ? resolvedBase : resolvedBase + sep;
  if (resolved !== resolvedBase && !resolved.startsWith(basePrefix)) {
    throw new MarketplaceSecurityError(
      `Plugin manifest field ${fieldLabel} resolves outside the plugin ` +
        `directory (${candidate} -> ${resolved}). Refusing to install.`,
    );
  }
  return resolved;
}

// ── Clone size / timeout ─────────────────────────────────────────

/**
 * Recursively measure the on-disk size of a directory.
 * Follows neither symlinks nor hardlink duplication — we only care about
 * the committed working-tree size.
 */
export async function measureDirectorySize(dir: string): Promise<number> {
  let total = 0;
  async function walk(p: string): Promise<void> {
    const entries = await fs.promises.readdir(p, { withFileTypes: true });
    for (const ent of entries) {
      const child = `${p}/${ent.name}`;
      if (ent.isSymbolicLink()) continue;
      if (ent.isDirectory()) {
        await walk(child);
      } else if (ent.isFile()) {
        try {
          const st = await fs.promises.stat(child);
          total += st.size;
        } catch {
          // ignore transient errors
        }
      }
    }
  }
  await walk(dir);
  return total;
}

/**
 * Enforce a maximum clone size; throws MarketplaceSecurityError if exceeded.
 */
export async function enforceCloneSize(dir: string, maxBytes: number): Promise<void> {
  const size = await measureDirectorySize(dir);
  if (size > maxBytes) {
    throw new MarketplaceSecurityError(
      `Clone exceeds maximum size: ${size} bytes > ${maxBytes} bytes. Pass a larger cap explicitly if you trust this repo.`,
    );
  }
}

/**
 * Wrap a promise with a timeout. On timeout, rejects with MarketplaceSecurityError.
 */
export function withCloneTimeout<T>(p: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(
        new MarketplaceSecurityError(
          `Clone timed out after ${timeoutMs}ms. Pass a larger --clone-timeout to override.`,
        ),
      );
    }, timeoutMs);
  });
  return Promise.race([p, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

// ── SHA resolution ───────────────────────────────────────────────

/**
 * Resolve the current HEAD commit SHA of a cloned marketplace.
 * Returns null for directories that are not git repos (e.g. local symlinks).
 */
export async function resolveHeadSha(dir: string): Promise<string | null> {
  try {
    return await git.resolveRef({ fs, dir, ref: "HEAD" });
  } catch {
    return null;
  }
}

// ── TOFU prompt ──────────────────────────────────────────────────

/**
 * Interactive-or-auto-confirm for trust-on-first-use of a marketplace URL.
 *
 * Behaviour:
 *   - opts.yes = true → silent accept (returns true).
 *   - TTY available → interactive prompt with initialValue=false.
 *   - Non-TTY without --yes → refuse (returns false).
 */
export async function promptTrustOnFirstUse(
  url: string,
  sha: string | null,
  opts: { yes?: boolean; force?: boolean } = {},
): Promise<boolean> {
  if (opts.yes) return true;
  if (opts.force) return true;

  const tty = process.stdin.isTTY && process.stdout.isTTY;
  if (!tty) {
    return false;
  }
  const shaTail = sha ? ` Once confirmed, commit SHA ${sha.slice(0, 12)} will be pinned.` : "";
  const answer = await clack.confirm({
    message: `Trust marketplace ${url}?${shaTail}`,
    initialValue: false,
  });
  if (clack.isCancel(answer)) return false;
  return answer === true;
}

/**
 * Confirm that a SHA change on `marketplace update` is acceptable.
 */
export async function promptShaChange(
  name: string,
  url: string,
  oldSha: string,
  newSha: string,
  opts: { yes?: boolean } = {},
): Promise<boolean> {
  if (opts.yes) return true;
  const tty = process.stdin.isTTY && process.stdout.isTTY;
  if (!tty) {
    return false;
  }
  const answer = await clack.confirm({
    message: `Marketplace "${name}" (${url}) changed commits:\n  pinned:  ${oldSha.slice(0, 12)}\n  remote:  ${newSha.slice(0, 12)}\nAccept the new SHA and re-pin?`,
    initialValue: false,
  });
  if (clack.isCancel(answer)) return false;
  return answer === true;
}
