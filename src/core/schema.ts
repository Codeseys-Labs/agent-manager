import { z } from "zod";

// Adapter passthrough — core preserves, adapters validate their own sections
const adaptersPassthrough = z.record(z.string(), z.unknown()).optional();

// --- Registry Provenance (tracks servers installed via am install) ---
export const RegistryProvenanceSchema = z.object({
  source: z.literal("mcp-registry"),
  package: z.string(),
  version: z.string(),
  installed_at: z.string(),
});
export type RegistryProvenance = z.infer<typeof RegistryProvenanceSchema>;

// --- Server Schema (MCP) ---
export const ServerSchema = z.object({
  command: z.string(),
  url: z.string().optional(),
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
  transport: z.enum(["stdio", "streamable-http", "sse"]).default("stdio"),
  description: z.string().optional(),
  tags: z.array(z.string()).optional(),
  enabled: z.boolean().default(true),
  _registry: RegistryProvenanceSchema.optional(),
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

// --- Agent Profile Schema ---
// prompt XOR prompt_file (mutually exclusive)
export const AgentProfileSchema = z
  .object({
    name: z.string(),
    description: z.string().optional(),
    subagent_type: z.string().optional(),
    prompt: z.string().optional(),
    prompt_file: z.string().optional(),
    model: z.string().optional(),
    tools: z.array(z.string()).optional(),
    disallowed_tools: z.array(z.string()).optional(),
    mcp_servers: z.array(z.string()).optional(),
    max_turns: z.number().optional(),
    adapters: adaptersPassthrough,
  })
  .refine((data) => !(data.prompt && data.prompt_file), {
    message: "Agent profile must have either 'prompt' or 'prompt_file', not both",
  });
export type AgentProfile = z.infer<typeof AgentProfileSchema>;

// --- Profile Schema ---
export const ProfileSchema = z.object({
  description: z.string().optional(),
  inherits: z.string().optional(),
  servers: z.array(z.string()).optional(),
  server_tags: z.array(z.string()).optional(),
  skills: z.array(z.string()).optional(),
  agents: z.array(z.string()).optional(),
  instructions: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
  adapters: adaptersPassthrough,
});
export type Profile = z.infer<typeof ProfileSchema>;

// --- Settings Schema ---
/** Available MCP tool groups for settings.mcp_serve.tools */
export const MCP_TOOL_GROUPS = ["core", "registry", "a2a", "wiki", "session", "acp"] as const;
export type McpToolGroup = (typeof MCP_TOOL_GROUPS)[number];

export const SettingsSchema = z
  .object({
    default_profile: z.string().optional(),
    mcp_serve: z
      .object({
        allow_push: z.boolean().optional(),
        tools: z.array(z.enum(MCP_TOOL_GROUPS)).optional(),
      })
      .optional(),
    a2a: z
      .object({
        auth_token: z.string().optional(),
        discovery_sources: z.array(z.string()).optional(),
      })
      .optional(),
    acp: z
      .object({
        session_dir: z.string().optional(),
        agents: z.record(z.string(), z.object({ command: z.string() })).optional(),
      })
      .optional(),
    env: z.record(z.string(), z.string()).optional(),
  })
  .passthrough();
export type Settings = z.infer<typeof SettingsSchema>;

// --- Config Schema (global config.toml) ---
export const ConfigSchema = z.object({
  settings: SettingsSchema.optional(),
  servers: z.record(z.string(), ServerSchema).optional(),
  skills: z.record(z.string(), SkillSchema).optional(),
  agents: z.record(z.string(), AgentProfileSchema).optional(),
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
  agents: z.record(z.string(), AgentProfileSchema).optional(),
  instructions: z.record(z.string(), InstructionSchema).optional(),
  env: z.record(z.string(), z.string()).optional(),
  adapters: adaptersPassthrough,
});
export type ProjectConfig = z.infer<typeof ProjectConfigSchema>;
