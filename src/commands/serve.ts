import { randomBytes } from "node:crypto";
import { defineCommand } from "citty";
import { parsePositiveInt } from "../lib/output";
import { createApp } from "../web/server";

/** Mint a fresh 128-bit session-bound URL token. Exported for testing. */
export function mintSessionToken(): string {
  return randomBytes(16).toString("hex");
}

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

    // Fresh per-invocation token. Never persisted to disk — restarting
    // `am serve` invalidates the prior URL.
    const authToken = mintSessionToken();
    const app = await createApp({ enableBridge: args.bridge, authToken });

    Bun.serve({
      port,
      fetch: app.fetch,
    });

    // Log the bootstrap URL to stderr so `am serve | tee log.txt` doesn't
    // accidentally persist the credential to stdout-captured logs.
    console.error(`Dashboard ready — open: http://localhost:${port}/?token=${authToken}`);
    if (args.bridge) {
      console.error("A2A-ACP bridge enabled: incoming A2A tasks will route to local ACP agents");
    }
  },
});
