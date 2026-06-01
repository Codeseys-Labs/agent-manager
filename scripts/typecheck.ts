#!/usr/bin/env bun
/**
 * First-party typecheck gate.
 *
 * `tsc --noEmit` pulls the `@silvery/*` (and its `react-reconciler`) packages'
 * raw `.ts` SOURCE into the program because they ship source, not just `.d.ts`,
 * so `skipLibCheck` can't silence them. Those ~50 errors are upstream-vendor
 * noise, not our code. This wrapper runs tsc, drops vendor lines, and fails ONLY
 * on first-party (`src/`, `test/`, `scripts/`, `types/`) errors — so
 * `bun run typecheck` reflects the health of code we actually own.
 *
 * Run `bun x tsc --noEmit` directly if you want the full (vendor-inclusive) output.
 */
const proc = Bun.spawnSync(["bun", "x", "tsc", "--noEmit"], {
  cwd: new URL("..", import.meta.url).pathname,
  stdout: "pipe",
  stderr: "pipe",
});

const out = `${proc.stdout?.toString() ?? ""}${proc.stderr?.toString() ?? ""}`;
const lines = out.split("\n");

const VENDOR = /(^|\/)node_modules\/|(^|\/)silvery\/src\//;
const isErrorLine = (l: string) => /\(\d+,\d+\): error TS\d+/.test(l);

const firstPartyErrors = lines.filter((l) => isErrorLine(l) && !VENDOR.test(l));
const vendorErrorCount = lines.filter((l) => isErrorLine(l) && VENDOR.test(l)).length;

if (firstPartyErrors.length > 0) {
  console.error("First-party type errors:\n");
  for (const l of firstPartyErrors) console.error(l);
  console.error(`\n✗ ${firstPartyErrors.length} first-party type error(s).`);
  process.exit(1);
}

console.log(
  `✓ First-party typecheck clean.${
    vendorErrorCount > 0
      ? ` (${vendorErrorCount} @silvery vendor-source errors ignored — not ours)`
      : ""
  }`,
);
