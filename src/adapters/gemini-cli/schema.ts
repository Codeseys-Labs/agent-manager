import { z } from "zod";
import type { AdapterSchema } from "../types.ts";

/**
 * Per-server extras in Gemini CLI format.
 * Maps to the shape inside mcpServers.<name> in settings.json.
 */
export const geminiCliServerSchema = z
  .object({
    timeout: z.number().optional().describe("Server connection timeout in milliseconds"),
    trust: z.boolean().optional().describe("Whether to trust the server without confirmation"),
    includeTools: z.array(z.string()).optional().describe("Tools to include from this server"),
    excludeTools: z.array(z.string()).optional().describe("Tools to exclude from this server"),
  })
  .passthrough();

/**
 * Global adapter settings for Gemini CLI.
 * Maps to top-level keys in settings.json (non-MCP sections).
 */
export const geminiCliGlobalSchema = z
  .object({
    model: z.string().optional().describe("Model name (e.g. gemini-2.5-pro)"),
    sandbox: z.enum(["docker", "none"]).optional().describe("Tool sandbox mode"),
  })
  .passthrough();

export const geminiCliSchema: AdapterSchema = {
  server: geminiCliServerSchema,
  global: geminiCliGlobalSchema,
};
