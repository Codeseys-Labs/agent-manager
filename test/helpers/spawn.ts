/**
 * spawn.ts — cross-platform "print" commands for flow action-node tests.
 *
 * Flow action nodes parse their `command` string with the POSIX-style
 * tokenizer in `parseCommand` and spawn `[executable, ...args]` via `Bun.spawn`
 * WITHOUT a shell. POSIX builtins like `pwd` / `echo` are therefore not
 * spawnable on Windows (`pwd` does not exist; `echo` is a cmd.exe builtin, not
 * a standalone `echo.exe` on PATH). These helpers build a guaranteed-spawnable
 * invocation using the running bun binary (`process.execPath` via `bunExe()`),
 * which exists on every platform and never depends on PATH.
 *
 * The bun path is wrapped in single quotes so its backslashes (Windows paths
 * like `C:\…\bun.exe`) survive the tokenizer literally — in unquoted regions
 * the tokenizer treats `\` as an escape character.
 *
 * The interpolated `{{placeholder}}` is ALSO single-quoted so a value with
 * spaces (e.g. "fix: add null check") survives as a single argv token after
 * `interpolateTemplate` substitutes it.
 */

import { bunExe } from "./bun-exe.ts";

/**
 * A flow action `command` that prints the process working directory to stdout.
 * Use with an action-node `cwd` override; assert the stdout against the
 * canonical (`realpathSync`) form of that directory.
 */
export function printCwdCommand(): string {
  return `'${bunExe()}' -e 'process.stdout.write(process.cwd())'`;
}

/**
 * A flow action `command` that prints a single interpolated argument to stdout.
 *
 * @param placeholder - the template placeholder to echo, e.g. `"{{filename}}"`.
 *   It is single-quoted in the emitted command so the interpolated value
 *   survives the tokenizer as one argv token even if it contains spaces.
 */
export function printArgCommand(placeholder: string): string {
  return `'${bunExe()}' -e 'process.stdout.write(process.argv[1] ?? "")' '${placeholder}'`;
}
