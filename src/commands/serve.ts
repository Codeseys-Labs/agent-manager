import { randomBytes } from "node:crypto";
import { defineCommand } from "citty";
import { parsePositiveInt } from "../lib/output";
import { createApp } from "../web/server";

/** Mint a fresh 128-bit session-bound URL token. Exported for testing. */
export function mintSessionToken(): string {
  return randomBytes(16).toString("hex");
}

/**
 * Loopback bind hostname. The web dashboard is a *local* editing surface
 * (pillar 6); by default it must only be reachable from this machine. Bun
 * defaults `Bun.serve({ hostname })` to "0.0.0.0" (every interface, LAN- and
 * potentially WAN-reachable) — the inbound mirror of the SEC-3 outbound SSRF
 * guard footgun. We default to loopback and require an explicit `--host`
 * opt-in for LAN access. Exported for testing.
 */
export const LOOPBACK_HOST = "127.0.0.1";

/**
 * The wildcard bind used when `--host` opts into LAN exposure. Exported for
 * testing.
 */
export const LAN_HOST = "0.0.0.0";

/**
 * Resolve the URL hostname to print to the user given the actual bind host.
 * When bound to the wildcard `0.0.0.0`, "localhost" is still the correct
 * thing to open locally, but we keep it accurate by reporting the real bind.
 * Exported for testing.
 */
export function displayHostForBind(bindHost: string): string {
  // Wildcard binds are not directly dialable; the canonical local URL is
  // localhost. For an explicit loopback bind we also print localhost since
  // 127.0.0.1 === localhost for the user's browser.
  if (bindHost === LAN_HOST || bindHost === LOOPBACK_HOST) return "localhost";
  return bindHost;
}

export const serveCommand = defineCommand({
  meta: { name: "serve", description: "Start the web dashboard" },
  args: {
    port: {
      type: "string",
      description: "Port to listen on",
      default: "3456",
    },
    host: {
      type: "string",
      description:
        "Bind hostname. Defaults to 127.0.0.1 (loopback, this machine only). " +
        "Pass --host 0.0.0.0 (or --lan) to expose the dashboard on your LAN — only do this on a trusted network.",
    },
    lan: {
      type: "boolean",
      description:
        "Shorthand for --host 0.0.0.0: bind all interfaces so other machines on your LAN can reach the dashboard.",
      default: false,
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

    // Default to loopback (this machine only). `--lan` is the convenience
    // shorthand for the wildcard bind; an explicit `--host <addr>` wins over
    // both and lets advanced users bind a specific interface.
    const hostArg = typeof args.host === "string" && args.host.length > 0 ? args.host : undefined;
    const hostname = hostArg ?? (args.lan ? LAN_HOST : LOOPBACK_HOST);

    // Fresh per-invocation token. Never persisted to disk — restarting
    // `am serve` invalidates the prior URL.
    const authToken = mintSessionToken();
    const app = await createApp({ enableBridge: args.bridge, authToken });

    Bun.serve({
      hostname,
      port,
      fetch: app.fetch,
    });

    // Log the bootstrap URL to stderr so `am serve | tee log.txt` doesn't
    // accidentally persist the credential to stdout-captured logs. Keep the
    // printed host accurate to the actual bind.
    const displayHost = displayHostForBind(hostname);
    console.error(`Dashboard ready — open: http://${displayHost}:${port}/?token=${authToken}`);
    if (hostname !== LOOPBACK_HOST) {
      console.error(
        `warning: binding ${hostname} — the dashboard is reachable from other machines on your network. Only do this on a trusted network.`,
      );
    }
    if (args.bridge) {
      console.error("A2A-ACP bridge enabled: incoming A2A tasks will route to local ACP agents");
    }
  },
});
