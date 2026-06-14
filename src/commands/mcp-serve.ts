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
    profile: {
      type: "string",
      description:
        "Bind this server to a profile's runtime tool-access scope (ADR-0055). Overrides AM_MCP_PROFILE.",
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
    // ADR-0055: `--profile <name>` binds the server to that profile's runtime
    // Scope. It is seeded into the server's connection profile and takes
    // PRECEDENCE over the AM_MCP_PROFILE env (which the server still honors when
    // the flag is absent). Pass it as an explicit constructor option rather than
    // mutating process.env so the precedence is enforced at the injection seam.
    const connectionProfile =
      typeof args.profile === "string" && args.profile.length > 0 ? args.profile : undefined;
    const server = new McpServer({ auth, connectionProfile });
    await server.serve();
  },
});
