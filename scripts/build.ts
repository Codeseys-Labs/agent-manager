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
const PHASE1_TARGETS: Target[] = [
  { bun: "bun-darwin-arm64", artifact: "am-darwin-arm64" },
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

const { mkdirSync } = await import("node:fs");
mkdirSync("./dist", { recursive: true });

for (const target of targets) {
  const outfile = `./dist/${target.artifact}`;
  console.log(`  Building ${target.artifact}...`);

  try {
    // Bun.build() JS API does not support `compile` for standalone executables.
    // Use Bun.spawn to invoke `bun build --compile` CLI instead.
    const proc = Bun.spawn(
      [
        "bun",
        "build",
        "--compile",
        "--minify",
        "--sourcemap=linked",
        `--target=${target.bun}`,
        `--outfile=${outfile}`,
        "./src/cli.ts",
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
      console.error(`  ✗ ${target.artifact} failed (exit ${exitCode})`);
      process.exit(1);
    }
    console.log(`  ✓ ${target.artifact}`);
  } catch (err) {
    console.error(`  ✗ ${target.artifact}: ${err}`);
    process.exit(1);
  }
}

console.log("\nBuild complete.");
