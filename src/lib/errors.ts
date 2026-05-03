/**
 * Shared error handling utilities for agent-manager CLI.
 */

/** Extract message from unknown catch value */
export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/** Check if error is a Node.js file-not-found error */
export function isNotFound(err: unknown): boolean {
  return err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT";
}

/** Extract errno code from unknown catch value, if present */
export function errorCode(err: unknown): string | undefined {
  if (err instanceof Error && "code" in err) return (err as NodeJS.ErrnoException).code;
  return undefined;
}

export class AmError extends Error {
  constructor(
    message: string,
    public suggestion?: string,
    public code?: string,
  ) {
    super(message);
    this.name = "AmError";
  }
}

/**
 * Thrown by `pullFastForwardOnly` when the remote has diverged from the
 * local branch. `conflictedFiles` lists every path `git.statusMatrix`
 * reports as non-clean at the moment the pull was attempted — `am wiki
 * resolve` uses this list to present the per-file pick prompt (ADR-0020
 * M5.3).
 */
export class WikiSyncConflictError extends AmError {
  constructor(
    public readonly conflictedFiles: string[],
    message = "Wiki sync refused: remote and local have diverged",
  ) {
    super(
      message,
      "Run `am wiki resolve` to pick local/remote per file, or pull manually",
      "WIKI_SYNC_CONFLICT",
    );
    this.name = "WikiSyncConflictError";
  }
}

/**
 * Thrown by the auto-commit pipeline (M5.2) when tier-1 or tier-2 secret
 * detection flags staged content. Carries the offending file list so the
 * CLI can print per-file hits and so tests can assert on `hits[*].file`.
 */
export class WikiSyncSecretBlockedError extends AmError {
  constructor(
    public readonly hits: Array<{ file: string; reason: string }>,
    message = "Wiki auto-commit blocked: potential secret detected",
  ) {
    super(
      message,
      "Remove the secret or pass `--allow-dirty` after clearing, then retry",
      "WIKI_SYNC_SECRET_BLOCKED",
    );
    this.name = "WikiSyncSecretBlockedError";
  }
}

/**
 * Format an error for CLI output, respecting --json flag.
 */
export function formatError(err: unknown, json: boolean): string {
  if (err instanceof AmError) {
    if (json) {
      return JSON.stringify({
        error: err.message,
        ...(err.suggestion ? { suggestion: err.suggestion } : {}),
        ...(err.code ? { code: err.code } : {}),
      });
    }
    let msg = `error: ${err.message}`;
    if (err.suggestion) msg += `\n  suggestion: ${err.suggestion}`;
    return msg;
  }
  if (err instanceof Error) {
    if (json) return JSON.stringify({ error: err.message });
    return `error: ${err.message}`;
  }
  return json ? JSON.stringify({ error: String(err) }) : `error: ${err}`;
}

/**
 * Require that config.toml exists. Throws AmError if not found.
 */
export function requireConfig<T>(
  config: T | null | undefined,
  action = "this command",
): asserts config is T {
  if (config == null) {
    throw new AmError(
      "Config not found",
      "Run `am init` to initialize agent-manager",
      "CONFIG_NOT_FOUND",
    );
  }
}
