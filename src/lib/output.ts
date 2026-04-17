import { AmError, formatError } from "./errors";

export interface OutputOptions {
  json?: boolean;
  verbose?: boolean;
  quiet?: boolean;
}

export function output(data: unknown, opts: OutputOptions): void {
  if (opts.json) console.log(JSON.stringify(data, null, 2));
}

export function info(message: string, opts: OutputOptions): void {
  if (!opts.json && !opts.quiet) console.log(message);
}

export function error(message: string, opts: OutputOptions): void {
  if (opts.json) console.error(JSON.stringify({ error: message }));
  else console.error(`error: ${message}`);
}

/**
 * Emit a warning.
 *
 * Warnings are important signals and are intentionally NOT silenced by
 * `--quiet` — scripting callers need to see them. Always written to stderr
 * (so they never pollute the stdout JSON payload / pipeline).
 *
 * In JSON mode the warning is emitted as a single JSON object on stderr
 * (`{level: "warn", message}`), which machine callers can merge into their
 * own warnings list. The per-command final JSON payload on stdout is
 * unaffected — commands that want to aggregate warnings into the final
 * envelope should do so explicitly (see collectWarnings()).
 */
export function warn(message: string, opts: OutputOptions): void {
  if (opts.json) {
    console.error(JSON.stringify({ level: "warn", message }));
  } else {
    console.error(`warning: ${message}`);
  }
}

/**
 * Print a structured error with optional suggestion, respecting --json.
 */
export function amError(err: unknown, opts: OutputOptions): void {
  const formatted = formatError(err, !!opts.json);
  console.error(formatted);
}

export function debug(message: string, opts: OutputOptions): void {
  if (opts.verbose && !opts.json) console.log(`  [debug] ${message}`);
}

export function parsePositiveInt(
  value: string | undefined,
  flagName: string,
  defaultValue?: number,
): number {
  if (value === undefined) {
    if (defaultValue !== undefined) return defaultValue;
    throw new Error(`Invalid value for --${flagName}: expected a positive integer, got "${value}"`);
  }
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed) || parsed <= 0) {
    throw new Error(`Invalid value for --${flagName}: expected a positive integer, got "${value}"`);
  }
  return parsed;
}
