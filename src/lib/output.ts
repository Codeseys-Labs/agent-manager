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
