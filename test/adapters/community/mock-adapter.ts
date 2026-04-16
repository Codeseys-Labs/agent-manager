#!/usr/bin/env bun
/**
 * Mock community adapter for testing.
 * Reads JSON-RPC requests from stdin, writes responses to stdout.
 */

import { createInterface } from "node:readline";

const rl = createInterface({ input: process.stdin });

rl.on("line", (line: string) => {
  try {
    const request = JSON.parse(line);
    const { id, method, params } = request;
    let result: unknown;

    switch (method) {
      case "adapter/initialize":
        result = { protocolVersion: "1.0", adapterVersion: "0.1.0" };
        break;
      case "adapter/meta":
        result = {
          name: "mock-tool",
          displayName: "Mock Tool",
          version: "0.1.0",
          capabilities: ["mcp", "instructions"],
        };
        break;
      case "adapter/detect":
        result = { installed: true, version: "1.0.0", paths: { configDir: "/tmp/mock" } };
        break;
      case "adapter/import":
        result = { servers: [], instructions: [], skills: [], warnings: [] };
        break;
      case "adapter/export":
        result = { files: [], warnings: [] };
        break;
      case "adapter/diff":
        result = { status: "in-sync", changes: [] };
        break;
      case "adapter/schema":
        result = {};
        break;
      default:
        process.stdout.write(
          `${JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${method}` } })}\n`,
        );
        return;
    }

    process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
  } catch {
    // Ignore malformed input
  }
});
