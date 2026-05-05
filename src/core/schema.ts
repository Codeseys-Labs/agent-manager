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

// --- Marketplace Provenance (tracks servers imported from IDE plugins/extensions) ---
export const MarketplaceProvenanceSchema = z.object({
  source: z.enum([
    "claude-plugin",
    "vscode-extension",
    "cursor-extension",
    "kiro-extension",
    "windsurf-extension",
  ]),
  package: z.string(),
  version: z.string(),
  imported_at: z.string(),
  install_path: z.string().optional(),
});
export type MarketplaceProvenance = z.infer<typeof MarketplaceProvenanceSchema>;

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
  _marketplace: MarketplaceProvenanceSchema.optional(),
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
  _marketplace: MarketplaceProvenanceSchema.optional(),
  adapters: adaptersPassthrough,
});
export type Skill = z.infer<typeof SkillSchema>;

// --- Agent Variant Schema (ADR-0036) ---
// A variant is a named { protocol, command, args, env, permission_policy? }
// tuple: one agent entry, many ways to launch it (anthropic direct vs Bedrock
// vs OpenRouter, etc). `env` values may use ${VAR} interpolated via the
// existing secrets layer (ADR-0012) at spawn time.
export const AgentVariantSchema = z.object({
  protocol: z.enum(["acp", "a2a"]).default("acp"),
  command: z.string().optional(),
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
  // Per-variant override for the ACP permission policy. Unset → inherits
  // class default. Schema accepts the value; MVP does not wire it to
  // enforcement (see ADR-0036 out-of-scope).
  permission_policy: z.enum(["auto-approve", "deny"]).optional(),
});
export type AgentVariant = z.infer<typeof AgentVariantSchema>;

// --- Agent Profile Schema ---
// prompt XOR prompt_file (mutually exclusive)
// acp/a2a are unified registry protocol entries (ADR-0030)
// variants / default_variant are ADR-0036 extensions.
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
    acp: z.object({ command: z.string() }).optional(),
    a2a: z.object({ url: z.string() }).optional(),
    // ADR-0033 Phase B: bookkeeping flag set by `am agent enable-shim` so
    // tools (e.g. `am agent list`, `am status`) can tell the user the agent
    // is running through the acp-shell wrapper.
    shim_enabled: z.boolean().optional(),
    // ADR-0036: per-agent variants for multi-provider / multi-account routing.
    variants: z.record(z.string(), AgentVariantSchema).optional(),
    default_variant: z.string().optional(),
    _marketplace: MarketplaceProvenanceSchema.optional(),
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
        allowed_paths: z.array(z.string()).optional(),
      })
      .optional(),
    wiki: z
      .object({
        inject_on_apply: z.boolean().optional(),
      })
      .optional(),
    // ADR-0042: per-repo selection of the SecretsBackend used when NEW
    // envelopes are produced. Existing `enc:v1:` envelopes continue to
    // decrypt via `aes-gcm-legacy` regardless of this setting.
    secrets: z
      .object({
        backend: z.enum(["age", "aes-gcm-legacy"]).optional(),
      })
      .passthrough()
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
