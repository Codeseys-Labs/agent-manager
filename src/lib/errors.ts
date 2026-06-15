/**
 * Shared error handling utilities for agent-manager CLI.
 */
import { ZodError, type ZodIssue } from "zod";

/** Extract message from unknown catch value */
export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/**
 * Like `errorMessage`, but for `AmError` it also folds the `suggestion` into
 * the returned string (`<message>: <suggestion>`).
 *
 * Config parse/schema failures (`parseConfigBytes`) carry the offending field
 * path — which may echo a secret-shaped value the user typed (e.g. a token
 * used as a server name) — in the `AmError.suggestion`, NOT the `.message`.
 * Callers that only render `.message` (doctor's config.toml check) would drop
 * that detail entirely, which both hides the diagnostic AND, paradoxically,
 * removes the secret-shaped token before it can be redacted. Folding the
 * suggestion back in keeps the diagnostic visible; the call site still passes
 * the result through a redactor so any echoed secret becomes `[REDACTED_*]`.
 */
export function errorDetail(err: unknown): string {
  if (err instanceof AmError && err.suggestion) {
    return `${err.message}: ${err.suggestion}`;
  }
  return errorMessage(err);
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
 * Render a single ZodError issue as a `path: message` line.
 *
 * The dotted path mirrors the TOML the user wrote — e.g. an issue at
 * `["servers", "foo", "command"]` becomes `servers.foo.command`. Numeric
 * path segments (array indices) render as `[n]` so `args[0]` reads
 * naturally. A top-level issue (empty path) renders just the message.
 */
function formatZodIssue(issue: ZodIssue): string {
  const path = issue.path.reduce<string>((acc, seg) => {
    if (typeof seg === "number") return `${acc}[${seg}]`;
    return acc ? `${acc}.${seg}` : seg;
  }, "");
  return path ? `${path}: ${issue.message}` : issue.message;
}

/**
 * Convert a ZodError into human-readable lines like
 * `servers.foo.command: Required` — one per issue. Exported so callers that
 * want the lines without the surrounding `error:`/`suggestion:` framing
 * (e.g. structured renderers) can reuse the same mapping.
 */
export function formatZodError(err: ZodError): string[] {
  return err.issues.map(formatZodIssue);
}

/**
 * Format an error for CLI output, respecting --json flag.
 */
export function formatError(err: unknown, json: boolean): string {
  if (err instanceof ZodError) {
    // Validation failures surface as a raw issue-array dump unless we
    // translate them. Render each issue as `path: message` so a first-run
    // user editing config.toml sees `servers.foo.command: Required` rather
    // than a JSON blob (P1-A).
    const lines = formatZodError(err);
    const suggestion = "Check your config.toml against the documented schema";
    if (json) {
      return JSON.stringify({
        error: "Invalid configuration",
        issues: lines,
        suggestion,
      });
    }
    const body = lines.map((l) => `  ${l}`).join("\n");
    return `error: invalid configuration\n${body}\n  suggestion: ${suggestion}`;
  }
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
