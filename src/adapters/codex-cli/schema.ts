import { z } from "zod";
import type { AdapterSchema } from "../types.ts";

/**
 * Per-server extras in Codex CLI format.
 * Maps to fields inside [mcp_servers.<id>] in config.toml.
 */
export const codexServerSchema = z
  .object({
    enabled_tools: z.array(z.string()).optional().describe("Tool allowlist for this server"),
    disabled_tools: z.array(z.string()).optional().describe("Tool denylist for this server"),
    startup_timeout_sec: z.number().optional().describe("Startup timeout in seconds"),
    tool_timeout_sec: z.number().optional().describe("Per-tool timeout in seconds"),
    required: z.boolean().optional().describe("Fail startup if server unavailable"),
    scopes: z.array(z.string()).optional().describe("OAuth scopes"),
    oauth_resource: z.string().optional().describe("RFC 8707 OAuth resource"),
    env_vars: z.array(z.string()).optional().describe("Env vars to forward from host"),
    cwd: z.string().optional().describe("Working directory for server process"),
    bearer_token_env_var: z.string().optional().describe("Bearer token env var for HTTP transport"),
    http_headers: z.record(z.string()).optional().describe("Static HTTP headers"),
    env_http_headers: z
      .record(z.string())
      .optional()
      .describe("HTTP headers sourced from env vars"),
  })
  .passthrough();

/**
 * Global adapter settings for Codex CLI.
 * Maps to top-level keys in config.toml.
 */
export const codexGlobalSchema = z
  .object({
    approval_policy: z
      .union([
        z.enum(["untrusted", "on-request", "never"]),
        z.object({ granular: z.record(z.boolean()) }),
      ])
      .optional()
      .describe("Approval policy for tool use"),
    sandbox_mode: z
      .enum(["read-only", "workspace-write", "danger-full-access"])
      .optional()
      .describe("Sandbox mode for file system access"),
    model: z.string().optional().describe("Primary model"),
    model_provider: z.string().optional().describe("Model provider name"),
    model_reasoning_effort: z
      .enum(["minimal", "low", "medium", "high", "xhigh"])
      .optional()
      .describe("Reasoning effort level"),
    personality: z.enum(["none", "friendly", "pragmatic"]).optional().describe("Agent personality"),
    web_search: z.enum(["disabled", "cached", "live"]).optional().describe("Web search mode"),
  })
  .passthrough();

export const codexCliSchema: AdapterSchema = {
  server: codexServerSchema,
  global: codexGlobalSchema,
};
