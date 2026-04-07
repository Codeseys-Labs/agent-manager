/**
 * Shared error handling utilities for agent-manager CLI.
 */

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
export function requireConfig<T>(config: T | null | undefined, action = "this command"): asserts config is T {
  if (config == null) {
    throw new AmError(
      "Config not found",
      "Run `am init` to initialize agent-manager",
      "CONFIG_NOT_FOUND",
    );
  }
}
