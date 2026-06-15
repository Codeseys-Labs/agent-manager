import { defineCommand } from "citty";
import { error, info, output, parsePositiveInt } from "../lib/output";
import { RegistryError, search } from "../registry/client";
import type { RegistryPackage, RegistrySearchFilters } from "../registry/types";

export const searchCommand = defineCommand({
  meta: { name: "search", description: "Search the MCP registry for packages" },
  args: {
    query: { type: "positional", description: "Search query", required: true },
    limit: { type: "string", description: "Max results (default: 20, max: 100)" },
    "no-cache": { type: "boolean", description: "Bypass cache", default: false },
    json: { type: "boolean", description: "JSON output", default: false },
    quiet: { type: "boolean", alias: "q", default: false },
    verbose: { type: "boolean", alias: "v", default: false },
  },
  async run({ args }) {
    const opts = { json: args.json, quiet: args.quiet, verbose: args.verbose };
    const skipCache = args["no-cache"] ?? false;

    const filters: RegistrySearchFilters = {};
    if (args.limit) filters.limit = parsePositiveInt(args.limit, "limit", 20);
    if (!filters.limit) filters.limit = 20;

    let result;
    try {
      result = await search(args.query, filters, { skipCache });
    } catch (err) {
      if (err instanceof RegistryError) {
        error(err.message, opts);
      } else {
        error(`Search failed: ${(err as Error).message}`, opts);
      }
      process.exitCode = 1;
      return;
    }

    if (args.json) {
      output(result, opts);
      return;
    }

    if (result.packages.length === 0) {
      info(
        `No packages found for "${args.query}". Try a broader search or check https://registry.modelcontextprotocol.io`,
        opts,
      );
      return;
    }

    // Table header
    info(
      `${"Name".padEnd(25)} ${"Description".padEnd(40)} ${"Author".padEnd(15)} ${"Version".padEnd(10)} ${"Downloads".padEnd(10)} ${""}`,
      opts,
    );
    info(
      `${"─".repeat(25)} ${"─".repeat(40)} ${"─".repeat(15)} ${"─".repeat(10)} ${"─".repeat(10)} ${"─".repeat(3)}`,
      opts,
    );

    for (const pkg of result.packages) {
      const desc = truncate(pkg.description, 38);
      const author = truncate(pkg.author, 13);
      const downloads = pkg.downloads != null ? String(pkg.downloads) : "—";
      const verified = pkg.verified ? "✓" : "";
      info(
        `${pkg.name.padEnd(25)} ${desc.padEnd(40)} ${author.padEnd(15)} ${pkg.version.padEnd(10)} ${downloads.padEnd(10)} ${verified}`,
        opts,
      );
    }

    const more = result.nextCursor ? " (more available)" : "";
    info(`\n${result.packages.length} result(s)${more}`, opts);
  },
});

function truncate(str: string, max: number): string {
  if (str.length <= max) return str;
  return `${str.slice(0, max - 1)}…`;
}
