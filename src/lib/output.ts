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

export function debug(message: string, opts: OutputOptions): void {
  if (opts.verbose && !opts.json) console.log(`  [debug] ${message}`);
}
