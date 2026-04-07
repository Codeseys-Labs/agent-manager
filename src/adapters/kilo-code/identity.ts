/**
 * Server identity resolution for Kilo Code adapter.
 *
 * Kilo has two MCP formats:
 *   - New: command is an array [cmd, ...args]
 *   - Legacy: command is a string + args array (same as Cline/Roo)
 *
 * Extracts a canonical package identifier for cross-tool deduplication.
 */

const RUNNER_PREFIXES = ["npx", "bunx", "uvx", "pipx"] as const;
const RUNNER_FLAGS = new Set(["-y", "--yes", "-p", "--package", "run"]);

/**
 * Extract a canonical package identifier from a server's command + args.
 *
 * Works with both Kilo MCP formats:
 *   - New format: command as array → split into cmd + args
 *   - Legacy format: command string + separate args array
 */
export function extractPackageId(
  command: string | string[],
  args: string[] = [],
): string | undefined {
  let cmd: string;
  let allArgs: string[];

  if (Array.isArray(command)) {
    cmd = command[0] ?? "";
    allArgs = command.slice(1);
  } else {
    cmd = command;
    allArgs = args;
  }

  const cmdBase = basename(cmd);

  // 1. Endpoint-based (proxy-wrapped servers)
  const endpoint = extractEndpoint(allArgs);
  if (endpoint) return endpoint;

  // 2. Runner-based: npx/bunx/uvx/pipx → first non-flag arg, strip @version
  if ((RUNNER_PREFIXES as readonly string[]).includes(cmdBase)) {
    const pkg = firstPackageArg(allArgs);
    if (pkg) return stripVersion(pkg);
  }

  // 3. Command basename fallback
  return cmdBase || undefined;
}

function firstPackageArg(args: string[]): string | undefined {
  for (const arg of args) {
    if (RUNNER_FLAGS.has(arg)) continue;
    if (arg.startsWith("-")) continue;
    return arg;
  }
  return undefined;
}

function stripVersion(pkg: string): string {
  if (pkg.startsWith("@")) {
    const slashIdx = pkg.indexOf("/");
    if (slashIdx === -1) return pkg;
    const afterSlash = pkg.slice(slashIdx + 1);
    const atIdx = afterSlash.indexOf("@");
    if (atIdx === -1) return pkg;
    return pkg.slice(0, slashIdx + 1 + atIdx);
  }
  const atIdx = pkg.indexOf("@");
  if (atIdx === -1) return pkg;
  return pkg.slice(0, atIdx);
}

function extractEndpoint(args: string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--endpoint" && i + 1 < args.length) {
      try {
        return new URL(args[i + 1]).hostname;
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}

function basename(cmd: string): string {
  const lastSlash = cmd.lastIndexOf("/");
  return lastSlash === -1 ? cmd : cmd.slice(lastSlash + 1);
}
