import { z } from "zod";

// Adapter passthrough — core preserves, adapters validate their own sections
const adaptersPassthrough = z.record(z.string(), z.unknown()).optional();

// --- Server Schema (MCP) ---
export const ServerSchema = z.object({
  command: z.string(),
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
  transport: z.enum(["stdio", "streamable-http", "sse"]).default("stdio"),
  description: z.string().optional(),
  tags: z.array(z.string()).optional(),
  enabled: z.boolean().default(true),
  adapters: adaptersPassthrough,
});
export type Server = z.infer<typeof ServerSchema>;

// --- Instruction Schema ---
// content XOR content_file (mutually exclusive)
export const InstructionSchema = z
  .object({
    content: z.string().optional(),
    content_file: z.string().optional(),
    scope: z.enum(["always", "glob", "agent-decision", "manual"]),
    globs: z.array(z.string()).optional(),
    description: z.string().optional(),
    targets: z.array(z.string()).optional(),
    adapters: adaptersPassthrough,
  })
  .superRefine((data, ctx) => {
    if (data.content && data.content_file) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "content and content_file are mutually exclusive",
      });
    }
    if (!data.content && !data.content_file) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Either content or content_file is required",
      });
    }
  });
export type Instruction = z.infer<typeof InstructionSchema>;

// --- Skill Schema ---
export const SkillSchema = z.object({
  path: z.string(),
  description: z.string(),
  tags: z.array(z.string()).optional(),
  adapters: adaptersPassthrough,
});
export type Skill = z.infer<typeof SkillSchema>;

// --- Profile Schema ---
export const ProfileSchema = z.object({
  description: z.string().optional(),
  inherits: z.string().optional(),
  servers: z.array(z.string()).optional(),
  server_tags: z.array(z.string()).optional(),
  skills: z.array(z.string()).optional(),
  instructions: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
  adapters: adaptersPassthrough,
});
export type Profile = z.infer<typeof ProfileSchema>;

// --- Settings Schema ---
export const SettingsSchema = z
  .object({
    default_profile: z.string().optional(),
    mcp_serve: z
      .object({
        allow_apply: z.boolean().optional(),
        allow_push: z.boolean().optional(),
      })
      .optional(),
  })
  .passthrough();
export type Settings = z.infer<typeof SettingsSchema>;

// --- Config Schema (global config.toml) ---
export const ConfigSchema = z.object({
  settings: SettingsSchema.optional(),
  servers: z.record(z.string(), ServerSchema).optional(),
  skills: z.record(z.string(), SkillSchema).optional(),
  instructions: z.record(z.string(), InstructionSchema).optional(),
  profiles: z.record(z.string(), ProfileSchema).optional(),
  adapters: adaptersPassthrough,
});
export type Config = z.infer<typeof ConfigSchema>;

// --- Project Config Schema (.agent-manager.toml) ---
export const ProjectConfigSchema = z.object({
  profile: z.string().optional(),
  project: z
    .object({
      name: z.string(),
      description: z.string().optional(),
    })
    .optional(),
  servers: z.record(z.string(), ServerSchema).optional(),
  skills: z.record(z.string(), SkillSchema).optional(),
  instructions: z.record(z.string(), InstructionSchema).optional(),
  env: z.record(z.string(), z.string()).optional(),
  adapters: adaptersPassthrough,
});
export type ProjectConfig = z.infer<typeof ProjectConfigSchema>;
