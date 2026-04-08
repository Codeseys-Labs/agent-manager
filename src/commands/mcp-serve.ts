import { defineCommand } from "citty";
import { McpServer } from "../mcp/server";

export const mcpServeCommand = defineCommand({
  meta: {
    name: "mcp-serve",
    description: "Start agent-manager as an MCP server (stdio transport)",
  },
  args: {},
  async run() {
    const server = new McpServer();
    await server.serve();
  },
});
