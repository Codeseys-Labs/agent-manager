import { z } from "zod";

// Adapter passthrough — core preserves, adapters validate their own sections
const adaptersPassthrough = z.record(z.string(), z.unknown()).optional();

// --- Registry Provenance (tracks servers installed via am install) ---
export const RegistryProvenanceSchema = z.object({
  source: z.literal("mcp-registry"),
  package: z.string(),
  version: z.string(),
  // ISO-8601 datetime (e.g. "2026-04-01T00:00:00.000Z"). `am update` / `am
  // audit` reason about install recency, so a bare date is insufficient.
  installed_at: z.string().datetime(),
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
  // ISO-8601 datetime — see RegistryProvenanceSchema.installed_at.
  imported_at: z.string().datetime(),
  install_path: z.string().optional(),
});
export type MarketplaceProvenance = z.infer<typeof MarketplaceProvenanceSchema>;

// --- Server Schema (MCP) ---
export const ServerSchema = z
  .object({
    command: z.string(),
    // DEPRECATED / largely unused: the adapter export path
    // (src/adapters/shared/export-utils.ts) treats `command` as the URL for
    // remote (streamable-http / sse) transports — `url` is NOT read there.
    // Only `am install` / marketplace installer set it (redundantly with
    // `command`), and only `mcp superset` surfaces it informationally. A
    // future ADR should migrate ServerSchema to a discriminatedUnion on
    // `transport` (stdio: command.min(1), no url; remote: url.url(), no
    // command) and drop this field; that touches every adapter + fixture, so
    // it is deferred (tracked: seed agent-manager-a067). Until then the
    // superRefine below rejects the clearly illegal stdio+url combination.
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
  })
  .superRefine((data, ctx) => {
    // A server is installed via the MCP registry OR imported from a
    // marketplace plugin/extension — never both. Carrying both provenance
    // blocks is a contradiction (am audit / update can't reason about a
    // server with two mutually-exclusive origins).
    if (data._registry && data._marketplace) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "_registry and _marketplace are mutually exclusive: a server is either " +
          "registry-installed or marketplace-imported, not both",
        path: ["_marketplace"],
      });
    }
    // A stdio server launches a local command and has no URL. Carrying a
    // `url` on a stdio transport is an illegal, ignored field. (Remote
    // transports legitimately carry the URL in `command` today — see the
    // `url` field comment above; that shape is intentionally left valid
    // pending the discriminated-union migration.)
    if (data.transport === "stdio" && data.url !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "url is not valid for a stdio transport (stdio servers launch a local command)",
        path: ["url"],
      });
    }
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

// --- MCP tool groups (used by both ProfileSchema.scope and SettingsSchema) ---
/** Available MCP tool groups for settings.mcp_serve.tools and profile.scope. */
export const MCP_TOOL_GROUPS = ["core", "registry", "a2a", "wiki", "session", "acp"] as const;
export type McpToolGroup = (typeof MCP_TOOL_GROUPS)[number];

// --- Profile Schema ---
/**
 * ADR-0055: a Profile's `scope` projects a RUNTIME access boundary over the MCP
 * tool surface (and, later, skills/agents/knowledge). It composes with the
 * global `settings.mcp_serve.tools` by INTERSECTION — the global setting is the
 * CEILING; `scope.tool_groups` (if set) narrows it; `allow_tools`/`deny_tools`
 * adjust at the individual-tool grain (deny wins). A profile that omits `scope`
 * preserves today's behaviour (the global surface), so the default tool set is
 * unchanged. "Scope" is the BEHAVIOUR name (the access boundary the active
 * Profile projects) — deliberately NOT a third schema type, to avoid colliding
 * with AgentProfile (agent execution scope) and Profile (catalog subset).
 */
export const ProfileScopeSchema = z.object({
  tool_groups: z.array(z.enum(MCP_TOOL_GROUPS)).optional(),
  allow_tools: z.array(z.string()).optional(),
  deny_tools: z.array(z.string()).optional(),
});
export type ProfileScope = z.infer<typeof ProfileScopeSchema>;

export const ProfileSchema = z.object({
  description: z.string().optional(),
  inherits: z.string().optional(),
  servers: z.array(z.string()).optional(),
  server_tags: z.array(z.string()).optional(),
  skills: z.array(z.string()).optional(),
  agents: z.array(z.string()).optional(),
  instructions: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
  scope: ProfileScopeSchema.optional(),
  adapters: adaptersPassthrough,
});
export type Profile = z.infer<typeof ProfileSchema>;

// --- Settings Schema ---

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
    // ADR-0046: reject `team_passphrase` field in the schema.
    //
    // Optional `argon2` subtable tunes the Argon2id parameters used by
    // the age backend when wrapping / unwrapping the per-machine
    // identity passphrase. Defaults follow OWASP 2025 / RFC 9106
    // guidance for a 2026-era dev laptop:
    //
    //   memoryKiB   = 131072 (128 MiB, raised from the 64 MiB of the
    //                 initial ADR-0042 research doc)
    //   time        = 3       (iterations)
    //   parallelism = 4       (lanes)
    //
    // Raising `memoryKiB` past 131072 is a safe upgrade: old
    // identity.age files carry their own KDF work factor in the age
    // header and decrypt unchanged. New wraps use the configured
    // params; run `am secrets rewrap` if you want to re-wrap an old
    // identity at higher cost.
    secrets: z
      .object({
        backend: z.enum(["age", "aes-gcm-legacy"]).optional(),
        argon2: z
          .object({
            // 8 MiB floor protects against "typo set it to 1" DoS on
            // the paranoid side; 128 MiB default is the OWASP-2025
            // floor for sensitive credential stores. RFC 9106 §4
            // suggests >= 65536 KiB for interactive use; we exceed
            // that by 2x for 2026 hardware headroom.
            memoryKiB: z.number().int().min(8192).default(131072),
            time: z.number().int().min(1).default(3),
            // Cap parallelism at 16 to match argon2-browser / the
            // RFC-recommended safe upper bound; higher values bring
            // diminishing returns and crash WASM runtimes.
            parallelism: z.number().int().min(1).max(16).default(4),
          })
          .optional(),
        // ADR-0051 Phase 1 — grace-period mechanics for `am secrets
        // rotate`. During `grace_period_days` both the old and new
        // identity are valid (dual-encrypt); after that window the
        // operator runs `am secrets rotate --finalize` to drop the
        // old identity. Default 14 days balances team sync latency
        // (timezones, offline devices) against the dual-compromise
        // window. Set to 0 for immediate cutover (agenix `--rekey`
        // semantics); upper bound 365 days protects against typos
        // that would disable rotation in practice.
        rotation: z
          .object({
            grace_period_days: z.number().int().min(0).max(365).default(14),
          })
          .optional(),
      })
      .passthrough()
      .refine((s) => !("team_passphrase" in s), {
        message:
          "settings.secrets.team_passphrase is rejected by design (ADR-0046). " +
          "Single-passphrase team sharing has no revocation, no audit trail, " +
          "and single-point-of-compromise risk. Use per-recipient X25519 " +
          "identities instead: each teammate runs `am pair accept` (you then " +
          "run `am pair finalize`) to add their recipient. See ADR-0042.",
        path: ["team_passphrase"],
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
