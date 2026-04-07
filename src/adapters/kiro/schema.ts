import { z } from "zod";
import type { AdapterSchema } from "../types.ts";

/**
 * Per-server extras in Kiro format.
 * Maps to fields inside mcpServers.<name> in .kiro/settings/mcp.json.
 */
export const kiroServerSchema = z
  .object({
    autoApprove: z
      .array(z.string())
      .optional()
      .describe("Tools auto-approved without prompting"),
    disabledTools: z
      .array(z.string())
      .optional()
      .describe("Tools to omit from this server"),
    timeout: z
      .number()
      .optional()
      .describe("Request timeout in milliseconds"),
    headers: z
      .record(z.string())
      .optional()
      .describe("HTTP headers for remote servers"),
    oauth: z
      .object({
        redirectUri: z.string().optional(),
        oauthScopes: z.array(z.string()).optional(),
      })
      .passthrough()
      .optional()
      .describe("OAuth configuration for remote servers"),
  })
  .passthrough();

/**
 * Global adapter settings for Kiro.
 * Maps to top-level Kiro configuration.
 */
export const kiroGlobalSchema = z
  .object({
    model: z.string().optional().describe("Model override"),
  })
  .passthrough();

export const kiroSchema: AdapterSchema = {
  server: kiroServerSchema,
  global: kiroGlobalSchema,
};
