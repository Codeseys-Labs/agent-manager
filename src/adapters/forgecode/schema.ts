import { z } from "zod";
import type { AdapterSchema } from "../types.ts";

/**
 * Per-server extras in ForgeCode format.
 * Maps to the shape inside mcpServers.<name> in .mcp.json.
 */
export const forgeCodeServerSchema = z
  .object({
    disable: z
      .boolean()
      .optional()
      .describe("Whether the server is disabled"),
    url: z
      .string()
      .optional()
      .describe("URL for remote SSE/streamable HTTP servers"),
  })
  .passthrough();

/**
 * Global adapter settings for ForgeCode.
 * Maps to .forge.toml fields.
 */
export const forgeCodeGlobalSchema = z
  .object({
    model: z.string().optional().describe("Default model for all agents"),
    max_requests_per_turn: z
      .number()
      .optional()
      .describe("Safety limit: total requests before asking user"),
    max_tool_failure_per_turn: z
      .number()
      .optional()
      .describe("Safety limit: failures before asking user"),
  })
  .passthrough();

export const forgeCodeSchema: AdapterSchema = {
  server: forgeCodeServerSchema,
  global: forgeCodeGlobalSchema,
};
