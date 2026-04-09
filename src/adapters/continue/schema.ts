import { z } from "zod";
import type { AdapterSchema } from "../types.ts";

/**
 * Per-server extras in Continue format.
 * Continue supports cwd for working directory.
 */
export const continueServerSchema = z
  .object({
    cwd: z.string().optional().describe("Working directory for the MCP server process"),
  })
  .passthrough();

export const continueSchema: AdapterSchema = {
  server: continueServerSchema,
};
