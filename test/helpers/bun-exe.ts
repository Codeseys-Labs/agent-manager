/**
 * bun-exe.ts — resolve the absolute path of the bun binary for test spawns.
 *
 * Background (Wave CI / P0-5): community-adapter proxy tests and a few
 * integration tests spawned the literal command `"bun"`, relying on `bun`
 * being on `$PATH`. In some CI runners (and under the community-adapter env
 * sandbox, which allow-lists `PATH` but does not guarantee the bun install
 * dir is on it) the spawn failed with `Executable not found in $PATH: bun`.
 *
 * `process.execPath` is the absolute path to the bun binary currently running
 * the test suite — the most robust choice because it cannot drift from the
 * runtime and never depends on `$PATH`. We fall back to `Bun.which("bun")`
 * and finally the literal `"bun"` only if `process.execPath` is somehow
 * unavailable (it always is under bun:test).
 */

export function bunExe(): string {
  if (process.execPath) return process.execPath;
  const which = Bun.which("bun");
  if (which) return which;
  return "bun";
}
