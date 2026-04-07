/**
 * Server identity resolution for Windsurf adapter.
 *
 * Reuses the same extraction logic as Claude Code — the MCP server
 * config format is identical (mcpServers with command/args/env).
 */

export { extractPackageId } from "../claude-code/identity.ts";
