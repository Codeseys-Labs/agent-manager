import { defineCommand } from "citty";
import { parsePositiveInt } from "../lib/output";
import { createApp } from "../web/server";

export const serveCommand = defineCommand({
  meta: { name: "serve", description: "Start the web dashboard" },
  args: {
    port: {
      type: "string",
      description: "Port to listen on",
      default: "3456",
    },
    bridge: {
      type: "boolean",
      description: "Enable A2A-ACP bridge: route incoming A2A tasks to local ACP agents",
      default: false,
    },
  },
  async run({ args }) {
    let port: number;
    try {
      port = parsePositiveInt(args.port, "port", 3456);
    } catch (e) {
      console.error(`error: ${(e as Error).message}`);
      process.exitCode = 1;
      return;
    }
    if (port < 1 || port > 65535) {
      console.error("error: Invalid port number");
      process.exitCode = 1;
      return;
    }

    const app = await createApp({ enableBridge: args.bridge });

    Bun.serve({
      port,
      fetch: app.fetch,
    });

    console.log(`Dashboard running at http://localhost:${port}`);
    if (args.bridge) {
      console.log("A2A-ACP bridge enabled: incoming A2A tasks will route to local ACP agents");
    }
  },
});
