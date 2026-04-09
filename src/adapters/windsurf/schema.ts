import { z } from "zod";
import type { AdapterSchema } from "../types.ts";

/**
 * Per-server extras in Windsurf format.
 * Windsurf supports ${env:VAR} interpolation in server configs.
 */
export const windsurfServerSchema = z
  .object({
    serverUrl: z.string().optional().describe("Remote server URL (alternative to command)"),
  })
  .passthrough();

/**
 * Per-instruction extras in Windsurf format.
 * Maps to .windsurf/rules/*.md frontmatter fields.
 */
export const windsurfInstructionSchema = z
  .object({
    trigger: z
      .enum(["always_on", "model_decision", "glob", "manual"])
      .optional()
      .describe("Windsurf rule trigger mode"),
    globs: z.string().optional().describe("Glob pattern for trigger: glob rules"),
  })
  .passthrough();

export const windsurfSchema: AdapterSchema = {
  server: windsurfServerSchema,
  instruction: windsurfInstructionSchema,
};
