/**
 * Zod schemas for marketplace plugin manifests.
 *
 * @deprecated Marketplace v1 is retired per ADR-0039. This module is frozen for
 * compatibility and scheduled for removal; use the MCP Registry for servers and
 * git-subtree/git-submodule bundles for skills/instructions/agents. See
 * ADRs/0039-marketplace-v1-scope-decision.md.
 *
 * Mirrors the TypeScript interfaces in `./types.ts`. Both sources must stay
 * in sync; when you edit one, update the other. The schema is what
 * `am marketplace validate` checks against — the TS interface is what code
 * is written in terms of.
 */

import { z } from "zod";

export const PluginAuthorSchema = z
  .object({
    name: z.string().min(1, "author.name must be a non-empty string"),
    email: z.string().email().optional(),
  })
  .strict();

export const PluginServerConfigSchema = z
  .object({
    command: z.string().min(1, "command must be a non-empty string"),
    args: z.array(z.string()).optional(),
    env: z.record(z.string(), z.string()).optional(),
    transport: z.enum(["stdio", "streamable-http", "sse"]).optional(),
    url: z.string().url().optional(),
  })
  .strict();

export const PluginAgentConfigSchema = z
  .object({
    name: z.string().min(1, "agent.name must be a non-empty string"),
    description: z.string().optional(),
    prompt: z.string().optional(),
    prompt_file: z.string().optional(),
    model: z.string().optional(),
    tools: z.array(z.string()).optional(),
  })
  .strict();

export const PluginAdapterConfigSchema = z
  .object({
    command: z.string().min(1, "adapter.command must be a non-empty string"),
    source: z.string().optional(),
  })
  .strict();

export const PluginManifestSchema = z
  .object({
    name: z
      .string()
      .min(1, "plugin.name is required")
      .regex(
        /^[a-z0-9][a-z0-9-]*$/,
        "plugin.name must be lowercase alphanumeric with dashes, starting with alphanumeric (e.g. 'my-plugin')",
      ),
    description: z.string().min(1, "plugin.description is required"),
    version: z.string().optional(),
    author: PluginAuthorSchema.optional(),
    servers: z.record(z.string(), PluginServerConfigSchema).optional(),
    skills: z.array(z.string()).optional(),
    agents: z.record(z.string(), PluginAgentConfigSchema).optional(),
    adapter: PluginAdapterConfigSchema.optional(),
  })
  .strict();

export type PluginManifestSchemaType = z.infer<typeof PluginManifestSchema>;
