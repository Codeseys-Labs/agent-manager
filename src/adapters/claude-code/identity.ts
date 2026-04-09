/**
 * Server identity resolution for Claude Code adapter.
 *
 * Extracts a canonical package identifier from MCP server command+args,
 * enabling cross-tool deduplication during import.
 */

/** Runner prefixes that should be stripped to reveal the package name. */
const RUNNER_PREFIXES = ["npx", "bunx", "uvx", "pipx"] as const;

/** Flags consumed by runner commands (not part of the package name). */
const RUNNER_FLAGS = new Set(["-y", "--yes", "-p", "--package", "run"]);

/**
 * Extract a canonical package identifier from a server's command + args.
 *
 * Resolution order (first match wins):
 *   1. Runner-based: npx/bunx/uvx/pipx → first non-flag arg, strip @version
 *   2. Endpoint-based: --endpoint URL → hostname
 *   3. Command basename: /usr/local/bin/foo → foo
 */
export function extractPackageId(command: string, args: string[] = []): string | undefined {
  const cmdBase = basename(command);

  // 1. Endpoint-based extraction (proxy-wrapped servers — highest specificity)
  const endpoint = extractEndpoint(args);
  if (endpoint) return endpoint;

  // 2. Runner-based: npx/bunx/uvx/pipx → first non-flag arg, strip @version
  if ((RUNNER_PREFIXES as readonly string[]).includes(cmdBase)) {
    const pkg = firstPackageArg(args);
    if (pkg) return stripVersion(pkg);
  }

  // 3. Command basename fallback
  return cmdBase || undefined;
}

/** Return the first arg that isn't a runner flag. */
function firstPackageArg(args: string[]): string | undefined {
  for (const arg of args) {
    if (RUNNER_FLAGS.has(arg)) continue;
    if (arg.startsWith("-")) continue;
    return arg;
  }
  return undefined;
}

/** Strip @version suffix: `tavily-mcp@latest` → `tavily-mcp`, `@upstash/context7-mcp@latest` → `@upstash/context7-mcp`. */
function stripVersion(pkg: string): string {
  // Scoped packages: @scope/name@version
  if (pkg.startsWith("@")) {
    const slashIdx = pkg.indexOf("/");
    if (slashIdx === -1) return pkg;
    const afterSlash = pkg.slice(slashIdx + 1);
    const atIdx = afterSlash.indexOf("@");
    if (atIdx === -1) return pkg;
    return pkg.slice(0, slashIdx + 1 + atIdx);
  }
  // Unscoped: name@version
  const atIdx = pkg.indexOf("@");
  if (atIdx === -1) return pkg;
  return pkg.slice(0, atIdx);
}

/** Extract hostname from --endpoint URL in args. */
function extractEndpoint(args: string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--endpoint" && i + 1 < args.length) {
      try {
        const url = new URL(args[i + 1]);
        return url.hostname;
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}

/** Extract basename from a path: `/usr/local/bin/foo` → `foo` */
function basename(cmd: string): string {
  const lastSlash = cmd.lastIndexOf("/");
  return lastSlash === -1 ? cmd : cmd.slice(lastSlash + 1);
}
