import { defineCommand } from "citty";
import { createApp } from "../web/server";

export const serveCommand = defineCommand({
  meta: { name: "serve", description: "Start the web dashboard" },
  args: {
    port: {
      type: "string",
      description: "Port to listen on",
      default: "3456",
    },
  },
  async run({ args }) {
    const port = Number.parseInt(args.port, 10);
    if (Number.isNaN(port) || port < 1 || port > 65535) {
      console.error("error: Invalid port number");
      process.exitCode = 1;
      return;
    }

    const app = createApp();

    Bun.serve({
      port,
      fetch: app.fetch,
    });

    console.log(`Dashboard running at http://localhost:${port}`);
  },
});
