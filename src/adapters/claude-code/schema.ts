import { z } from "zod";
import type { AdapterSchema } from "../types.ts";

/**
 * Per-server extras in Claude Code format.
 * Maps to the shape inside mcpServers.<name> in ~/.claude.json or .mcp.json.
 */
export const claudeCodeServerSchema = z
  .object({
    always_allow: z
      .union([z.array(z.string()), z.boolean()])
      .optional()
      .describe("Tools auto-approved without prompting"),
  })
  .passthrough();

/**
 * Global adapter settings for Claude Code.
 * Maps to top-level keys in ~/.claude.json or settings.json.
 */
export const claudeCodeGlobalSchema = z
  .object({
    permission_mode: z
      .enum(["default", "plan", "bypassPermissions"])
      .optional()
      .describe("How Claude Code prompts for tool permissions"),
    model: z.string().optional().describe("Primary model alias"),
    ANTHROPIC_MODEL: z.string().optional().describe("Direct model ID override"),
    plugins: z.array(z.string()).optional().describe("Enabled Claude Code plugins"),
    hooks: z
      .record(z.string(), z.array(z.object({ command: z.string() }).passthrough()))
      .optional()
      .describe("Lifecycle hooks (PreCompact, UserPromptSubmit, PostToolUse, Stop, etc.)"),
    monitors: z
      .array(z.object({ command: z.string() }).passthrough())
      .optional()
      .describe("Monitor scripts that observe all tool calls (v2.1.105+)"),
  })
  .passthrough();

export const claudeCodeSchema: AdapterSchema = {
  server: claudeCodeServerSchema,
  global: claudeCodeGlobalSchema,
};
