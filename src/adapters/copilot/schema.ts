import { z } from "zod";
import type { AdapterSchema } from "../types.ts";

/**
 * Per-server extras in Copilot format.
 * Copilot VS Code uses "servers" key with optional "type" field.
 */
export const copilotServerSchema = z
  .object({
    type: z
      .enum(["stdio", "http"])
      .optional()
      .describe("Server transport type (Copilot-specific)"),
    url: z
      .string()
      .optional()
      .describe("URL for HTTP-type servers"),
  })
  .passthrough();

/**
 * Per-instruction extras in Copilot format.
 * Maps to .github/instructions/*.instructions.md frontmatter.
 */
export const copilotInstructionSchema = z
  .object({
    applyTo: z
      .string()
      .optional()
      .describe("Glob pattern for scoped instructions"),
    excludeAgent: z
      .string()
      .optional()
      .describe("Agent to exclude from this instruction"),
  })
  .passthrough();

export const copilotSchema: AdapterSchema = {
  server: copilotServerSchema,
  instruction: copilotInstructionSchema,
};
