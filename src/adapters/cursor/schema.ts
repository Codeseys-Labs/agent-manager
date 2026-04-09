import { z } from "zod";
import type { AdapterSchema } from "../types.ts";

/**
 * Per-server extras in Cursor format.
 * Maps to the shape inside mcpServers.<name> in .cursor/mcp.json.
 */
export const cursorServerSchema = z
  .object({
    url: z
      .string()
      .optional()
      .describe("Remote server URL (replaces command/args for HTTP-based servers)"),
    headers: z.record(z.string()).optional().describe("HTTP headers for remote servers"),
  })
  .passthrough();

/**
 * Per-instruction extras in Cursor format.
 * Maps to .mdc frontmatter fields.
 */
export const cursorInstructionSchema = z
  .object({
    alwaysApply: z.boolean().optional().describe("Load in every AI request"),
    globs: z.array(z.string()).optional().describe("File patterns that auto-trigger"),
  })
  .passthrough();

export const cursorSchema: AdapterSchema = {
  server: cursorServerSchema,
  instruction: cursorInstructionSchema,
};
