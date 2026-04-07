import { z } from "zod";
import type { AdapterSchema } from "../types.ts";

/**
 * Per-server extras in Kilo Code new CLI-native format.
 * Maps to fields inside mcp.<name> in kilo.jsonc.
 */
export const kiloCodeServerSchema = z
  .object({
    timeout: z
      .number()
      .optional()
      .describe("Server timeout in milliseconds"),
    enabled: z
      .boolean()
      .optional()
      .describe("Whether the server is enabled"),
    alwaysAllow: z
      .array(z.string())
      .optional()
      .describe("Tools auto-approved without prompting (legacy format)"),
  })
  .passthrough();

/**
 * Global adapter settings for Kilo Code.
 * Maps to top-level keys in kilo.jsonc.
 */
export const kiloCodeGlobalSchema = z
  .object({
    model: z
      .string()
      .optional()
      .describe("Default model (e.g. anthropic/claude-sonnet-4-20250514)"),
    permission: z
      .record(z.string())
      .optional()
      .describe("Tool permission overrides (read/edit/bash/mcp)"),
    instructions: z
      .array(z.string())
      .optional()
      .describe("Paths, globs, or URLs to instruction files"),
  })
  .passthrough();

export const kiloCodeSchema: AdapterSchema = {
  server: kiloCodeServerSchema,
  global: kiloCodeGlobalSchema,
};
