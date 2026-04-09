import { z } from "zod";
import type { AdapterSchema } from "../types.ts";

/**
 * Per-server extras for Cline.
 * Maps to fields inside mcpServers.<name> in cline_mcp_settings.json.
 */
export const clineServerSchema = z
  .object({
    alwaysAllow: z.array(z.string()).optional().describe("Tools auto-approved without prompting"),
    disabled: z.boolean().optional().describe("Whether the server is disabled"),
  })
  .passthrough();

export const clineSchema: AdapterSchema = {
  server: clineServerSchema,
};
