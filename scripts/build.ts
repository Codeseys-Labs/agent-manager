#!/usr/bin/env bun

const version = process.env.VERSION ?? "0.0.0-dev";
const timestamp = new Date().toISOString();

interface Target {
  bun: string;
  artifact: string;
}

const ALL_TARGETS: Target[] = [
  { bun: "bun-darwin-arm64", artifact: "am-darwin-arm64" },
  { bun: "bun-darwin-x64", artifact: "am-darwin-x64" },
  { bun: "bun-linux-x64", artifact: "am-linux-x64" },
  { bun: "bun-linux-arm64", artifact: "am-linux-arm64" },
  { bun: "bun-windows-x64", artifact: "am-windows-x64.exe" },
];

// Phase 1: only macOS arm64
const PHASE1_TARGETS: Target[] = [{ bun: "bun-darwin-arm64", artifact: "am-darwin-arm64" }];

// ADR-0033 Phase B: am-acp-shell secondary binary.
// Compiled in lock-step with the main `am` binary so consumers get both from
// one release. At runtime bin/am-acp-shell.js dispatches to the matching
// dist/am-acp-shell-<os>-<arch> file or falls back to bun.
interface Entry {
  entry: string;
  artifactBase: string;
  artifactSuffix?: string; // ".exe" on windows
}
const ENTRIES: Entry[] = [
  { entry: "./src/cli.ts", artifactBase: "am" },
  { entry: "./src/acp-shell-cli.ts", artifactBase: "am-acp-shell" },
];

function getTargets(): Target[] {
  const arg = process.argv[2];
  if (arg === "--all") return ALL_TARGETS;
  if (arg === "--target") {
    const name = process.argv[3];
    const found = ALL_TARGETS.find((t) => t.bun === name || t.artifact === name);
    if (!found) {
      console.error(
        `Unknown target: ${name}\nAvailable: ${ALL_TARGETS.map((t) => t.bun).join(", ")}`,
      );
      process.exit(1);
    }
    return [found];
  }
  return PHASE1_TARGETS;
}

const targets = getTargets();
console.log(
  `Building agent-manager v${version} (${targets.length} target${targets.length > 1 ? "s" : ""})\n`,
);

const { mkdirSync, readFileSync, writeFileSync, existsSync, copyFileSync } = await import(
  "node:fs"
);
mkdirSync("./dist", { recursive: true });

// Patch Silvery's create-app.tsx to stub out the dynamic require for
// @silvery/ag-term/buffer which can't be resolved by bun build --compile.
// This diagnostic code only runs on render mismatch detection — safe to stub.
const createAppPath = "./node_modules/@silvery/create/src/create-app.tsx";
const createAppBackup = `${createAppPath}.bak`;
if (existsSync(createAppPath)) {
  const src = readFileSync(createAppPath, "utf8");
  if (!existsSync(createAppBackup)) {
    copyFileSync(createAppPath, createAppBackup);
  }
  const patched = src.replace(
    /require\("@silvery\/ag-term\/buffer"\)\s*as\s*typeof\s*import\("@silvery\/ag-term\/buffer"\)/g,
    '({ cellEquals: () => true, bufferToText: () => "" } as any)',
  );
  if (patched !== src) {
    writeFileSync(createAppPath, patched);
    console.log("  Patched @silvery/create for bun --compile compatibility");
  } else {
    console.warn("  ⚠ WARNING: Silvery patch regex did not match — build may fail at runtime");
    console.warn("    Check if @silvery/create source format changed");
  }
}

function artifactForEntry(entry: Entry, target: Target): string {
  if (entry.artifactBase === "am") {
    // Preserve historical file names (am-darwin-arm64, am-windows-x64.exe).
    return target.artifact;
  }
  // Secondary binaries follow <base>-<platform-arch>[.exe]
  const isWindows = target.artifact.endsWith(".exe");
  const base = target.artifact.replace(/^am-/, "").replace(/\.exe$/, "");
  return `${entry.artifactBase}-${base}${isWindows ? ".exe" : ""}`;
}

for (const target of targets) {
  for (const entry of ENTRIES) {
    const artifact = artifactForEntry(entry, target);
    const outfile = `./dist/${artifact}`;
    console.log(`  Building ${artifact}...`);

    try {
      // Bun.build() JS API does not support `compile` for standalone executables.
      // Use Bun.spawn to invoke `bun build --compile` CLI instead.
      // Externalize optional lazy-loaded deps from Silvery that are never
      // needed at runtime (Yoga fallback, Termless headless testing).
      const externals = [
        "yoga-wasm-web",
        "yoga-wasm-web/auto",
        "@termless/core",
        "@termless/xtermjs",
        "@termless/ghostty",
      ].flatMap((pkg) => ["--external", pkg]);

      const proc = Bun.spawn(
        [
          "bun",
          "build",
          "--compile",
          "--minify",
          "--sourcemap=linked",
          ...externals,
          `--define=process.env.BUILD_VERSION=${JSON.stringify(version)}`,
          `--define=process.env.BUILD_TIME=${JSON.stringify(timestamp)}`,
          `--target=${target.bun}`,
          `--outfile=${outfile}`,
          entry.entry,
        ],
        {
          stdout: "inherit",
          stderr: "inherit",
          env: {
            ...process.env,
            BUILD_VERSION: version,
            BUILD_TIME: timestamp,
          },
        },
      );

      const exitCode = await proc.exited;
      if (exitCode !== 0) {
        console.error(`  ✗ ${artifact} failed (exit ${exitCode})`);
        process.exit(1);
      }
      console.log(`  ✓ ${artifact}`);
    } catch (err) {
      console.error(`  ✗ ${artifact}: ${err}`);
      process.exit(1);
    }
  }
}

console.log("\nBuild complete.");

// Mark this file as a module so top-level `await` typechecks (TS1375).
export {};
