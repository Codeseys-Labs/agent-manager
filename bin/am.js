#!/usr/bin/env node

const { execFileSync, execSync } = require("node:child_process");
const { existsSync } = require("node:fs");
const { join } = require("node:path");

const PLATFORM_MAP = {
  darwin: "darwin",
  linux: "linux",
  win32: "windows",
};

const ARCH_MAP = {
  x64: "x64",
  arm64: "arm64",
};

function getBinaryName() {
  const os = PLATFORM_MAP[process.platform];
  const arch = ARCH_MAP[process.arch];

  if (!os || !arch) {
    return null;
  }

  const name = `am-${os}-${arch}`;
  return os === "windows" ? `${name}.exe` : name;
}

function findBinary() {
  const name = getBinaryName();
  if (!name) return null;

  const candidates = [
    join(__dirname, "..", "dist", name),
    join(__dirname, "..", name),
    join(__dirname, name),
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  return null;
}

function hasBun() {
  try {
    execSync("bun --version", { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function main() {
  const args = process.argv.slice(2);

  // Try compiled binary first
  const binary = findBinary();
  if (binary) {
    try {
      execFileSync(binary, args, {
        stdio: "inherit",
        env: process.env,
      });
      process.exit(0);
    } catch (err) {
      process.exit(err.status || 1);
    }
  }

  // Fall back to running via bun
  if (hasBun()) {
    const entrypoint = join(__dirname, "..", "src", "cli.ts");
    try {
      execFileSync("bun", ["run", entrypoint, ...args], {
        stdio: "inherit",
        env: process.env,
      });
      process.exit(0);
    } catch (err) {
      process.exit(err.status || 1);
    }
  }

  // No binary, no bun
  console.error(
    `agent-manager: No prebuilt binary found for ${process.platform}-${process.arch}.\n\nTo use agent-manager, either:\n  1. Install bun (https://bun.sh) and run: bunx agent-manager\n  2. Download a binary from https://github.com/Codeseys-Labs/agent-manager/releases\n  3. Use the install script: curl -fsSL https://raw.githubusercontent.com/Codeseys-Labs/agent-manager/main/install.sh | sh`,
  );
  process.exit(1);
}

main();
