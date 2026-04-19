#!/usr/bin/env node

/**
 * Launcher for am-acp-shell — the ACP-shim subbinary shipped with
 * agent-manager (ADR-0033 Phase B). Mirrors the strategy in bin/am.js:
 * prefer a precompiled platform binary if one is present in dist/, else
 * fall back to invoking bun on the TypeScript entry point.
 *
 * Uses execFileSync (not exec) so nothing here is shell-evaluated; argv is
 * passed as an array so user input can't inject metacharacters.
 */

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
  if (!os || !arch) return null;
  const name = `am-acp-shell-${os}-${arch}`;
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
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function hasBun() {
  try {
    // No user input — hardcoded "bun --version".
    execSync("bun --version", { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function main() {
  const args = process.argv.slice(2);

  const binary = findBinary();
  if (binary) {
    try {
      execFileSync(binary, args, { stdio: "inherit", env: process.env });
      process.exit(0);
    } catch (err) {
      process.exit(err.status || 1);
    }
  }

  if (hasBun()) {
    const entrypoint = join(__dirname, "..", "src", "acp-shell-cli.ts");
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

  console.error(
    "am-acp-shell: No prebuilt binary found for " +
      process.platform +
      "-" +
      process.arch +
      ".\n\nInstall bun (https://bun.sh) or fetch a prebuilt binary from the agent-manager release.",
  );
  process.exit(1);
}

main();
