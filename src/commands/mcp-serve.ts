import { defineCommand } from "citty";
import { McpServer, loadAuthConfig } from "../mcp/server";

export const mcpServeCommand = defineCommand({
  meta: {
    name: "mcp-serve",
    description: "Start agent-manager as an MCP server (stdio transport)",
  },
  args: {
    "allow-unsafe-local": {
      type: "boolean",
      description:
        "Allow write-tier tools without AM_MCP_TOKEN (local-only; not recommended for agents you don't control).",
    },
  },
  async run({ args }) {
    // Wave 2.B: auth gate for write-tier tools.
    // Priority: CLI flag --allow-unsafe-local > AM_MCP_ALLOW_UNSAFE_LOCAL env.
    // AM_MCP_TOKEN (env only) takes precedence over both — if set, token auth is required.
    const base = loadAuthConfig();
    const auth = {
      token: base.token,
      allowUnsafeLocal: base.allowUnsafeLocal || !!args["allow-unsafe-local"],
    };
    const server = new McpServer({ auth });
    await server.serve();
  },
});
