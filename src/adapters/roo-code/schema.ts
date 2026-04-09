import { z } from "zod";
import type { AdapterSchema } from "../types.ts";

/**
 * Per-server extras for Roo Code.
 * Maps to fields inside mcpServers.<name> in mcp_settings.json / .roo/mcp.json.
 */
export const rooCodeServerSchema = z
  .object({
    alwaysAllow: z.array(z.string()).optional().describe("Tools auto-approved without prompting"),
    disabled: z.boolean().optional().describe("Whether the server is disabled"),
  })
  .passthrough();

/**
 * Global adapter settings for Roo Code.
 */
export const rooCodeGlobalSchema = z
  .object({
    scope: z.enum(["global", "project"]).optional().describe("Server scope routing hint"),
  })
  .passthrough();

export const rooCodeSchema: AdapterSchema = {
  server: rooCodeServerSchema,
  global: rooCodeGlobalSchema,
};
