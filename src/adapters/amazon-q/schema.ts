import { z } from "zod";
import type { AdapterSchema } from "../types.ts";

/**
 * Per-server extras in Amazon Q format.
 * Amazon Q supports timeout and URL-based HTTP servers.
 */
export const amazonQServerSchema = z
  .object({
    timeout: z.number().optional().describe("Server timeout in seconds"),
    url: z.string().optional().describe("Remote server URL (HTTP transport)"),
    headers: z.record(z.string()).optional().describe("Headers for HTTP transport"),
  })
  .passthrough();

export const amazonQSchema: AdapterSchema = {
  server: amazonQServerSchema,
};
