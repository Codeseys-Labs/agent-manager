/**
 * Extract a canonical identity from a server command+args for dedup.
 * Uses the ranked signal chain from the design spec:
 * 1. Package identity — strip npx/bunx/uvx/pipx prefixes and @version suffixes
 * 2. Endpoint identity — extract upstream URL from proxy args
 * 3. Command basename — last resort
 */
export function extractServerIdentity(command: string, args?: string[]): string {
  const allParts = [command, ...(args ?? [])];

  // Strip runner prefixes
  const runners = ["npx", "bunx", "uvx", "pipx", "run", "-y"];
  const pkgParts = [...allParts];
  while (pkgParts.length > 0 && runners.includes(pkgParts[0])) {
    pkgParts.shift();
  }

  // Check for proxy endpoint (signal 2 — endpoint identity)
  const endpointIdx = allParts.indexOf("--endpoint");
  if (endpointIdx !== -1 && allParts[endpointIdx + 1]) {
    try {
      const url = new URL(allParts[endpointIdx + 1]);
      return url.hostname;
    } catch {
      // Not a valid URL, fall through
    }
  }

  // Extract package name (signal 1 — package identity)
  if (pkgParts.length > 0) {
    const pkg = pkgParts[0];
    // Strip @version suffix: "tavily-mcp@latest" -> "tavily-mcp"
    const atIdx = pkg.lastIndexOf("@");
    if (atIdx > 0) {
      return pkg.substring(0, atIdx);
    }
    // Strip path prefix: "/usr/local/bin/aws-outlook-mcp" -> "aws-outlook-mcp"
    const slashIdx = pkg.lastIndexOf("/");
    if (slashIdx >= 0) {
      return pkg.substring(slashIdx + 1);
    }
    return pkg;
  }

  return command;
}
