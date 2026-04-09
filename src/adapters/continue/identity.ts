/**
 * Server identity resolution for Continue adapter.
 *
 * Reuses the same extraction logic as Claude Code — the MCP server
 * config format uses the same command/args/env fields.
 */

export { extractPackageId } from "../claude-code/identity.ts";
