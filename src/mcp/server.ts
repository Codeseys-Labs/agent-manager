/**
 * Minimal MCP server implementing JSON-RPC 2.0 over stdio.
 *
 * Three permission tiers (ADR-0009):
 *   read-only    — always available
 *   write-local  — available by default
 *   write-remote — requires opt-in via settings.mcp_serve
 */

import { createHash, timingSafeEqual } from "node:crypto";
import { accessSync } from "node:fs";
import { isAbsolute, join, resolve as pathResolve } from "node:path";
import { z } from "zod";
import { getAdapter, getDetectedAdapters, listAdapters } from "../adapters/registry";
import { readActiveProfile, writeActiveProfile } from "../commands/use";
import {
  buildResolvedConfig,
  loadResolvedConfig,
  readConfig,
  resolveConfigDir,
  resolveProjectConfig,
  tryReadConfig,
  writeConfig,
} from "../core/config";
import { APPLY_SAFE_DEFAULTS, applyResolved, withConfig } from "../core/controller";
import { commitAll, getStatus, log as gitLog, pull, push, revertHead } from "../core/git";
import { type ResolvedScope, isToolInScope, resolveProfile } from "../core/resolver";
import type { Config, McpToolGroup, Settings } from "../core/schema";
import { interpolateEnvAsync, legacyKeyPath, loadKey, resolveKeyPath } from "../core/secrets";
import { filterMessages, formatJson, formatMarkdown } from "../core/session";
import type { SessionSummary } from "../core/session";
import {
  redactConfigPlaintextSecrets,
  redactConfigSecrets,
  redactSecretish,
  safeErrorMessage,
  stripUrlUserinfo,
} from "../lib/redact";
import { AM_VERSION } from "../lib/version";

// ── JSON-RPC types ──────────────────────────────────────────────

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

// ── MCP protocol version negotiation (Wave C) ───────────────────
//
// Spec: https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle
// "If the server supports the requested protocol version, it MUST respond
// with the same version. Otherwise, the server MUST respond with another
// protocol version it supports."
//
// We track a set of versions we speak. When the client requests one we
// support, we echo it back. If we can't support any of them, we emit
// -32602 with the list of versions we do support, per the spec example.
export const SUPPORTED_MCP_PROTOCOL_VERSIONS = ["2025-11-25", "2024-11-05"] as const;
export const PREFERRED_MCP_PROTOCOL_VERSION: (typeof SUPPORTED_MCP_PROTOCOL_VERSIONS)[number] =
  "2024-11-05";

/**
 * Methods that are allowed before the client has sent `initialize`. Any
 * other method must return -32002 "Server not initialized" per MCP
 * lifecycle spec: the initialization phase MUST be the first interaction.
 * `ping` is explicitly carved out by the spec as safe pre-init.
 */
const PRE_INIT_ALLOWED_METHODS = new Set<string>(["initialize", "ping"]);

/**
 * SEC-5: maximum length (in UTF-16 code units, ~bytes for ASCII JSON) of a
 * single newline-delimited JSON-RPC line read from stdin. A peer that streams
 * bytes without a newline would otherwise grow the read buffer without bound.
 * Lines past this cap are rejected with a JSON-RPC parse error (-32700) and
 * the buffer is discarded. 16 MiB comfortably exceeds any legitimate
 * MCP request while bounding memory.
 */
export const MAX_STDIN_LINE_BYTES = 16 * 1024 * 1024;

// ── MCP tool definition ─────────────────────────────────────────

interface McpToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
}

type ToolTier = "read-only" | "write-local" | "write-remote";

// ── ADR-0037 Phase 1: per-tool metadata (x-am namespace) ─────────
//
// Self-describing tool surface for MCP clients. Emitted on every tool
// entry in `tools/list` responses. Phase 1 scope:
//   - group, tier, auth_required (mechanical, derived from existing
//     TOOL_GROUP_MAP + ToolEntry.tier + auth config)
//   - deprecated + deprecation.replacement/removal_version (derived
//     from the DEPRECATED_ALIASES registry below)
//   - progress_supported (derived from PROGRESS_SUPPORTED set)
//
// Phase 2/3 (output_schema, error_codes, progress_shape) are
// explicitly deferred — each tool would need bespoke schemas.

export interface AmToolMetadata {
  group: McpToolGroup;
  tier: ToolTier;
  auth_required: boolean;
  deprecated: boolean;
  deprecation?: { replacement: string; removal_version: string };
  progress_supported: boolean;
}

/**
 * Registry of deprecated tool aliases. Keys are the OLD (deprecated)
 * names; values describe what to call instead and the scheduled removal
 * release. Maintained alongside the `warnDeprecated()` call sites.
 *
 * When a new alias is added, add it here so `tools/list` surfaces the
 * deprecation to discovery clients. When a tool is actually removed,
 * its entry here is deleted (alongside deleting the alias handler).
 */
export const DEPRECATED_ALIASES: Record<string, { replacement: string; removal_version: string }> =
  {
    am_agent_delegate: { replacement: "am_agent_invoke", removal_version: "v1.0" },
    am_run_agent: { replacement: "am_agent_invoke", removal_version: "v1.0" },
    am_acp_list_agents: { replacement: "am_agent_list", removal_version: "v1.0" },
    am_acp_session_list: { replacement: "am_agent_session_list", removal_version: "v1.0" },
    am_acp_session_cancel: { replacement: "am_agent_session_cancel", removal_version: "v1.0" },
  };

/**
 * Set of tool names whose handlers emit `notifications/progress` when
 * `params._meta.progressToken` is supplied. Derived from
 * `ctx.emitProgress` call sites. Discovery-time signal so clients can
 * decide whether to set a progressToken for a given call.
 */
export const PROGRESS_SUPPORTED = new Set<string>([
  // Agent invocation (shared by invoke + legacy run_agent alias):
  "am_agent_invoke",
  "am_run_agent",
  // A2A delegation emits status/artifact events:
  "am_agent_delegate",
]);

/**
 * Wave D: per-call context passed to tool handlers.
 *
 * Gives handlers access to:
 *   - `emitProgress(payload)`: emits `notifications/progress` (MCP spec 2025-06-18 §6.3)
 *     back to the client if the caller supplied `params._meta.progressToken`.
 *     If no progressToken was supplied, this is a no-op — handlers can always
 *     call it without checking, and the callers that don't support progress
 *     simply see no notifications (graceful fallback to blocking mode).
 *   - `progressToken`: the raw token (undefined if none); handlers rarely need this.
 */
export interface ToolContext {
  emitProgress: (payload: { progress?: number; total?: number; message?: unknown }) => void;
  progressToken: string | number | undefined;
}

interface ToolEntry {
  def: McpToolDef;
  tier: ToolTier;
  /**
   * Handlers receive args and an optional ToolContext. ctx is always
   * provided by the dispatcher; handlers that predate Wave D ignore it
   * by not declaring the second parameter.
   */
  handler: (args: Record<string, unknown>, ctx: ToolContext) => Promise<unknown>;
}

/**
 * Wave D: set of deprecated-alias tool names we've already warned about in
 * this process. Prevents log spam: the first call to an alias writes a
 * one-line deprecation notice to stderr; subsequent calls to the same alias
 * are silent. Cleared only by restart.
 */
const warnedDeprecatedAliases = new Set<string>();

/**
 * Wave D: per-call emitter for `notifications/progress` — attach this to
 * ctx.emitProgress for the duration of a `tools/call` that supplied a
 * progressToken. The dispatcher installs the concrete writer (stdio vs
 * in-process); tests can replace it via McpServer#setProgressSink.
 */
type ProgressNotification = {
  jsonrpc: "2.0";
  method: "notifications/progress";
  params: { progressToken: string | number; progress?: number; total?: number; message?: unknown };
};
type ProgressSink = (notif: ProgressNotification) => void;

/**
 * REV-2 HIGH-1 / ADR-0033 Phase B prelaunch gate: walk a progress payload and
 * apply `redactSecretish` to every string. ACP `session/update` chunks and
 * A2A status/artifact events are forwarded verbatim to `notifications/progress`
 * by default — that made an ACP agent echoing `sk-ant-...` stream the key to
 * every MCP client that subscribed to progress. This walker rewrites each
 * string leaf through the secret redactor before emission.
 *
 * Exported so tests can drive it directly.
 */
/**
 * Maximum recursion depth for {@link redactProgressMessage}. Guards against
 * DoS from adversarial acyclic payloads with extreme nesting (e.g., 10k
 * levels). Cycles are caught by the WeakSet independently; the depth cap
 * handles the acyclic-but-pathological case. 64 is well above any real
 * ACP session-update shape while low enough to avoid stack-overflow on
 * typical Bun runtimes.
 */
export const REDACT_MAX_DEPTH = 64;

export function redactProgressMessage(message: unknown): unknown {
  return redactProgressMessageImpl(message, new WeakSet(), 0);
}

/**
 * Internal walker with cycle-detection AND depth-cap.
 *
 * An adversarial ACP agent can emit two distinct DoS payloads:
 *   1. Cyclic: `a.self = a` → infinite recursion without `seen`.
 *   2. Deep acyclic: 10,000-level nesting → stack overflow even with `seen`.
 *
 * The WeakSet tracks already-visited objects + arrays. The depth counter
 * caps acyclic nesting. Both checks substitute a sentinel string rather
 * than recursing further.
 */
function redactProgressMessageImpl(
  message: unknown,
  seen: WeakSet<object>,
  depth: number,
): unknown {
  if (depth > REDACT_MAX_DEPTH) return "[TRUNCATED_DEPTH]";
  if (typeof message === "string") return redactSecretish(message);
  if (Array.isArray(message)) {
    if (seen.has(message)) return "[CIRCULAR]";
    seen.add(message);
    return message.map((v) => redactProgressMessageImpl(v, seen, depth + 1));
  }
  if (message && typeof message === "object") {
    if (seen.has(message)) return "[CIRCULAR]";
    seen.add(message);
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(message as Record<string, unknown>)) {
      out[k] = redactProgressMessageImpl(v, seen, depth + 1);
    }
    return out;
  }
  return message;
}

// ── Input validation ────────────────────────────────────────────

/**
 * Validate raw MCP `arguments` against a zod schema at the top of every tool
 * handler. Callers get a discriminated result — no exceptions thrown.
 */
export function validateInput<T>(
  schema: z.ZodSchema<T>,
  args: unknown,
): { ok: true; data: T } | { ok: false; error: string } {
  const parsed = schema.safeParse(args);
  if (parsed.success) return { ok: true, data: parsed.data };
  const issues = parsed.error.issues
    .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
    .join("; ");
  return { ok: false, error: `Invalid arguments: ${issues}` };
}

// ── Auth gate (ADR 2026-04-16 Wave 2.B) ────────────────────────
//
// Problem: `am mcp-serve` talks JSON-RPC over stdio to an unauthenticated
// parent process. On `write-local` calls (e.g. am_apply) we decrypt secrets
// and write them to disk. Any agent plumbed into this server could exfiltrate
// the whole keychain.
//
// Model: if `AM_MCP_TOKEN` is set at server startup, every `write-local` or
// higher tool MUST include a matching bearer token on the call. The token is
// read from either:
//   - params._meta.authorization: "Bearer <token>"  (MCP meta convention)
//   - params._meta.token: "<token>"                 (simpler alt)
//   - params.arguments._am_token: "<token>"         (fallback for clients
//                                                    that can't set _meta)
//
// If no token is set AND the server was not started with
// AM_MCP_ALLOW_UNSAFE_LOCAL=1 (or --allow-unsafe-local), write-tier calls are
// refused at tools/call and write-tier tools are hidden from tools/list.
// Read-only tools remain unauthenticated for backward compatibility.

export interface AuthConfig {
  /** Expected bearer token. If present, write-tier calls must match. */
  token?: string;
  /** Allow write-tier without a token. Required when no token is configured. */
  allowUnsafeLocal: boolean;
}

export function loadAuthConfig(env: NodeJS.ProcessEnv = process.env): AuthConfig {
  const token = env.AM_MCP_TOKEN?.trim() || undefined;
  const allowUnsafeLocal = env.AM_MCP_ALLOW_UNSAFE_LOCAL === "1";
  return { token, allowUnsafeLocal };
}

/**
 * Constant-time string compare that also hides the input length.
 *
 * Wave B (2026-04-16): the previous implementation short-circuited on
 * `a.length !== b.length`, leaking the expected token length via timing. An
 * attacker with stdio access could probe token lengths before beginning a
 * byte-by-byte attack.
 *
 * Fix: hash both inputs to a fixed 32-byte digest (SHA-256) and run
 * `timingSafeEqual` on the digests. The hash step is constant-time w.r.t.
 * the secret (SHA-256 state transitions do not branch on input), the
 * digests are always equal length (32 bytes), and the comparison itself is
 * timing-safe. Net result: no length, prefix, or byte-level timing channel.
 *
 * Exported for the sibling Wave B test that asserts hash is called on both
 * sides.
 */
export function constantTimeEq(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a, "utf8").digest();
  const hb = createHash("sha256").update(b, "utf8").digest();
  return timingSafeEqual(ha, hb);
}

/**
 * Extract a bearer token from a JSON-RPC request, checking the three
 * locations a client might put it. Returns `undefined` if none found.
 */
function extractBearerToken(req: JsonRpcRequest): string | undefined {
  const params = (req.params ?? {}) as Record<string, unknown>;
  const meta = (params._meta as Record<string, unknown> | undefined) ?? undefined;
  if (meta) {
    const authHeader = typeof meta.authorization === "string" ? meta.authorization : undefined;
    if (authHeader) {
      const m = authHeader.match(/^Bearer\s+(.+)$/i);
      if (m) return m[1].trim();
    }
    if (typeof meta.token === "string") return meta.token.trim();
  }
  const args = (params.arguments as Record<string, unknown> | undefined) ?? undefined;
  if (args && typeof args._am_token === "string") return (args._am_token as string).trim();
  return undefined;
}

/**
 * Decide whether a write-tier tool call may proceed given the server's
 * auth config and the incoming request.
 */
export function checkWriteAuth(
  tier: ToolTier,
  auth: AuthConfig,
  req: JsonRpcRequest,
): { allowed: true } | { allowed: false; reason: string } {
  if (tier === "read-only") return { allowed: true };
  // Write tier from here on (write-local or write-remote).
  if (auth.token) {
    const supplied = extractBearerToken(req);
    if (!supplied) {
      return {
        allowed: false,
        reason:
          "Authentication required. Write-tier tools require a bearer token. Pass params._meta.authorization = 'Bearer <token>' matching AM_MCP_TOKEN.",
      };
    }
    if (!constantTimeEq(supplied, auth.token)) {
      return { allowed: false, reason: "Invalid bearer token." };
    }
    return { allowed: true };
  }
  if (auth.allowUnsafeLocal) return { allowed: true };
  return {
    allowed: false,
    reason:
      "Write-tier tools are disabled. Set AM_MCP_TOKEN=<token> (recommended) or AM_MCP_ALLOW_UNSAFE_LOCAL=1 when starting `am mcp-serve`.",
  };
}

/**
 * Read-only tools that disclose the FULL merged config (which may carry
 * secrets the redactor cannot guarantee it caught). When an operator has gone
 * to the trouble of configuring AM_MCP_TOKEN, a tokenless client should not be
 * able to pull the merged config wholesale — even redacted, it leaks server
 * names, internal URLs, and the shape of the deployment.
 *
 * This is a defense-in-depth gate layered ON TOP OF the two-pass redaction in
 * `redactSecrets`: redaction is the last line, this gate is the first.
 */
const SENSITIVE_READONLY_TOOLS = new Set<string>(["am_config_show"]);

/**
 * Decide whether a SENSITIVE read-only tool (full-config disclosure) may
 * proceed. Distinct from `checkWriteAuth` so the default local-dev experience
 * is preserved:
 *   - No token configured  → allowed (local dev, unchanged behaviour).
 *   - Token configured     → require a matching bearer token, exactly like a
 *                            write-tier call. A tokenless client is refused.
 *
 * `allowUnsafeLocal` is irrelevant here: it only relaxes WRITE tooling. A
 * token, once configured, always gates these reads.
 */
export function checkSensitiveReadAuth(
  toolName: string,
  auth: AuthConfig,
  req: JsonRpcRequest,
): { allowed: true } | { allowed: false; reason: string } {
  if (!SENSITIVE_READONLY_TOOLS.has(toolName)) return { allowed: true };
  if (!auth.token) return { allowed: true };
  const supplied = extractBearerToken(req);
  if (!supplied) {
    return {
      allowed: false,
      reason:
        "Authentication required. Full-config disclosure is gated when AM_MCP_TOKEN is set. " +
        "Pass params._meta.authorization = 'Bearer <token>' matching AM_MCP_TOKEN.",
    };
  }
  if (!constantTimeEq(supplied, auth.token)) {
    return { allowed: false, reason: "Invalid bearer token." };
  }
  return { allowed: true };
}

/** Default tool groups exposed when settings.mcp_serve.tools is unset. */
const DEFAULT_TOOL_GROUPS: McpToolGroup[] = ["core"];

/**
 * Map each MCP tool name to its tool group (ADR-0021).
 * Tools not in this map are assigned to "core" by default.
 */
const TOOL_GROUP_MAP: Record<string, McpToolGroup> = {
  // registry group
  am_registry_search: "registry",
  am_registry_install: "registry",
  am_registry_list_installed: "registry",
  am_registry_uninstall: "registry",
  // a2a group
  am_agent_discover: "a2a",
  am_agent_list: "a2a",
  am_agent_delegate: "a2a",
  am_agent_task_status: "a2a",
  // wiki group
  am_wiki_search: "wiki",
  am_wiki_add: "wiki",
  am_wiki_synthesize: "wiki",
  am_wiki_briefing: "wiki",
  am_wiki_harvest: "wiki",
  // session group (extracted from core per ADR-0021)
  am_session_list: "session",
  am_session_export: "session",
  am_session_search: "session",
  // acp group (ADR-0026 Phase 2)
  am_run_agent: "acp",
  am_acp_list_agents: "acp",
  am_acp_session_list: "acp",
  am_acp_session_cancel: "acp",
  // Wave D unified agent tools. We keep them under "acp" so existing
  // settings.mcp_serve.tools = ["acp"] deployments get the new tools too;
  // a future ADR will collapse acp+a2a groups into a single "agents" group.
  am_agent_invoke: "acp",
  am_agent_session_list: "acp",
  am_agent_session_cancel: "acp",
  am_agent_status: "acp",
  am_agent_detect: "acp",
  // All other tools (am_list_servers, am_list_profiles, am_status, etc.) default to "core"
};

/** Resolve the tool group for a given tool name. */
function getToolGroup(toolName: string): McpToolGroup {
  return TOOL_GROUP_MAP[toolName] ?? "core";
}

// ── Permission check ────────────────────────────────────────────

function checkPermission(
  tier: ToolTier,
  settings?: Settings,
): { allowed: boolean; reason?: string } {
  if (tier === "read-only" || tier === "write-local") {
    return { allowed: true };
  }
  // write-remote requires explicit opt-in
  const mcpServe = settings?.mcp_serve;
  if (tier === "write-remote") {
    // Only allow_push gates write-remote (am_sync_push, am_sync_pull)
    if (mcpServe?.allow_push) {
      return { allowed: true };
    }
    return {
      allowed: false,
      reason:
        "Write-remote tools require opt-in. Set settings.mcp_serve.allow_push = true in config.toml",
    };
  }
  return { allowed: true };
}

// ── Secret redaction ───────────────────────────────────────────
// Logic lives in src/lib/redact.ts. Two passes, defense-in-depth:
//   1. redactConfigSecrets — masks `enc:` envelopes (v1 AES-GCM, v2 age).
//   2. redactConfigPlaintextSecrets — masks PLAINTEXT secrets that the
//      envelope pass cannot see: every value under any `env` map is redacted
//      by key location, and all other string leaves run through the
//      secret-shape backstop. A bare `sk-...`/`tvly-...` added by hand or
//      imported before the encryption key existed would otherwise leak
//      verbatim through `am_config_show` to a tokenless MCP client.

function redactSecrets(obj: unknown): unknown {
  return redactConfigPlaintextSecrets(redactConfigSecrets(obj));
}

// ── Path traversal guard ────────────────────────────────────────

/** Strict identifier for session IDs: alnum, dash, underscore, 1–128 chars. */
const SESSION_ID_RE = /^[a-zA-Z0-9_-]{1,128}$/;

/**
 * Validate that a user-supplied session ID is safe to join onto the session
 * directory. Rejects traversal (`..`), separators, null bytes, and enforces
 * the strict charset. Then belt+suspenders: resolves the path and verifies
 * it stays inside the intended directory.
 *
 * Throws a plain Error — callers should let it propagate into the standard
 * error envelope (which is already redacted).
 */
export function resolveSessionPathSafely(sessionDir: string, sessionId: string): string {
  if (typeof sessionId !== "string") {
    throw new Error("Invalid sessionId: must be a string.");
  }
  if (sessionId.length === 0 || sessionId.length > 128) {
    throw new Error("Invalid sessionId: length must be 1–128 characters.");
  }
  if (sessionId.includes("\0")) {
    throw new Error("Invalid sessionId: null byte rejected.");
  }
  if (sessionId.includes("/") || sessionId.includes("\\")) {
    throw new Error("Invalid sessionId: path separators rejected.");
  }
  if (sessionId.includes("..")) {
    throw new Error("Invalid sessionId: parent traversal rejected.");
  }
  if (isAbsolute(sessionId)) {
    throw new Error("Invalid sessionId: absolute paths rejected.");
  }
  if (!SESSION_ID_RE.test(sessionId)) {
    throw new Error("Invalid sessionId: must match /^[a-zA-Z0-9_-]{1,128}$/ (no dots, no spaces).");
  }
  const baseResolved = pathResolve(sessionDir);
  const candidate = pathResolve(baseResolved, sessionId);
  const sep = process.platform === "win32" ? "\\" : "/";
  if (candidate !== baseResolved && !candidate.startsWith(baseResolved + sep)) {
    throw new Error("Invalid sessionId: resolved path escapes session directory.");
  }
  return candidate;
}

// ── Active ACP session registry (Wave D) ────────────────────────
//
// `am_agent_session_cancel` needs a handle to an in-flight ACP client in
// order to call the spec'd `cancel` RPC. Without this registry the cancel
// tool can only clean up on-disk state, which is the exact bug R6 found in
// the legacy `am_acp_session_cancel` handler.
//
// The registry is a plain Map keyed by sessionId. Entries carry the
// AmAcpClient instance and the agent name (so callers can scope cancel by
// agent when multiple agents share a session namespace). Registry is
// populated by `am_agent_invoke` before calling `client.prompt(...)` and
// cleared in a `finally` after disconnect.
//
// A2A sessions use the same map (value.a2a holds {baseUrl}) so
// `am_agent_session_cancel` routes correctly.

interface AcpActiveSession {
  kind: "acp";
  agent: string;
  // CODEX-11 final-signoff (2026-05-02): the server-assigned session ID
  // from ACP newSession(). This is the ID the agent uses over the wire —
  // cancel/prompt must use it, NOT the caller's local tracking ID. May be
  // undefined briefly between activeSessions.set() and newSession()
  // resolving; cancelSessionImpl treats undefined as "fall back to the
  // lookup key" for compatibility with pre-CODEX-11 callers.
  serverSessionId?: string;
  // Loose typing avoids a circular import with protocols/acp/client.ts
  // at module-init time; the registry is only read by the cancel tool
  // which already has the concrete type.
  client: { cancel: (sessionId: string) => Promise<void>; disconnect: () => Promise<void> };
}

interface A2aActiveSession {
  kind: "a2a";
  agent: string;
  baseUrl: string;
  // CODEX-11 parity for A2A: the server-authoritative task id. A strict A2A
  // v0.3 server (which am's OWN server enforces via resolveSendTarget) mints
  // its own task id, ignoring the client-supplied one. cancelTask/getTask MUST
  // use the server's id — using the locally-minted sessionId silently no-ops
  // the cancel (-32001 swallowed) and errors the final getTask. Populated from
  // the Task.id returned by sendTask / the final sendSubscribe event. May be
  // undefined briefly before the first server response; callers fall back to
  // the lookup key (sessionId) for compatibility with non-strict servers.
  serverTaskId?: string;
}

type ActiveSession = AcpActiveSession | A2aActiveSession;

const activeSessions = new Map<string, ActiveSession>();

/** Expose for tests to seed entries without invoking a real agent. */
export function _registerActiveSession(sessionId: string, entry: ActiveSession): void {
  activeSessions.set(sessionId, entry);
}
export function _unregisterActiveSession(sessionId: string): void {
  activeSessions.delete(sessionId);
}
export function _getActiveSession(sessionId: string): ActiveSession | undefined {
  return activeSessions.get(sessionId);
}

// ── ADR-0037 Phase 1: x-am metadata builder ─────────────────────

/**
 * Build the `x-am` metadata object for a tool, to be attached to the
 * tool definition in `tools/list` responses. Pure function — no I/O,
 * no surprises. Takes `toolName` + `tier` because alias tools share a
 * handler but have distinct names in tools/list.
 *
 * `auth_required` is scoped to whether THIS TOOL would be gated by
 * `AM_MCP_TOKEN` when configured. It does NOT depend on whether the
 * server currently has a token set — a read-only tool stays
 * `auth_required: false` either way; a write-tier tool stays
 * `auth_required: true` either way. Clients use this at discovery
 * time to decide whether to include `_meta.authorization` on the call.
 */
export function buildToolMetadata(toolName: string, tier: ToolTier): AmToolMetadata {
  const group = getToolGroup(toolName);
  const deprecationInfo = DEPRECATED_ALIASES[toolName];
  const meta: AmToolMetadata = {
    group,
    tier,
    auth_required: tier !== "read-only",
    deprecated: deprecationInfo !== undefined,
    progress_supported: PROGRESS_SUPPORTED.has(toolName),
  };
  if (deprecationInfo) {
    meta.deprecation = deprecationInfo;
  }
  return meta;
}

// ── Deprecation warning helper (Wave D) ─────────────────────────

/**
 * Emit a one-line deprecation notice to stderr the first time a given
 * alias name is used in this process. Subsequent calls to the same alias
 * are silent. Production stdio clients ignore stderr, so this is safe.
 */
function warnDeprecated(oldName: string, newName: string): void {
  if (warnedDeprecatedAliases.has(oldName)) return;
  warnedDeprecatedAliases.add(oldName);
  // Keep the advertised removal target in lock-step with the registry so
  // the warning never drifts from the `tools/list` deprecation metadata.
  const removal = DEPRECATED_ALIASES[oldName]?.removal_version ?? "a future release";
  // eslint-disable-next-line no-console -- intentional stderr notice
  process.stderr.write(
    `[am-mcp] DEPRECATED: tool "${oldName}" is an alias. Use "${newName}" instead (removal targeted for ${removal}).\n`,
  );
}

/** Reset the deprecation set — exposed for tests that run multiple scenarios. */
export function _resetDeprecationWarnings(): void {
  warnedDeprecatedAliases.clear();
}

// ── Helpers ─────────────────────────────────────────────────────

async function loadConfigAndProfile(): Promise<{
  config: Config;
  configDir: string;
  profileName: string;
}> {
  const configDir = resolveConfigDir();
  const projectFile = resolveProjectConfig(process.cwd());
  const config = await loadResolvedConfig({ configDir, projectFile });
  const profileName =
    (await readActiveProfile(configDir)) ?? config.settings?.default_profile ?? "default";
  return { config, configDir, profileName };
}

// ── Tool input schemas (Wave 2.B runtime validation) ────────────
//
// Every tool that appears in `defineTools()` MUST have a corresponding
// zod schema here. The dispatcher runs `validateInput(schema, args)` at the
// top of every `tools/call` and returns an error envelope if it fails.
//
// Schemas are intentionally `.passthrough()` where unknown fields could
// reasonably appear (e.g. the `_am_token` auth fallback), and `.strict()`
// where we want to reject unexpected properties outright.

const zStr = z.string();
const zStrNonEmpty = z.string().min(1);
const zStrArr = z.array(z.string());
const zStrMap = z.record(z.string(), z.string());
const zBool = z.boolean();
const zNum = z.number();

/** Allow an optional auth passthrough field `_am_token` on every tool. */
function withAuth<T extends z.ZodRawShape>(shape: T) {
  return z.object({ ...shape, _am_token: z.string().optional() }).passthrough();
}

const TOOL_SCHEMAS: Record<string, z.ZodTypeAny> = {
  // ── core read-only ────────────────────────────────────────
  am_list_servers: withAuth({ active: zBool.optional() }),
  am_list_profiles: withAuth({}),
  am_list_skills: withAuth({}),
  am_list_instructions: withAuth({}),
  am_status: withAuth({}),
  am_config_show: withAuth({}),
  am_doctor: withAuth({}),

  // ── session read-only ─────────────────────────────────────
  am_session_list: withAuth({ adapter: zStr.optional() }),
  am_session_export: withAuth({
    id: zStrNonEmpty,
    adapter: zStrNonEmpty,
    role: z.enum(["user", "assistant", "system", "tool"]).optional(),
    noTools: zBool.optional(),
    noSystem: zBool.optional(),
    format: z.enum(["md", "json"]).optional(),
  }),
  am_session_search: withAuth({
    query: zStrNonEmpty,
    adapter: zStr.optional(),
    role: z.enum(["user", "assistant", "system", "tool"]).optional(),
  }),

  // ── core write-local ──────────────────────────────────────
  am_add_server: withAuth({
    name: zStrNonEmpty,
    command: zStrNonEmpty,
    args: zStrArr.optional(),
    tags: zStrArr.optional(),
    description: zStr.optional(),
    env: zStrMap.optional(),
  }),
  am_remove_server: withAuth({ name: zStrNonEmpty }),
  am_profile_create: withAuth({
    name: zStrNonEmpty,
    inherits: zStr.optional(),
    description: zStr.optional(),
  }),
  am_profile_delete: withAuth({ name: zStrNonEmpty }),
  am_server_update: withAuth({
    name: zStrNonEmpty,
    enabled: zBool.optional(),
    env: zStrMap.optional(),
    args: zStrArr.optional(),
    tags: zStrArr.optional(),
    description: zStr.optional(),
  }),
  am_undo: withAuth({}),
  am_use_profile: withAuth({ profile: zStrNonEmpty }),
  am_import: withAuth({ source: zStrNonEmpty }),
  am_apply: withAuth({
    target: zStr.optional(),
    dryRun: zBool.optional(),
    force: zBool.optional(),
  }),

  // ── core write-remote ─────────────────────────────────────
  am_sync_push: withAuth({}),
  am_sync_pull: withAuth({}),

  // ── registry ──────────────────────────────────────────────
  am_registry_search: withAuth({
    query: zStrNonEmpty,
    tag: zStr.optional(),
    verified: zBool.optional(),
    limit: zNum.int().positive().max(1000).optional(),
  }),
  am_registry_install: withAuth({ name: zStrNonEmpty, env: zStrMap.optional() }),
  am_registry_list_installed: withAuth({}),
  am_registry_uninstall: withAuth({ name: zStrNonEmpty }),

  // ── a2a ───────────────────────────────────────────────────
  am_agent_discover: withAuth({ url: zStrNonEmpty.url() }),
  am_agent_list: withAuth({}),
  am_agent_delegate: withAuth({ name: zStrNonEmpty, message: zStrNonEmpty }),
  am_agent_task_status: withAuth({ name: zStrNonEmpty, taskId: zStrNonEmpty }),

  // ── wiki ──────────────────────────────────────────────────
  am_wiki_search: withAuth({
    query: zStrNonEmpty,
    limit: zNum.int().positive().max(1000).optional(),
  }),
  am_wiki_add: withAuth({
    entity_type: z.enum(["fact", "procedure", "preference", "relationship", "capability"]),
    content: zStrNonEmpty,
    context: zStr.optional(),
    tags: zStrArr.optional(),
    confidence: zNum.min(0).max(1).optional(),
  }),
  am_wiki_synthesize: withAuth({
    query: zStrNonEmpty,
    agent_id: zStr.optional(),
    top_k: zNum.int().positive().max(1000).optional(),
  }),
  am_wiki_briefing: withAuth({ agent_id: zStrNonEmpty }),
  am_wiki_harvest: withAuth({ adapter: zStrNonEmpty, session_id: zStrNonEmpty }),

  // ── acp ───────────────────────────────────────────────────
  am_run_agent: withAuth({
    agent: zStrNonEmpty,
    prompt: zStrNonEmpty,
    session: zStr.optional(),
    cwd: zStr.optional(),
  }),
  am_acp_list_agents: withAuth({}),
  am_acp_session_list: withAuth({}),
  // Tight schema on sessionId: regex enforced here, defence-in-depth at handler.
  am_acp_session_cancel: withAuth({
    sessionId: z
      .string()
      .min(1)
      .max(128)
      .regex(SESSION_ID_RE, "sessionId must match /^[a-zA-Z0-9_-]{1,128}$/"),
  }),

  // ── agents (unified, Wave D) ───────────────────────────────
  // Accept either a string `prompt` or a structured `{ messages: [...] }`.
  // A2A only sees the flattened text today; ACP receives the single combined prompt.
  am_agent_invoke: withAuth({
    agent: zStrNonEmpty,
    prompt: z.union([
      zStrNonEmpty,
      z.object({
        messages: z.array(
          z.object({
            role: z.enum(["user", "assistant", "system", "tool"]).optional(),
            content: zStrNonEmpty,
          }),
        ),
      }),
    ]),
    session: zStr.optional(),
    cwd: zStr.optional(),
    stream: zBool.optional(),
    timeout: zNum.int().positive().max(3_600_000).optional(),
  }),
  am_agent_session_list: withAuth({ agent: zStr.optional() }),
  am_agent_session_cancel: withAuth({
    agent: zStr.optional(),
    sessionId: z
      .string()
      .min(1)
      .max(128)
      .regex(SESSION_ID_RE, "sessionId must match /^[a-zA-Z0-9_-]{1,128}$/"),
  }),
  am_agent_status: withAuth({
    sessionId: z.string().min(1).max(128).regex(SESSION_ID_RE),
    agent: zStr.optional(),
  }),
  am_agent_detect: withAuth({}),
};

// ── Tool definitions ────────────────────────────────────────────

function defineTools(): ToolEntry[] {
  return [
    // ── Read-only tier ────────────────────────────────────────
    {
      def: {
        name: "am_list_servers",
        description:
          "List MCP servers in the agent-manager config. Returns name, command, args, tags, enabled status for each server.",
        inputSchema: {
          type: "object",
          properties: {
            active: {
              type: "boolean",
              description: "If true, show only enabled servers",
            },
          },
        },
      },
      tier: "read-only",
      handler: async (args) => {
        const { config } = await loadConfigAndProfile();
        const servers = config.servers ?? {};
        let entries = Object.entries(servers).map(([name, srv]) => ({
          name,
          command: srv.command,
          args: srv.args ?? [],
          tags: srv.tags ?? [],
          enabled: srv.enabled ?? true,
          description: srv.description ?? "",
          transport: srv.transport ?? "stdio",
        }));
        if (args.active) {
          entries = entries.filter((s) => s.enabled);
        }
        return { servers: entries };
      },
    },
    {
      def: {
        name: "am_list_profiles",
        description: "List available profiles and indicate which one is active.",
        inputSchema: { type: "object", properties: {} },
      },
      tier: "read-only",
      handler: async () => {
        const { config, configDir } = await loadConfigAndProfile();
        const profiles = config.profiles ?? {};
        const activeProfile =
          (await readActiveProfile(configDir)) ?? config.settings?.default_profile ?? "default";
        const entries = Object.entries(profiles).map(([name, profile]) => ({
          name,
          description: profile.description ?? "",
          inherits: profile.inherits ?? null,
          active: name === activeProfile,
        }));
        return { profiles: entries, activeProfile };
      },
    },
    {
      def: {
        name: "am_list_skills",
        description:
          "List skills registered in the agent-manager catalog. Returns name, path, description, and tags for each skill.",
        inputSchema: { type: "object", properties: {} },
      },
      tier: "read-only",
      handler: async () => {
        const { config } = await loadConfigAndProfile();
        const skills = config.skills ?? {};
        const entries = Object.entries(skills).map(([name, skill]) => ({
          name,
          path: skill.path,
          description: skill.description ?? "",
          tags: skill.tags ?? [],
        }));
        return { skills: entries };
      },
    },
    {
      def: {
        name: "am_list_instructions",
        description:
          "List instructions registered in the agent-manager catalog. Returns name, scope, description, globs, and target adapters for each instruction.",
        inputSchema: { type: "object", properties: {} },
      },
      tier: "read-only",
      handler: async () => {
        const { config } = await loadConfigAndProfile();
        const instructions = config.instructions ?? {};
        const entries = Object.entries(instructions).map(([name, instruction]) => ({
          name,
          scope: instruction.scope,
          description: instruction.description ?? "",
          globs: instruction.globs ?? [],
          targets: instruction.targets ?? [],
        }));
        return { instructions: entries };
      },
    },
    {
      def: {
        name: "am_status",
        description:
          "Check if IDE tool configs are in sync with the agent-manager catalog. Use after adding/removing servers to see if am_apply is needed. Returns profile, server count, git status, and per-tool drift status.",
        inputSchema: { type: "object", properties: {} },
      },
      tier: "read-only",
      handler: async () => {
        const { config, configDir, profileName } = await loadConfigAndProfile();
        // getStatus returns clean:false for a normal dirty tree and only THROWS
        // on a real fault (not-a-repo, corrupt index, IO error). Defaulting a
        // throw to clean:true would report "working tree clean" precisely when
        // git is broken, leading an agent to conclude there's nothing to sync.
        // Mirror am_doctor's fail handling: on throw report clean:FALSE and
        // surface the fault in `gitError` so the caller sees something is wrong.
        let gitStatus: {
          branch: string;
          clean: boolean;
          dirty: string[];
          remotes: Array<{ remote: string; url: string }>;
        };
        let gitError: string | undefined;
        try {
          gitStatus = await getStatus(configDir);
        } catch (err: unknown) {
          gitStatus = { branch: "unknown", clean: false, dirty: [], remotes: [] };
          gitError = safeErrorMessage(err);
        }
        const resolved = buildResolvedConfig(config, profileName, configDir);
        const serverCount = Object.keys(resolved.servers).length;
        const adapters = await getDetectedAdapters();
        const toolStatuses: Array<{ name: string; status: string; changes: number }> = [];
        for (const adapter of adapters) {
          try {
            const diffResult = await adapter.diff(resolved);
            toolStatuses.push({
              name: adapter.meta.displayName,
              status: diffResult.status,
              changes: diffResult.changes.length,
            });
          } catch {
            toolStatuses.push({ name: adapter.meta.displayName, status: "unknown", changes: 0 });
          }
        }
        return {
          profile: profileName,
          servers: serverCount,
          git: {
            branch: gitStatus.branch,
            clean: gitStatus.clean,
            dirty: gitStatus.dirty,
            // Belt-and-suspenders (R2-SEC1): getStatus already strips userinfo
            // at the git boundary, but scrub each remote URL again here so a raw
            // credential URL can never leak to a tokenless client via am_status.
            remotes: gitStatus.remotes.map((r) => ({
              remote: r.remote,
              url: stripUrlUserinfo(r.url),
            })),
            ...(gitError !== undefined ? { gitError } : {}),
          },
          tools: toolStatuses,
        };
      },
    },
    {
      def: {
        name: "am_config_show",
        description:
          "Show the fully resolved agent-manager configuration (merged global + local + project configs).",
        inputSchema: { type: "object", properties: {} },
      },
      tier: "read-only",
      handler: async () => {
        const { config, profileName } = await loadConfigAndProfile();
        return { profile: profileName, config: redactSecrets(config) };
      },
    },
    {
      def: {
        name: "am_doctor",
        description:
          "Run a health check on the agent-manager configuration. Returns checks for config validity, git status, detected tools, encryption key, secret audit, and more.",
        inputSchema: { type: "object", properties: {} },
      },
      tier: "read-only",
      handler: async () => {
        const configDir = resolveConfigDir();
        const checks: Array<{ name: string; status: "ok" | "warn" | "fail"; message: string }> = [];

        // 1. Config directory exists
        try {
          accessSync(configDir);
          checks.push({ name: "Config directory", status: "ok", message: configDir });
        } catch {
          checks.push({
            name: "Config directory",
            status: "fail",
            message: `Not found: ${configDir}`,
          });
        }

        // 2. Git repository
        try {
          accessSync(join(configDir, ".git"));
          checks.push({ name: "Git repository", status: "ok", message: "Initialized" });
        } catch {
          checks.push({
            name: "Git repository",
            status: "fail",
            message: "Not a git repo. Run `am init`.",
          });
        }

        // 3. config.toml valid
        const configPath = join(configDir, "config.toml");
        try {
          const config = await tryReadConfig(configPath);
          if (config === null) {
            checks.push({ name: "config.toml", status: "fail", message: "Not found" });
          } else {
            checks.push({ name: "config.toml", status: "ok", message: "Valid" });
          }
        } catch (err: unknown) {
          checks.push({
            name: "config.toml",
            status: "fail",
            // safeErrorMessage (not errorMessage): a malformed config can echo a
            // secret value back inside a Zod/TOML parse error; am_doctor is
            // read-only and reachable by a tokenless client (R2-LOW).
            message: `Parse/validation error: ${safeErrorMessage(err)}`,
          });
        }

        // 4. Detected AI tools
        const adapterNames = listAdapters();
        for (const name of adapterNames) {
          const adapter = await getAdapter(name);
          if (!adapter) continue;
          const detection = await adapter.detect();
          if (detection.installed) {
            checks.push({
              name: `Adapter: ${adapter.meta.displayName}`,
              status: "ok",
              message: detection.version ? `v${detection.version}` : "Detected",
            });
          } else {
            checks.push({
              name: `Adapter: ${adapter.meta.displayName}`,
              status: "warn",
              message: "Not detected",
            });
          }
        }

        // 5. Git remote + working tree
        try {
          const gitStatus = await getStatus(configDir);
          if (gitStatus.remotes.length > 0) {
            checks.push({
              name: "Git remote",
              status: "ok",
              // Belt-and-suspenders userinfo scrub (R2-SEC1).
              message: stripUrlUserinfo(gitStatus.remotes[0].url),
            });
          } else {
            checks.push({ name: "Git remote", status: "warn", message: "No remote configured" });
          }
          if (!gitStatus.clean) {
            checks.push({
              name: "Working tree",
              status: "warn",
              message: `${gitStatus.dirty.length} uncommitted change(s)`,
            });
          } else {
            checks.push({ name: "Working tree", status: "ok", message: "Clean" });
          }
        } catch {
          checks.push({
            name: "Git status",
            status: "warn",
            message: "Could not read git status",
          });
        }

        // 6. Encryption key (new location: OS data dir, NOT the git-tracked config dir)
        const keyPath = resolveKeyPath();
        try {
          accessSync(keyPath);
          checks.push({ name: "Encryption key", status: "ok", message: `Present at ${keyPath}` });
        } catch {
          checks.push({
            name: "Encryption key",
            status: "warn",
            message: `Not found at ${keyPath} (secrets will not be encrypted)`,
          });
        }

        // 6b. Legacy key file inside git-tracked config dir
        const legacyPath = legacyKeyPath(configDir);
        try {
          accessSync(legacyPath);
          checks.push({
            name: "Legacy key location",
            status: "warn",
            message: `Found key at ${legacyPath} — this is INSIDE the git-tracked config dir. Delete it and ensure it has not been pushed to any remote.`,
          });
        } catch {
          // Absent: good.
        }

        // 7. Project config in cwd
        const projectFile = resolveProjectConfig(process.cwd());
        if (projectFile) {
          checks.push({ name: "Project config", status: "ok", message: projectFile });
        } else {
          checks.push({
            name: "Project config",
            status: "warn",
            message: "No .agent-manager.toml in current directory tree",
          });
        }

        // 8. Secret audit
        try {
          const configForScan = await tryReadConfig(configPath);
          if (configForScan?.servers) {
            const { scanConfigForSecrets } = await import("../core/secret-detection");
            const scanResults = await scanConfigForSecrets(configForScan.servers);
            const totalSecrets = scanResults.reduce((sum, r) => sum + r.secrets.length, 0);
            if (totalSecrets > 0) {
              checks.push({
                name: "Secret audit",
                status: "warn",
                message: `${totalSecrets} potential unencrypted secret(s) found`,
              });
            } else {
              checks.push({
                name: "Secret audit",
                status: "ok",
                message: "No unencrypted secrets detected",
              });
            }
          }
        } catch {
          // Config already checked above
        }

        const hasFailures = checks.some((c) => c.status === "fail");
        return { healthy: !hasFailures, checks };
      },
    },

    // ── Session tools (read-only) ──────────────────────────────
    {
      def: {
        name: "am_session_list",
        description:
          "List AI coding session TRANSCRIPTS (read-only, cross-tool disk harvest from Claude Code, Codex, etc.). Returns session summaries with message counts, timestamps, and token estimates. For LIVE ACP sessions, use `am_acp_session_list` instead.",
        inputSchema: {
          type: "object",
          properties: {
            adapter: {
              type: "string",
              description: "Filter to a specific adapter (e.g., 'claude-code', 'codex-cli')",
            },
          },
        },
      },
      tier: "read-only",
      handler: async (args) => {
        const adapterFilter = args.adapter as string | undefined;
        const allSummaries: SessionSummary[] = [];

        const adapterNames = adapterFilter ? [adapterFilter] : listAdapters();

        for (const name of adapterNames) {
          const adapter = await getAdapter(name);
          if (!adapter?.sessionReader) continue;
          if (!adapter.sessionReader.hasSessionStorage()) continue;

          try {
            const summaries = await adapter.sessionReader.listSessions();
            allSummaries.push(...summaries);
          } catch {
            // Skip adapters that fail to list sessions
          }
        }

        // Sort by most recent first
        allSummaries.sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime());

        return {
          sessions: allSummaries.map((s) => ({
            ...s,
            startedAt: s.startedAt.toISOString(),
            endedAt: s.endedAt?.toISOString() ?? null,
          })),
          total: allSummaries.length,
        };
      },
    },
    {
      def: {
        name: "am_session_export",
        description:
          "Export an AI coding session by ID. Supports filtering by role, stripping tool/system messages, and markdown or JSON output.",
        inputSchema: {
          type: "object",
          properties: {
            id: { type: "string", description: "Session ID to export" },
            adapter: {
              type: "string",
              description: "Adapter name that owns this session (e.g., 'claude-code')",
            },
            role: {
              type: "string",
              description: "Filter to a specific role: user, assistant, system, tool",
            },
            noTools: {
              type: "boolean",
              description: "Strip tool-role messages",
            },
            noSystem: {
              type: "boolean",
              description: "Strip system-role messages",
            },
            format: {
              type: "string",
              enum: ["md", "json"],
              description: "Output format: 'md' (markdown, default) or 'json'",
            },
          },
          required: ["id", "adapter"],
        },
      },
      tier: "read-only",
      handler: async (args) => {
        const id = args.id as string;
        const adapterName = args.adapter as string;
        const format = (args.format as string) ?? "md";

        const adapter = await getAdapter(adapterName);
        if (!adapter?.sessionReader) {
          throw new Error(
            `Adapter "${adapterName}" does not support session reading. Use am_session_list to find adapters with session data.`,
          );
        }

        const session = await adapter.sessionReader.loadSession(id);
        if (!session) {
          throw new Error(
            `Session "${id}" not found in ${adapterName}. Use am_session_list with adapter="${adapterName}" to see valid session IDs.`,
          );
        }

        const filter = {
          ...(args.role ? { roles: [args.role as "user" | "assistant" | "system" | "tool"] } : {}),
          ...(args.noTools ? { noTools: true } : {}),
          ...(args.noSystem ? { noSystem: true } : {}),
        };

        if (format === "json") {
          return formatJson(session, filter);
        }
        return {
          content: formatMarkdown(session, filter),
        };
      },
    },
    {
      def: {
        name: "am_session_search",
        description:
          "Search AI coding sessions for a query string. Returns matching sessions with message snippets containing the query.",
        inputSchema: {
          type: "object",
          properties: {
            query: { type: "string", description: "Text to search for in session messages" },
            adapter: {
              type: "string",
              description: "Filter to a specific adapter",
            },
            role: {
              type: "string",
              description: "Filter to a specific message role",
            },
          },
          required: ["query"],
        },
      },
      tier: "read-only",
      handler: async (args) => {
        const query = args.query as string;
        const adapterFilter = args.adapter as string | undefined;
        const roleFilter = args.role as string | undefined;

        const adapterNames = adapterFilter ? [adapterFilter] : listAdapters();
        const results: Array<{
          sessionId: string;
          adapter: string;
          project: string | null;
          matches: Array<{ role: string; snippet: string }>;
        }> = [];

        for (const name of adapterNames) {
          const adapter = await getAdapter(name);
          if (!adapter?.sessionReader) continue;
          if (!adapter.sessionReader.hasSessionStorage()) continue;

          let summaries;
          try {
            summaries = await adapter.sessionReader.listSessions();
          } catch {
            continue;
          }

          for (const summary of summaries) {
            let session;
            try {
              session = await adapter.sessionReader.loadSession(summary.id);
            } catch {
              continue;
            }
            if (!session) continue;

            const filter = {
              query,
              ...(roleFilter
                ? { roles: [roleFilter as "user" | "assistant" | "system" | "tool"] }
                : {}),
            };
            const matched = filterMessages(session.messages, filter);

            if (matched.length > 0) {
              results.push({
                sessionId: summary.id,
                adapter: name,
                project: session.project ?? null,
                matches: matched.slice(0, 5).map((m) => ({
                  role: m.role,
                  snippet: m.content.length > 200 ? `${m.content.slice(0, 200)}...` : m.content,
                })),
              });
            }
          }
        }

        return { query, results, total: results.length };
      },
    },

    // ── Write-local tier ──────────────────────────────────────
    {
      def: {
        name: "am_add_server",
        description: "Add an MCP server to the agent-manager catalog.",
        inputSchema: {
          type: "object",
          properties: {
            name: { type: "string", description: "Server name (unique identifier)" },
            command: { type: "string", description: "Command to run the server" },
            args: {
              type: "array",
              items: { type: "string" },
              description: "Command arguments",
            },
            tags: {
              type: "array",
              items: { type: "string" },
              description: "Tags for categorization",
            },
            description: { type: "string", description: "Human-readable description" },
            env: {
              type: "object",
              additionalProperties: { type: "string" },
              description: "Environment variables",
            },
          },
          required: ["name", "command"],
        },
      },
      tier: "write-local",
      handler: async (args) => {
        const configDir = resolveConfigDir();
        const name = args.name as string;
        return withConfig(configDir, async (config) => {
          if (!config) throw new Error("Config not found. Run `am init` first.");
          if (config.servers?.[name]) {
            throw new Error(
              `Server "${name}" already exists. Use am_remove_server to remove it first, or update it directly in config.toml.`,
            );
          }
          if (!config.servers) config.servers = {};
          config.servers[name] = {
            command: args.command as string,
            ...(args.args ? { args: args.args as string[] } : {}),
            ...(args.tags ? { tags: args.tags as string[] } : {}),
            ...(args.description ? { description: args.description as string } : {}),
            ...(args.env ? { env: args.env as Record<string, string> } : {}),
            transport: "stdio",
            enabled: true,
          };
          return {
            result: { action: "add", server: name },
            commitMessage: `add server: ${name}`,
            changed: true,
          };
        });
      },
    },
    {
      def: {
        name: "am_remove_server",
        description: "Remove an MCP server from the agent-manager catalog.",
        inputSchema: {
          type: "object",
          properties: {
            name: { type: "string", description: "Server name to remove" },
          },
          required: ["name"],
        },
      },
      tier: "write-local",
      handler: async (args) => {
        const configDir = resolveConfigDir();
        const name = args.name as string;
        return withConfig(configDir, async (config) => {
          if (!config) throw new Error("Config not found. Run `am init` first.");
          if (!config.servers?.[name]) {
            throw new Error(
              `Server "${name}" not found. Use am_list_servers to see available server names.`,
            );
          }
          delete config.servers[name];
          return {
            result: { action: "remove", server: name },
            commitMessage: `remove server: ${name}`,
            changed: true,
          };
        });
      },
    },
    {
      def: {
        name: "am_profile_create",
        description:
          "Create a new profile in the agent-manager catalog. A profile is a named subset of the catalog (servers, skills, agents, instructions) selected at apply time. Optionally inherit from a parent profile.",
        inputSchema: {
          type: "object",
          properties: {
            name: { type: "string", description: "Profile name (unique identifier)" },
            inherits: { type: "string", description: "Parent profile to inherit from" },
            description: { type: "string", description: "Human-readable description" },
          },
          required: ["name"],
        },
      },
      tier: "write-local",
      handler: async (args) => {
        const configDir = resolveConfigDir();
        const name = args.name as string;
        return withConfig(configDir, async (config) => {
          if (!config) throw new Error("Config not found. Run `am init` first.");
          if (config.profiles?.[name]) {
            throw new Error(
              `Profile "${name}" already exists. Use am_list_profiles to see existing profiles.`,
            );
          }
          const inherits = args.inherits as string | undefined;
          if (inherits && !config.profiles?.[inherits]) {
            throw new Error(`Parent profile "${inherits}" does not exist.`);
          }
          if (!config.profiles) config.profiles = {};
          config.profiles[name] = {
            ...(args.description ? { description: args.description as string } : {}),
            ...(inherits ? { inherits } : {}),
          };
          return {
            result: { action: "create", profile: name },
            commitMessage: `add profile: ${name}`,
            changed: true,
          };
        });
      },
    },
    {
      def: {
        name: "am_profile_delete",
        description:
          "Delete a profile from the agent-manager catalog. Refuses if another profile inherits from it. This does not prompt for confirmation; the change is recoverable via am_undo.",
        inputSchema: {
          type: "object",
          properties: {
            name: { type: "string", description: "Profile name to delete" },
          },
          required: ["name"],
        },
      },
      tier: "write-local",
      handler: async (args) => {
        const configDir = resolveConfigDir();
        const name = args.name as string;
        return withConfig(configDir, async (config) => {
          if (!config) throw new Error("Config not found. Run `am init` first.");
          if (!config.profiles?.[name]) {
            throw new Error(
              `Profile "${name}" does not exist. Use am_list_profiles to see existing profiles.`,
            );
          }
          for (const [otherName, otherProfile] of Object.entries(config.profiles)) {
            if (otherProfile.inherits === name) {
              throw new Error(`Cannot delete "${name}": profile "${otherName}" inherits from it.`);
            }
          }
          delete config.profiles[name];
          return {
            result: { action: "delete", profile: name },
            commitMessage: `delete profile: ${name}`,
            changed: true,
          };
        });
      },
    },
    {
      def: {
        name: "am_registry_uninstall",
        description:
          "Remove an MCP server from the catalog, returning its registry provenance (null if it was not registry-installed). Intended for registry packages; for a plain server use am_remove_server. Run am_apply afterward to update native IDE configs.",
        inputSchema: {
          type: "object",
          properties: {
            name: { type: "string", description: "Server name to uninstall" },
          },
          required: ["name"],
        },
      },
      tier: "write-local",
      handler: async (args) => {
        const configDir = resolveConfigDir();
        const name = args.name as string;
        return withConfig(configDir, async (config) => {
          if (!config) throw new Error("Config not found. Run `am init` first.");
          if (!config.servers?.[name]) {
            throw new Error(
              `Server "${name}" not found. Use am_list_servers to see available server names.`,
            );
          }
          const provenance = config.servers[name]._registry ?? null;
          delete config.servers[name];
          return {
            result: { action: "uninstall", server: name, provenance },
            commitMessage: `uninstall server: ${name}`,
            changed: true,
          };
        });
      },
    },
    {
      def: {
        name: "am_server_update",
        description:
          "Update properties of an existing MCP server (enable/disable, change env vars, args, tags, or description).",
        inputSchema: {
          type: "object",
          properties: {
            name: { type: "string", description: "Server name to update" },
            enabled: { type: "boolean", description: "Enable or disable the server" },
            env: {
              type: "object",
              additionalProperties: { type: "string" },
              description: "Environment variables to merge into existing env",
            },
            args: {
              type: "array",
              items: { type: "string" },
              description: "New command arguments (replaces existing)",
            },
            tags: {
              type: "array",
              items: { type: "string" },
              description: "Tags to set (replaces existing)",
            },
            description: { type: "string", description: "New description" },
          },
          required: ["name"],
        },
      },
      tier: "write-local",
      handler: async (args) => {
        const configDir = resolveConfigDir();
        const name = args.name as string;
        return withConfig(configDir, async (config) => {
          if (!config) throw new Error("Config not found. Run `am init` first.");
          if (!config.servers?.[name]) {
            throw new Error(
              `Server "${name}" not found. Use am_list_servers to see available server names.`,
            );
          }
          const existing = config.servers[name];
          if (args.enabled !== undefined) existing.enabled = args.enabled as boolean;
          if (args.env !== undefined)
            existing.env = { ...existing.env, ...(args.env as Record<string, string>) };
          if (args.args !== undefined) existing.args = args.args as string[];
          if (args.tags !== undefined) existing.tags = args.tags as string[];
          if (args.description !== undefined) existing.description = args.description as string;
          return {
            result: { action: "update", server: name },
            commitMessage: `update server: ${name}`,
            changed: true,
          };
        });
      },
    },
    {
      def: {
        name: "am_undo",
        description:
          "Revert the last config change by reverting the most recent git commit in the agent-manager config repo.",
        inputSchema: { type: "object", properties: {} },
      },
      tier: "write-local",
      handler: async () => {
        const configDir = resolveConfigDir();

        let entries;
        try {
          entries = await gitLog(configDir, 2);
        } catch {
          throw new Error("Cannot read git log. Run `am init` first.");
        }

        if (entries.length < 2) {
          throw new Error("Nothing to undo — only the initial commit exists");
        }

        const headMsg = entries[0].message;
        const oid = await revertHead(configDir);
        return { action: "undo", reverted: headMsg, oid };
      },
    },
    {
      def: {
        name: "am_use_profile",
        description: "Switch the active profile.",
        inputSchema: {
          type: "object",
          properties: {
            profile: { type: "string", description: "Profile name to activate" },
          },
          required: ["profile"],
        },
      },
      tier: "write-local",
      handler: async (args) => {
        const configDir = resolveConfigDir();
        const configPath = join(configDir, "config.toml");
        const config = await readConfig(configPath);
        const profile = args.profile as string;

        const profiles = config.profiles ?? {};
        if (Object.keys(profiles).length > 0 && !profiles[profile]) {
          throw new Error(
            `Profile "${profile}" not found. Available: ${Object.keys(profiles).join(", ")}`,
          );
        }

        await writeActiveProfile(configDir, profile);
        return { action: "use", profile };
      },
    },
    {
      def: {
        name: "am_import",
        description:
          "Import existing MCP servers from an IDE's native config into agent-manager. Use 'auto' to scan all detected tools, or specify an adapter name. Skips servers that already exist in the catalog.",
        inputSchema: {
          type: "object",
          properties: {
            source: {
              type: "string",
              description: "Adapter name or 'auto' for all detected tools",
            },
          },
          required: ["source"],
        },
      },
      tier: "write-local",
      handler: async (args) => {
        const configDir = resolveConfigDir();
        const source = args.source as string;

        let adapters;
        if (source === "auto") {
          adapters = await getDetectedAdapters();
          if (adapters.length === 0) {
            return { action: "import", source, imported: 0, message: "No tools detected" };
          }
        } else {
          const adapter = await getAdapter(source);
          if (!adapter) {
            throw new Error(
              `Adapter "${source}" not found. Available: ${listAdapters().join(", ")}`,
            );
          }
          adapters = [adapter];
        }

        return withConfig(configDir, async (config) => {
          if (!config) throw new Error("Config not found. Run `am init` first.");
          let totalImported = 0;
          if (!config.servers) config.servers = {};

          for (const adapter of adapters) {
            try {
              const result = await adapter.import({ projectPath: process.cwd() });
              for (const srv of result.servers) {
                if (!config.servers[srv.name]) {
                  config.servers[srv.name] = {
                    command: srv.command,
                    args: srv.args,
                    env: srv.env,
                    transport: srv.transport ?? "stdio",
                    description: srv.description,
                    tags: srv.tags,
                    enabled: srv.enabled ?? true,
                  };
                  totalImported++;
                }
              }
            } catch {
              // Skip adapters that fail to import
            }
          }

          return {
            result: { action: "import", source, imported: totalImported },
            commitMessage:
              totalImported > 0 ? `import: ${source} (${totalImported} servers)` : undefined,
            changed: totalImported > 0,
          };
        });
      },
    },

    // ── Registry tools (read-only + write-local) ─────────────
    {
      def: {
        name: "am_registry_search",
        description:
          "Search the MCP registry for server packages. Returns package names, descriptions, versions, and install status.",
        inputSchema: {
          type: "object",
          properties: {
            query: { type: "string", description: "Search query" },
            tag: { type: "string", description: "Filter by tag" },
            verified: {
              type: "boolean",
              description: "Show only verified packages",
            },
            limit: {
              type: "number",
              description: "Max results (default: 20)",
            },
          },
          required: ["query"],
        },
      },
      tier: "read-only",
      handler: async (args) => {
        const { search } = await import("../registry/client");
        const filters: import("../registry/types").RegistrySearchFilters = {};
        if (args.tag) filters.tag = args.tag as string;
        if (args.verified) filters.verified = true;
        filters.limit = (args.limit as number) ?? 20;
        const result = await search(args.query as string, filters);
        return result;
      },
    },
    {
      def: {
        name: "am_registry_install",
        description:
          "Install an MCP server package from the registry into the agent-manager config. Resolves package metadata, adds the server entry, and auto-commits.",
        inputSchema: {
          type: "object",
          properties: {
            name: {
              type: "string",
              description: "Package name to install",
            },
            env: {
              type: "object",
              additionalProperties: { type: "string" },
              description: "Environment variable values for the server (key-value pairs)",
            },
          },
          required: ["name"],
        },
      },
      tier: "write-local",
      handler: async (args) => {
        const { getPackage: getPkg } = await import("../registry/client");
        const pkgName = args.name as string;
        const pkg = await getPkg(pkgName);
        if (!pkg) {
          throw new Error(
            `Package "${pkgName}" not found in the registry. Use am_registry_search to find available packages.`,
          );
        }

        const configDir = resolveConfigDir();
        return withConfig(configDir, async (config) => {
          if (!config) throw new Error("Config not found. Run `am init` first.");
          if (config.servers?.[pkg.name]) {
            throw new Error(
              `Server "${pkg.name}" already exists. Remove it first or use am_remove_server.`,
            );
          }

          const env: Record<string, string> = {};
          const providedEnv = (args.env as Record<string, string>) ?? {};
          for (const envVar of pkg.server.env ?? []) {
            if (providedEnv[envVar.name]) {
              env[envVar.name] = providedEnv[envVar.name];
            } else if (envVar.default) {
              env[envVar.name] = envVar.default;
            } else if (envVar.required) {
              env[envVar.name] = `\${${envVar.name}}`;
            }
          }

          if (!config.servers) config.servers = {};
          config.servers[pkg.name] = {
            command: pkg.server.command,
            ...(pkg.server.args ? { args: pkg.server.args } : {}),
            ...(Object.keys(env).length > 0 ? { env } : {}),
            transport: pkg.server.transport ?? "stdio",
            enabled: true,
            description: pkg.description,
            tags: pkg.tags,
            _registry: {
              source: "mcp-registry" as const,
              package: pkg.name,
              version: pkg.version,
              installed_at: new Date().toISOString(),
            },
          };

          return {
            result: {
              action: "install",
              package: pkg.name,
              version: pkg.version,
            },
            commitMessage: `registry install: ${pkg.name}`,
            changed: true,
          };
        });
      },
    },
    {
      def: {
        name: "am_registry_list_installed",
        description:
          "List all MCP servers that were installed from the registry, including their provenance metadata (package name, version, install date).",
        inputSchema: { type: "object", properties: {} },
      },
      tier: "read-only",
      handler: async () => {
        const { config } = await loadConfigAndProfile();
        const servers = config.servers ?? {};
        const installed: Array<{
          name: string;
          command: string;
          package: string;
          version: string;
          installed_at: string;
          enabled: boolean;
        }> = [];

        for (const [name, srv] of Object.entries(servers)) {
          const provenance = srv._registry;
          if (provenance?.source === "mcp-registry") {
            installed.push({
              name,
              command: srv.command,
              package: provenance.package,
              version: provenance.version,
              installed_at: provenance.installed_at,
              enabled: srv.enabled ?? true,
            });
          }
        }

        return { servers: installed, total: installed.length };
      },
    },

    // ── Write-remote tier ─────────────────────────────────────
    {
      def: {
        name: "am_apply",
        description:
          "Sync the agent-manager catalog to IDE-native config files (Claude Code, Cursor, etc.). WARNING: writes files outside the am config directory. Run after am_add_server or am_remove_server to propagate changes. Set dryRun=true to preview without writing. SEC-4b: this surface defaults to a fail-closed drift check — adapters whose native config has DRIFTED (or whose drift state cannot be read) are SKIPPED, not overwritten. Pass force=true to overwrite anyway.",
        inputSchema: {
          type: "object",
          properties: {
            target: {
              type: "string",
              description: "Apply to a specific adapter only (e.g., 'claude-code')",
            },
            dryRun: {
              type: "boolean",
              description: "Preview changes without writing files",
            },
            force: {
              type: "boolean",
              description:
                "Overwrite even if the native config has drifted from the catalog (bypasses the fail-closed drift gate). Default false.",
            },
          },
        },
      },
      tier: "write-local",
      handler: async (args) => {
        const configDir = resolveConfigDir();
        // SEC-4b: extend the CLI's fail-closed drift gate to the MCP surface.
        // An agent calling am_apply must NOT blindly clobber a native config a
        // human (or another tool) edited out of band — that is the 2026-04-15
        // `~/.claude.json` wipe class of bug. We default `diff: true` so the
        // controller runs `adapter.diff()` and SKIPS any adapter that is
        // drifted (or whose drift state cannot be read because diff() threw).
        // `force: true` is the explicit opt-in to overwrite, matching the CLI's
        // `--force`. dryRun previews regardless and is never gated.
        // Derive diff/force from the SHARED APPLY_SAFE_DEFAULTS so the
        // fail-closed posture lives in ONE place across all four surfaces
        // (CLI / MCP / web / TUI). `force=true` is the explicit per-call opt-in
        // to overwrite, matching the CLI's `--force`.
        const force = args.force === true ? true : APPLY_SAFE_DEFAULTS.force;
        const applyResult = await applyResolved(configDir, {
          dryRun: !!args.dryRun,
          target: args.target as string | undefined,
          diff: APPLY_SAFE_DEFAULTS.diff,
          force,
        });
        // Shape the response to the existing MCP contract (files count, not
        // full per-file list) and redact error messages. `skipped` surfaces the
        // fail-closed gate so the agent caller can see which adapters were NOT
        // written (and re-issue with force=true if it really means to).
        const results = applyResult.results.map((r) => ({
          adapter: r.adapter,
          files: r.files.filter((f) => f.written).length,
          warnings: r.error
            ? [safeErrorMessage(new Error(r.error)) || "export failed"]
            : r.warnings,
        }));
        return {
          action: "apply",
          profile: applyResult.profile,
          dryRun: applyResult.dryRun,
          results,
          skipped: applyResult.skipped,
        };
      },
    },
    {
      def: {
        name: "am_sync_push",
        description: "Push agent-manager config changes to the git remote.",
        inputSchema: { type: "object", properties: {} },
      },
      tier: "write-remote",
      handler: async () => {
        const { configDir } = await loadConfigAndProfile();

        const status = await getStatus(configDir);
        if (status.remotes.length === 0) {
          throw new Error("No remote configured. Add a remote URL to your config repo.");
        }

        await push(configDir);
        return { action: "push", remote: status.remotes[0].url, branch: status.branch };
      },
    },
    {
      def: {
        name: "am_sync_pull",
        description: "Pull agent-manager config changes from the git remote.",
        inputSchema: { type: "object", properties: {} },
      },
      tier: "write-remote",
      handler: async () => {
        const { configDir } = await loadConfigAndProfile();

        const status = await getStatus(configDir);
        if (status.remotes.length === 0) {
          throw new Error("No remote configured. Add a remote URL to your config repo.");
        }

        await pull(configDir);
        return { action: "pull", remote: status.remotes[0].url, branch: status.branch };
      },
    },

    // ── A2A Agent tools (ADR-0017) ──────────────────────────────
    {
      def: {
        name: "am_agent_discover",
        description:
          "Discover an A2A agent by fetching its Agent Card from a URL. Returns the agent's name, description, skills, and capabilities.",
        inputSchema: {
          type: "object",
          properties: {
            url: { type: "string", description: "Base URL of the A2A agent to discover" },
          },
          required: ["url"],
        },
      },
      tier: "read-only",
      handler: async (args) => {
        const { discoverFromUrl } = await import("../protocols/a2a/discovery");
        const url = args.url as string;
        const card = await discoverFromUrl(url);
        if (!card) {
          throw new Error(
            `No A2A Agent Card found at ${url}. Verify the URL serves a /.well-known/agent.json endpoint.`,
          );
        }
        return { card };
      },
    },
    {
      def: {
        name: "am_agent_list",
        description:
          "List all agents from the unified registry (config overrides, ACP built-in, A2A roster). Each entry shows which protocol(s) are available. Wave D: was A2A-roster-only, now returns the merged view.",
        inputSchema: { type: "object", properties: {} },
      },
      tier: "read-only",
      handler: async () => {
        const { listAllAgentsAsync } = await import("../core/agent-registry");
        const { config } = await loadConfigAndProfile();
        const configDir = resolveConfigDir();
        const agents = await listAllAgentsAsync(config, configDir);
        return {
          // REV-4 HIGH-2 fix: include tier + runnable so MCP consumers
          // (LLM agents routing via am_agent_invoke) can tell which agents
          // will actually spawn vs which will return a refusal.
          agents: agents.map((a) => ({
            name: a.name,
            description: a.description ?? null,
            source: a.source,
            protocol: a.acp && a.a2a ? "both" : a.acp ? "acp" : "a2a",
            acp: a.acp ?? null,
            a2a: a.a2a ?? null,
            tier: a.tier ?? null,
            runnable: a.runnable ?? Boolean(a.acp || a.a2a),
            installed: a.installed ?? null,
          })),
          total: agents.length,
        };
      },
    },
    {
      def: {
        name: "am_agent_delegate",
        description:
          "[DEPRECATED — use am_agent_invoke] Send a task to a registered A2A agent. Returns immediately with a task ID while the agent works asynchronously. Use am_agent_task_status to poll for completion.",
        inputSchema: {
          type: "object",
          properties: {
            name: { type: "string", description: "Agent name from the roster" },
            message: { type: "string", description: "Task message to send to the agent" },
          },
          required: ["name", "message"],
        },
      },
      tier: "write-remote",
      handler: async (args, ctx) => {
        warnDeprecated("am_agent_delegate", "am_agent_invoke");
        // Route through the unified invoke implementation so we get streaming
        // and registry resolution for free. Map {name,message} → {agent,prompt}.
        return invokeAgentImpl(
          { agent: args.name, prompt: args.message, deprecated: "am_agent_delegate" },
          ctx,
        );
      },
    },
    {
      def: {
        name: "am_agent_task_status",
        description: "Query the status of a previously delegated A2A task.",
        inputSchema: {
          type: "object",
          properties: {
            name: { type: "string", description: "Agent name from the roster" },
            taskId: { type: "string", description: "Task ID returned from am_agent_delegate" },
          },
          required: ["name", "taskId"],
        },
      },
      tier: "read-only",
      handler: async (args) => {
        const { loadRoster } = await import("../protocols/a2a/discovery");
        const { A2AClient } = await import("../protocols/a2a/client");
        const configDir = resolveConfigDir();
        const roster = await loadRoster(configDir);
        const name = args.name as string;
        const taskId = args.taskId as string;

        const entry = roster.find((r) => r.name === name);
        if (!entry) {
          throw new Error(
            `Agent "${name}" not found in roster. Use am_agent_list to see registered agents.`,
          );
        }

        const client = new A2AClient({ timeout: 30_000 });
        const result = await client.getTask(entry.url, { id: taskId });
        return { agent: name, task: result };
      },
    },

    // ── Wiki tools (ADR-0020) ─────────────────────────────────
    {
      def: {
        name: "am_wiki_search",
        description:
          "Search the LLM Wiki knowledge base. Returns matching entries ranked by relevance.",
        inputSchema: {
          type: "object",
          properties: {
            query: { type: "string", description: "Search query" },
            limit: {
              type: "number",
              description: "Maximum results to return (default: 20)",
            },
          },
          required: ["query"],
        },
      },
      tier: "read-only",
      handler: async (args) => {
        const { searchEntries } = await import("../wiki/storage");
        const query = args.query as string;
        const limit = (args.limit as number) ?? 20;
        const entries = await searchEntries(query);
        return { query, results: entries.slice(0, limit), total: entries.length };
      },
    },
    {
      def: {
        name: "am_wiki_add",
        description:
          "Add a knowledge entry to the LLM Wiki. Supports types: fact, procedure, preference, relationship, capability.",
        inputSchema: {
          type: "object",
          properties: {
            entity_type: {
              type: "string",
              enum: ["fact", "procedure", "preference", "relationship", "capability"],
              description: "Entity type",
            },
            content: { type: "string", description: "Entry content" },
            context: { type: "string", description: "Optional context" },
            tags: {
              type: "array",
              items: { type: "string" },
              description: "Tags for categorization",
            },
            confidence: {
              type: "number",
              description: "Confidence score 0.0-1.0 (default: 0.7)",
            },
          },
          required: ["entity_type", "content"],
        },
      },
      tier: "write-local",
      handler: async (args) => {
        const { addEntry, resolveWikiDir } = await import("../wiki/storage");
        const now = new Date().toISOString();
        const entry = {
          id: crypto.randomUUID(),
          source: { type: "manual" as const, timestamp: now },
          extracted_at: now,
          confidence: (args.confidence as number) ?? 0.7,
          entity_type: args.entity_type as
            | "fact"
            | "procedure"
            | "preference"
            | "relationship"
            | "capability",
          content: args.content as string,
          context: (args.context as string) ?? "",
          tags: (args.tags as string[]) ?? [],
          references: [],
          provenance: {
            created_by: "mcp",
            created_at: now,
            last_modified: now,
            modification_history: [
              {
                timestamp: now,
                action: "created" as const,
                by: "mcp",
                details: "Added via MCP tool",
              },
            ],
            verified: false,
          },
        };
        await addEntry(entry);
        // W1-3: surface the local-first visibility boundary (ADR-0044). When the
        // entry landed in a PROJECT-local wiki, it is NOT visible to
        // `am wiki search --all-projects` until `am wiki publish <slug>` mirrors
        // it into wiki/projects/<name>/. Agents are the primary wiki writers, so
        // they get the same {scope, visibleAcrossProjects} signal the CLI emits.
        const visibleAcrossProjects = resolveWikiDir() === resolveWikiDir({ global: true });
        return {
          action: "add",
          id: entry.id,
          entity_type: entry.entity_type,
          title: entry.content.split("\n")[0].slice(0, 120),
          scope: visibleAcrossProjects ? "global" : "project-local",
          visibleAcrossProjects,
          ...(visibleAcrossProjects
            ? {}
            : {
                hint: "This entry is project-local. Run `am wiki publish <slug>` to make it visible to `am wiki search --all-projects` from other projects.",
              }),
        };
      },
    },
    {
      def: {
        name: "am_wiki_synthesize",
        description:
          "Generate a markdown summary of relevant knowledge entries for a topic. Use this to build context for an agent before starting a task.",
        inputSchema: {
          type: "object",
          properties: {
            query: { type: "string", description: "Topic or question" },
            agent_id: { type: "string", description: "Filter to a specific agent" },
            top_k: {
              type: "number",
              description: "Number of entries to include (default: 10)",
            },
          },
          required: ["query"],
        },
      },
      tier: "read-only",
      handler: async (args) => {
        const { synthesizeContext } = await import("../wiki/synthesizer");
        const context = await synthesizeContext(args.query as string, {
          agentId: args.agent_id as string | undefined,
          topK: (args.top_k as number) ?? 10,
        });
        return { query: args.query, context };
      },
    },
    {
      def: {
        name: "am_wiki_briefing",
        description:
          "Generate an agent briefing from the knowledge base. Returns a markdown document with facts, procedures, preferences, and gaps.",
        inputSchema: {
          type: "object",
          properties: {
            agent_id: { type: "string", description: "Agent/adapter ID" },
          },
          required: ["agent_id"],
        },
      },
      tier: "read-only",
      handler: async (args) => {
        const { getAllEntries } = await import("../wiki/storage");
        const { buildAgentBriefing } = await import("../wiki/synthesizer");
        const entries = await getAllEntries();
        const briefing = buildAgentBriefing(entries, args.agent_id as string);
        return { agent_id: args.agent_id, briefing };
      },
    },
    {
      def: {
        name: "am_wiki_harvest",
        description:
          "Extract facts, procedures, preferences, and capabilities from a completed coding session and store them in the wiki. Use am_session_list to find session IDs.",
        inputSchema: {
          type: "object",
          properties: {
            adapter: {
              type: "string",
              description: "Adapter name (e.g., 'claude-code', 'codex-cli')",
            },
            session_id: { type: "string", description: "Session ID within the adapter" },
          },
          required: ["adapter", "session_id"],
        },
      },
      tier: "write-local",
      handler: async (args) => {
        const adapterName = args.adapter as string;
        const sessionId = args.session_id as string;

        const adapter = await getAdapter(adapterName);
        if (!adapter?.sessionReader) {
          throw new Error(
            `Adapter "${adapterName}" does not support session reading. Use am_session_list to find adapters with session data.`,
          );
        }

        const session = await adapter.sessionReader.loadSession(sessionId);
        if (!session) {
          throw new Error(
            `Session "${sessionId}" not found in ${adapterName}. Use am_session_list with adapter="${adapterName}" to see valid session IDs.`,
          );
        }

        const { harvestSession } = await import("../wiki/harvester");
        const { addEntry } = await import("../wiki/storage");
        const entries = await harvestSession(session);
        let added = 0;
        for (const entry of entries) {
          try {
            await addEntry(entry);
            added++;
          } catch {
            // Skip duplicates
          }
        }

        return {
          action: "harvest",
          adapter: adapterName,
          session_id: sessionId,
          entries_extracted: entries.length,
          entries_added: added,
        };
      },
    },

    // ── ACP tools (ADR-0026 Phase 2) ─────────────────────────────
    {
      def: {
        name: "am_run_agent",
        description:
          "[DEPRECATED — use am_agent_invoke] Run a prompt against an ACP-compatible coding agent.",
        inputSchema: {
          type: "object",
          properties: {
            agent: {
              type: "string",
              description: "Agent name (e.g., 'claude', 'codex', 'gemini')",
            },
            prompt: { type: "string", description: "Prompt text to send to the agent" },
            session: {
              type: "string",
              description:
                "Named session to create or resume. If omitted, a new anonymous session is created.",
            },
            cwd: {
              type: "string",
              description:
                "Working directory for the agent session. Defaults to current working directory.",
            },
          },
          required: ["agent", "prompt"],
        },
      },
      tier: "write-remote" as ToolTier,
      handler: async (args, ctx) => {
        warnDeprecated("am_run_agent", "am_agent_invoke");
        return invokeAgentImpl(args, ctx);
      },
    },
    {
      def: {
        name: "am_acp_list_agents",
        description:
          "[DEPRECATED — use am_agent_list] List all agents from the unified registry (config overrides, ACP built-in, A2A roster). Shows protocol availability (ACP/A2A/both).",
        inputSchema: { type: "object", properties: {} },
      },
      tier: "read-only" as ToolTier,
      handler: async () => {
        warnDeprecated("am_acp_list_agents", "am_agent_list");
        const { listAllAgentsAsync } = await import("../core/agent-registry");
        const { config } = await loadConfigAndProfile();
        const configDir = resolveConfigDir();
        const agents = await listAllAgentsAsync(config, configDir);
        return {
          agents: agents.map((a) => ({
            name: a.name,
            description: a.description ?? null,
            source: a.source,
            protocol: a.acp && a.a2a ? "both" : a.acp ? "acp" : "a2a",
            acp: a.acp ?? null,
            a2a: a.a2a ?? null,
          })),
        };
      },
    },
    {
      def: {
        name: "am_acp_session_list",
        description:
          "[DEPRECATED — use am_agent_session_list] List active LIVE ACP sessions from the session directory (agent subprocesses currently running or persisted).",
        inputSchema: { type: "object", properties: {} },
      },
      tier: "read-only" as ToolTier,
      handler: async (args) => {
        warnDeprecated("am_acp_session_list", "am_agent_session_list");
        return listAgentSessionsImpl(args);
      },
    },
    {
      def: {
        name: "am_acp_session_cancel",
        description:
          "[DEPRECATED — use am_agent_session_cancel] Cancel an active ACP session by session ID. Calls the ACP cancel RPC (if the session is live) and removes persisted state.",
        inputSchema: {
          type: "object",
          properties: {
            sessionId: { type: "string", description: "Session ID to cancel" },
          },
          required: ["sessionId"],
        },
      },
      tier: "write-remote" as ToolTier,
      handler: async (args, ctx) => {
        warnDeprecated("am_acp_session_cancel", "am_agent_session_cancel");
        return cancelSessionImpl(args, ctx);
      },
    },

    // ── Wave D unified agent tools ──────────────────────────────
    {
      def: {
        name: "am_agent_invoke",
        description:
          "Invoke an agent with a prompt. Routes to ACP (local subprocess) if the agent resolves via built-in/config.acp, or A2A (remote HTTP) via roster/config.a2a. Supports streaming via notifications/progress when params._meta.progressToken is set. Blocking otherwise.",
        inputSchema: {
          type: "object",
          properties: {
            agent: { type: "string", description: "Agent name from am_agent_list." },
            prompt: {
              oneOf: [
                { type: "string", description: "Prompt text." },
                {
                  type: "object",
                  properties: {
                    messages: {
                      type: "array",
                      items: {
                        type: "object",
                        properties: {
                          role: { type: "string" },
                          content: { type: "string" },
                        },
                        required: ["content"],
                      },
                    },
                  },
                  required: ["messages"],
                },
              ],
            },
            session: {
              type: "string",
              description: "Named session to create or resume. Omit for anonymous.",
            },
            stream: {
              type: "boolean",
              description:
                "Request progress notifications. Only meaningful when params._meta.progressToken is also set.",
            },
            cwd: {
              type: "string",
              description: "Working directory for ACP agents (ignored for A2A).",
            },
            timeout: { type: "number", description: "Overall timeout in ms. Default: 120000." },
          },
          required: ["agent", "prompt"],
        },
      },
      tier: "write-remote" as ToolTier,
      handler: async (args, ctx) => invokeAgentImpl(args, ctx),
    },
    {
      def: {
        name: "am_agent_session_list",
        description:
          "List active sessions across ACP and A2A backends. With no agent filter, returns every tracked session across all agents. With agent=<name>, limits to that agent. Merges the in-memory active registry with on-disk ACP session directory entries.",
        inputSchema: {
          type: "object",
          properties: {
            agent: {
              type: "string",
              description: "Optional: limit to a specific agent name.",
            },
          },
        },
      },
      tier: "read-only" as ToolTier,
      handler: async (args) => listAgentSessionsImpl(args),
    },
    {
      def: {
        name: "am_agent_session_cancel",
        description:
          "Cancel an active agent session. Routes to ACP or A2A based on the active session registry. For ACP this calls the spec'd cancel RPC THEN removes persisted state; for A2A it calls tasks/cancel. If the connection is already gone, silently rms the persisted dir (no error).",
        inputSchema: {
          type: "object",
          properties: {
            sessionId: { type: "string", description: "Session ID to cancel" },
            agent: { type: "string", description: "Optional: agent name for disambiguation." },
          },
          required: ["sessionId"],
        },
      },
      tier: "write-remote" as ToolTier,
      handler: async (args, ctx) => cancelSessionImpl(args, ctx),
    },
    {
      def: {
        name: "am_agent_status",
        description:
          "Return the status of an in-flight or recently-terminated agent session. { sessionId } → { state, lastUpdate, agent }.",
        inputSchema: {
          type: "object",
          properties: {
            sessionId: { type: "string" },
            agent: { type: "string" },
          },
          required: ["sessionId"],
        },
      },
      tier: "read-only" as ToolTier,
      handler: async (args) => {
        const sessionId = args.sessionId as string;
        const entry = activeSessions.get(sessionId);
        if (entry) {
          return {
            sessionId,
            agent: entry.agent,
            state: "active",
            lastUpdate: new Date().toISOString(),
            backend: entry.kind,
          };
        }
        return {
          sessionId,
          agent: (args.agent as string) ?? null,
          state: "unknown",
          lastUpdate: null,
          backend: null,
        };
      },
    },
    {
      def: {
        name: "am_agent_detect",
        description:
          "Detect which ACP/A2A agents are available on this host. Combines the unified agent registry with PATH + adapter-derived liveness signals for local install. Returns `locallyInstalled` (true/false/null) — scoped to local ACP install only; it does NOT probe A2A remote endpoints. For agents with A2A endpoints, use `am_agent_status` or `am_agent_invoke` to probe remote reachability. NOTE (2026-05-02): the legacy field `reachable` is emitted alongside `locallyInstalled` for one release of backward compatibility. Consumers should migrate to `locallyInstalled`; `reachable` will be removed in v0.6.",
        inputSchema: { type: "object", properties: {} },
      },
      tier: "read-only" as ToolTier,
      handler: async () => {
        const { listAllAgentsAsync } = await import("../core/agent-registry");
        const { detectAllAgents } = await import("../core/agent-detection");
        const { config } = await loadConfigAndProfile();
        const configDir = resolveConfigDir();
        const [agents, installMap] = await Promise.all([
          listAllAgentsAsync(config, configDir),
          detectAllAgents(),
        ]);
        return {
          detected: agents.map((a) => {
            const install = installMap[a.name];
            const locallyInstalled = install ? install.installed : null;
            return {
              name: a.name,
              source: a.source,
              protocol: a.acp && a.a2a ? "both" : a.acp ? "acp" : "a2a",
              // Scoped strictly to LOCAL install (PATH + adapter detect).
              // For A2A remote reachability, callers must invoke am_agent_status
              // or attempt am_agent_invoke. Renamed from `reachable` to prevent
              // callers conflating "local install present" with "remote endpoint up".
              locallyInstalled,
              // CODEX-4 (2026-05-02): emit the legacy `reachable` field with
              // the same value for one release of backward compatibility.
              // Existing MCP consumers that parse `.reachable` continue to
              // work; they migrate to `locallyInstalled` at leisure. This
              // field will be removed in v0.6 — track via a future ADR.
              reachable: locallyInstalled,
              // Extra signal for callers that want to distinguish HOW the
              // detection fired. Absent when locallyInstalled is null.
              ...(install
                ? {
                    installVia: install.source,
                    ...(install.binary ? { binary: install.binary } : {}),
                    ...(install.version ? { version: install.version } : {}),
                    ...(install.tier ? { tier: install.tier } : {}),
                  }
                : {}),
            };
          }),
        };
      },
    },
  ];
}

// ── Wave D unified-tool handler implementations ─────────────────
//
// Extracted so that deprecated aliases can share the same handler without
// duplicating the logic. All three take (args, ctx); ctx.emitProgress is
// a no-op when no progressToken was supplied.

async function invokeAgentImpl(args: Record<string, unknown>, ctx: ToolContext): Promise<unknown> {
  const { resolveAgentAsync } = await import("../core/agent-registry");
  const agentName = args.agent as string;
  const sessionName = args.session as string | undefined;
  const cwd = (args.cwd as string) ?? process.cwd();
  const streamRequested = Boolean(args.stream) || ctx.progressToken !== undefined;

  // Flatten prompt into a single text string. Structured prompts get joined
  // with blank lines so the underlying ACP/A2A transport sees one cohesive
  // prompt. This is intentionally lossy — more sophisticated multi-message
  // routing lands in a follow-up once we define a per-transport contract.
  let promptText: string;
  const rawPrompt = args.prompt;
  if (typeof rawPrompt === "string") {
    promptText = rawPrompt;
  } else if (
    rawPrompt &&
    typeof rawPrompt === "object" &&
    Array.isArray((rawPrompt as { messages?: unknown }).messages)
  ) {
    const messages = (rawPrompt as { messages: Array<{ role?: string; content: string }> })
      .messages;
    promptText = messages
      .map((m) => (m.role ? `[${m.role}] ${m.content}` : m.content))
      .join("\n\n");
  } else {
    throw new Error("prompt must be a string or an object with a messages array.");
  }

  const { config } = await loadConfigAndProfile();
  const configDir = resolveConfigDir();
  const entry = await resolveAgentAsync(agentName, config, configDir);
  if (!entry) {
    throw new Error(
      `Unknown agent "${agentName}". Use am_agent_detect or am_agent_list to see available agents.`,
    );
  }

  // ADR-0033 / REV-1 #7 / REV-4 HIGH-1: tier-2 shims (not yet enabled) get a
  // recovery-path hint; tier-3 catalog-only get the no-recovery message.
  const { isCatalogOnly, isShimNotEnabled, shimNotEnabledMessage, tierRefusalMessage } =
    await import("../core/agent-registry");
  if (isShimNotEnabled(entry)) {
    throw new Error(shimNotEnabledMessage(agentName));
  }
  if (isCatalogOnly(entry)) {
    throw new Error(tierRefusalMessage(agentName));
  }

  // ── Route: prefer ACP when both available (local-first per ADR-0031).
  if (entry.acp) {
    const { createAcpClient } = await import("../protocols/acp/client");
    const client = createAcpClient();
    // am_run_agent / am_agent_invoke is headless by design (MCP tool — no
    // human-in-the-loop). Explicitly opt into auto-approve rather than
    // inheriting the class secure-by-default "deny" (2026-05-02).
    client.setPermissionPolicy("auto-approve");
    // CODEX-12 (2026-05-02): also restrict FS to cwd, matching bridge HIGH-2.
    // Without this, auto-approve mode leaves FS unrestricted — a malicious
    // or compromised agent can readTextFile / writeTextFile anywhere on disk.
    client.setAllowedPaths([cwd]);

    // CODEX-11 (2026-05-02): sessionId MUST come from the ACP server via
    // newSession(). Previously the code invented a local ID at this point
    // and discarded newSession()'s return value — subsequent prompt() +
    // cancel + status operations couldn't find the session. We still accept
    // a caller-supplied `sessionName` for client-side tracking, but the ACP
    // transport always uses the server-assigned ID.
    let serverSessionId: string | undefined;

    // Wire progress: ACP emits onSessionUpdate for every chunk/tool call.
    // We forward those as notifications/progress when streaming is requested.
    // The sessionId reported to the caller is the caller's preferred name
    // (for tracking) when provided; otherwise it's the server-assigned ID.
    if (streamRequested) {
      client.onSessionUpdate((update: unknown) => {
        ctx.emitProgress({
          message: {
            kind: "acp.session_update",
            sessionId: sessionName ?? serverSessionId ?? "pending",
            agent: agentName,
            data: update,
          },
        });
      });
    }

    const trackingId = sessionName ?? `am-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    try {
      await client.connect(entry.acp.command);
      // Register BEFORE newSession so a concurrent cancel sees the entry
      // even if we haven't learned the server ID yet. Re-set with
      // serverSessionId once newSession resolves so cancelSessionImpl
      // routes to the server-assigned ID (CODEX-11 final-signoff fix).
      activeSessions.set(trackingId, {
        kind: "acp",
        agent: agentName,
        client,
      });
      serverSessionId = await client.newSession({ cwd });
      activeSessions.set(trackingId, {
        kind: "acp",
        agent: agentName,
        serverSessionId,
        client,
      });
      const result = await client.prompt(serverSessionId, [{ type: "text", text: promptText }]);
      return {
        // Expose BOTH identifiers so callers tracking by name can cancel
        // and the server-authoritative ID is inspectable for debugging.
        sessionId: trackingId,
        serverSessionId,
        agent: agentName,
        protocol: "acp",
        result: result.text,
        stopReason: result.stopReason,
        toolCalls: result.toolCalls.map((tc) => ({
          name: (tc as Record<string, unknown>).name ?? "unknown",
        })),
        streamed: streamRequested,
      };
    } finally {
      activeSessions.delete(trackingId);
      await client.disconnect().catch(() => {});
    }
  }

  // ── Route: A2A
  if (entry.a2a) {
    const { A2AClient } = await import("../protocols/a2a/client");
    const timeout = (args.timeout as number | undefined) ?? 120_000;
    const client = new A2AClient({ timeout });
    const sessionId =
      sessionName ?? `am-a2a-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const baseUrl = entry.a2a.url;
    // CODEX-11 parity for A2A: register on the local sessionId, then re-set the
    // entry with the server-authoritative task id once the server responds. A
    // strict A2A v0.3 server mints its own task id and ignores the one we send;
    // cancelTask/getTask MUST then use the server's id or they silently target
    // a task the remote never saw. Helper keeps the activeSessions entry in
    // sync as we learn the id.
    const rememberServerTaskId = (serverTaskId: string | undefined) => {
      if (!serverTaskId) return;
      activeSessions.set(sessionId, { kind: "a2a", agent: agentName, baseUrl, serverTaskId });
    };
    activeSessions.set(sessionId, {
      kind: "a2a",
      agent: agentName,
      baseUrl,
    });

    try {
      if (streamRequested) {
        // sendSubscribe streams SSE events — forward each as a progress notif.
        // Its resolved value is the final TaskStatusUpdateEvent, whose `.id` is
        // the server-authoritative task id.
        const finalEvent = await client.sendSubscribe(
          baseUrl,
          {
            id: sessionId,
            message: { role: "user", parts: [{ type: "text", text: promptText }] },
          },
          {
            onStatus: (ev) =>
              ctx.emitProgress({ message: { kind: "a2a.status", sessionId, data: ev } }),
            onArtifact: (ev) =>
              ctx.emitProgress({ message: { kind: "a2a.artifact", sessionId, data: ev } }),
          },
        );
        const serverTaskId = finalEvent.id;
        rememberServerTaskId(serverTaskId);
        // sendSubscribe resolves on stream close; fetch final task state for
        // result body. Use the SERVER task id — a strict server never knew our
        // local sessionId, so getTask({id:sessionId}) would 404/-32001.
        const finalTask = await client.getTask(baseUrl, { id: serverTaskId ?? sessionId });
        return {
          sessionId,
          serverTaskId,
          agent: agentName,
          protocol: "a2a",
          result: JSON.stringify(finalTask),
          streamed: true,
        };
      }
      const task = await client.sendTask(baseUrl, {
        id: sessionId,
        message: { role: "user", parts: [{ type: "text", text: promptText }] },
      });
      rememberServerTaskId(task.id);
      return {
        sessionId,
        serverTaskId: task.id,
        agent: agentName,
        protocol: "a2a",
        result: JSON.stringify(task),
        streamed: false,
      };
    } finally {
      activeSessions.delete(sessionId);
    }
  }

  throw new Error(
    `Agent "${agentName}" has neither an ACP nor A2A endpoint. Use am_agent_detect to verify registry state.`,
  );
}

async function listAgentSessionsImpl(args: Record<string, unknown>): Promise<unknown> {
  const agentFilter = args.agent as string | undefined;
  const { readdir, stat } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const { config } = await loadConfigAndProfile();
  const sessionDir = config.settings?.acp?.session_dir ?? join(resolveConfigDir(), "sessions");

  const sessions: Array<{
    id: string;
    agent: string;
    backend: "acp" | "a2a" | "disk";
    state: string;
    created?: string;
  }> = [];

  // 1. In-memory active sessions (authoritative).
  for (const [id, entry] of activeSessions.entries()) {
    if (agentFilter && entry.agent !== agentFilter) continue;
    sessions.push({
      id,
      agent: entry.agent,
      backend: entry.kind,
      state: "active",
    });
  }

  // 2. Persisted on-disk ACP sessions (fallback if not live).
  try {
    const entries = await readdir(sessionDir);
    const seen = new Set(sessions.map((s) => s.id));
    for (const entry of entries) {
      if (seen.has(entry)) continue;
      try {
        const info = await stat(join(sessionDir, entry));
        sessions.push({
          id: entry,
          agent: "unknown",
          backend: "disk",
          state: "persisted",
          created: info.birthtime.toISOString(),
        });
      } catch {
        // skip
      }
    }
  } catch {
    // session dir missing — that's fine
  }

  return { sessions, total: sessions.length };
}

async function cancelSessionImpl(
  args: Record<string, unknown>,
  _ctx: ToolContext,
): Promise<unknown> {
  const sessionId = args.sessionId as string;
  const { rm } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const { config } = await loadConfigAndProfile();
  const sessionDir = config.settings?.acp?.session_dir ?? join(resolveConfigDir(), "sessions");

  // Path traversal guard first — defence in depth.
  const sessionPath = resolveSessionPathSafely(sessionDir, sessionId);

  // 1. If the session is live, call the spec'd cancel RPC on the right backend.
  //    This is THE BUG FIX: the legacy handler only rm'd the dir. The new
  //    flow calls the protocol cancel first, then removes persisted state.
  const entry = activeSessions.get(sessionId);
  let cancelled = false;
  if (entry) {
    if (entry.kind === "acp") {
      try {
        // CODEX-11 final-signoff fix: the ACP server only knows its own
        // session ID. The `sessionId` argument may be the caller's local
        // tracking ID (am-${Date.now()}-...) which the server has never
        // seen. Use the server-assigned ID when registered, fall back to
        // the lookup key for pre-CODEX-11 entries that don't have one.
        const cancelId = entry.serverSessionId ?? sessionId;
        await entry.client.cancel(cancelId);
        cancelled = true;
      } catch (err) {
        // Cancel RPC failed (agent crashed, stream already closed, etc.).
        // Don't abandon the rm — proceed to the filesystem cleanup step
        // so the session isn't orphaned. Surface error info in response.
        cancelled = false;
        // Attach err for callers that want to inspect it (stringified).
        (entry as unknown as { _cancelError?: string })._cancelError =
          err instanceof Error ? err.message : String(err);
      }
    } else if (entry.kind === "a2a") {
      try {
        const { A2AClient } = await import("../protocols/a2a/client");
        const client = new A2AClient({ timeout: 30_000 });
        // CODEX-11 parity: cancel with the server-authoritative task id when we
        // captured one (strict A2A v0.3 mints its own id). Fall back to the
        // local sessionId only for non-strict servers / pre-response entries —
        // using sessionId against a strict server makes cancelTask a silent
        // no-op (the remote never saw that id and swallows -32001).
        const cancelId = entry.serverTaskId ?? sessionId;
        await client.cancelTask(entry.baseUrl, { id: cancelId });
        cancelled = true;
      } catch {
        cancelled = false;
      }
    }
    activeSessions.delete(sessionId);
  }

  // 2. Remove persisted state (always attempted; silent if absent).
  let removed = false;
  try {
    await rm(sessionPath, { recursive: true });
    removed = true;
  } catch {
    // Session dir absent: fine if we already cancelled via RPC; otherwise
    // this is the legacy "session not found" error signal.
    if (!cancelled) {
      throw new Error(
        `Session "${sessionId}" not found. Use am_agent_session_list to see active sessions.`,
      );
    }
  }

  return {
    action: "cancel",
    sessionId,
    status: "cancelled",
    cancelled, // true if protocol cancel RPC succeeded
    removed, // true if persisted dir was removed
  };
}

// ── MCP Server class ────────────────────────────────────────────

export class McpServer {
  private tools: ToolEntry[];
  private settings?: Settings;
  /** Auth config (Wave 2.B): tokens + unsafe-local flag. */
  private auth: AuthConfig;
  /**
   * ADR-0055 Decision 3: the profile name supplied by THIS connection, read at
   * `initialize` time from `params.capabilities.experimental['am.profile']`
   * (spec-legal experimental capability) or the `AM_MCP_PROFILE` env fallback.
   * stdio is one-client-per-process, so a connection-scoped profile is a
   * process-scoped profile. `undefined` ⇒ fall back to the active/default
   * profile resolved from state.toml + settings.default_profile.
   */
  private connectionProfile?: string;
  /**
   * ADR-0055: the resolved runtime Scope for the active profile, recomputed by
   * `refreshSettings`. `undefined` ⇒ no profile narrowing (global ceiling only).
   */
  private scope?: ResolvedScope;
  /**
   * Wave D: sink for `notifications/progress` emitted during tool calls.
   * Default sink writes newline-delimited JSON-RPC to stdout — matches the
   * format of the `serve()` loop. Tests override this to capture
   * notifications in memory.
   */
  private progressSink: ProgressSink = (notif) => {
    try {
      process.stdout.write(`${JSON.stringify(notif)}\n`);
    } catch {
      // Best-effort: a broken stdout shouldn't crash the tool call.
    }
  };

  /** Install a custom progress sink. Returns a restore function. */
  setProgressSink(sink: ProgressSink): () => void {
    const prev = this.progressSink;
    this.progressSink = sink;
    return () => {
      this.progressSink = prev;
    };
  }

  /**
   * Wave C: per-session initialization state. Per MCP spec the client MUST
   * send `initialize` before any other request (notifications excluded, and
   * `ping` is explicitly carved out). We track whether we have seen a
   * successful `initialize` and gate all other method dispatch on it.
   *
   * Defaults to `true` for in-process construction — tests and programmatic
   * callers that bypass the stdio handshake shouldn't have to simulate
   * initialize. The stdio `serve()` loop explicitly resets this to `false`
   * at the start of each session so that the wire-level handshake is
   * enforced for real clients. See also `skipInitGate` constructor option.
   */
  private initialized = true;

  /** Expose initialize state for tests. */
  isInitialized(): boolean {
    return this.initialized;
  }

  /** Reset initialize state — useful for tests that reuse an instance. */
  resetInitialized(): void {
    this.initialized = false;
  }

  // ── WAVE C: AUTH CONFIG ENTRY POINT ────────────────────────────
  // Wave B (2026-04-16) flipped the default to strict. Any caller that
  // instantiates `new McpServer()` with no arguments now gets a locked-down
  // server that refuses every write-tier tool call. Callers that need the
  // previous permissive behaviour (in-process consumers, tests) MUST pass
  // `{ auth: { token: undefined, allowUnsafeLocal: true } }` explicitly.
  //
  // Rationale: "secure by default" — `am mcp-serve` wires strict mode from
  // `loadAuthConfig()`, but previously any other instantiation (programmatic
  // use, test helpers, future integrations) silently bypassed the gate.
  //
  // Wave C (2026-04-16) adds protocol conformance gates that live alongside
  // the auth check: JSON-RPC envelope validation, init-state gating,
  // protocolVersion negotiation, and batch id deduplication. See
  // handleRequest and serve below for entry points.
  constructor(opts?: { auth?: AuthConfig; enforceInitGate?: boolean }) {
    this.tools = defineTools();
    // Secure default: no token, no unsafe-local escape hatch. Write-tier tool
    // calls are refused until the caller wires an AuthConfig explicitly.
    this.auth = opts?.auth ?? { token: undefined, allowUnsafeLocal: false };
    // enforceInitGate flips the session state to "not yet initialized" so
    // pre-handshake requests are rejected. The stdio `serve()` entry point
    // sets this automatically; in-process callers (tests, programmatic
    // use) default to already-initialized so they don't need to simulate
    // the handshake.
    if (opts?.enforceInitGate) this.initialized = false;
  }

  /** Override auth config (useful for tests). */
  setAuth(auth: AuthConfig): void {
    this.auth = auth;
  }

  /** Expose auth config (useful for tests). */
  getAuth(): AuthConfig {
    return this.auth;
  }

  /** Re-read settings from config for fresh permission checks, and recompute
   * the active profile's runtime Scope (ADR-0055). */
  private async refreshSettings(): Promise<void> {
    try {
      const configDir = resolveConfigDir();
      const projectFile = resolveProjectConfig(process.cwd());
      const config = await loadResolvedConfig({ configDir, projectFile });
      this.settings = config.settings;
      this.scope = await this.resolveActiveScope(config, configDir);
    } catch {
      // Keep existing settings if re-read fails
    }
  }

  /**
   * ADR-0055: resolve the runtime Scope for the active profile. Active profile
   * precedence: this connection's `am.profile` (initialize) → the persisted
   * active profile (state.toml) → settings.default_profile → "default".
   *
   * Fail-safe directions (an access boundary must NEVER widen):
   *  - Profile NAME absent from config.profiles (typo, implicit "default" with
   *    no profiles table, removed profile): return `undefined` = the global
   *    ceiling unchanged (today's behaviour). There is no declared boundary to
   *    enforce, so we don't invent a narrower one.
   *  - Profile EXISTS but `resolveProfile` THROWS (unknown `inherits` parent, or
   *    circular inheritance — K-CRIT): the profile is structurally broken. We do
   *    NOT fail open to `undefined` (that would expose the full ceiling and
   *    silently void a confinement profile whose `inherits` has a typo). Fail
   *    CLOSED to a maximally-restrictive scope so a broken boundary enforces
   *    EVERYTHING-denied, never nothing.
   *  - Profile resolves cleanly: use its declared scope (`undefined` if it
   *    declares none).
   */
  private async resolveActiveScope(
    config: Config,
    configDir: string,
  ): Promise<ResolvedScope | undefined> {
    const profileName =
      this.connectionProfile ??
      (await readActiveProfile(configDir)) ??
      config.settings?.default_profile ??
      "default";
    if (!config.profiles?.[profileName]) {
      // No such profile → no declared boundary → global ceiling (never wider).
      return undefined;
    }
    try {
      return resolveProfile(profileName, config).scope;
    } catch {
      // The named profile exists but its inheritance chain is broken. Fail
      // CLOSED: an empty tool_groups narrows every group out (isToolInScope
      // rule 4), so the broken confinement profile exposes nothing rather than
      // the full ceiling. K-CRIT: never widen on a resolve failure.
      return { toolGroups: [], allowTools: [], denyTools: [] };
    }
  }

  /** ADR-0055: is a tool visible/callable under the global ceiling intersected
   * with the active profile's Scope? Used by both tools/list and tools/call. */
  private isToolScoped(toolName: string): boolean {
    const ceiling = this.settings?.mcp_serve?.tools ?? DEFAULT_TOOL_GROUPS;
    return isToolInScope(toolName, getToolGroup(toolName), ceiling, this.scope);
  }

  /**
   * Wave C: process a JSON-RPC batch, rejecting duplicate IDs.
   *
   * Per JSON-RPC 2.0: each request in a batch must have a unique id.
   * Notifications (no id) are exempt — multiple notifications may share
   * the absence of an id. We dispatch in parallel; duplicates are
   * rejected synchronously with -32600 without calling the handler.
   *
   * Exported for testability.
   */
  async handleBatch(reqs: JsonRpcRequest[]): Promise<(JsonRpcResponse | null)[]> {
    const seenIds = new Set<string | number>();
    const tasks: Promise<JsonRpcResponse | null>[] = [];
    for (const r of reqs) {
      const hasId = "id" in r && r.id !== null && r.id !== undefined;
      if (hasId) {
        const key = r.id as string | number;
        if (seenIds.has(key)) {
          tasks.push(
            Promise.resolve<JsonRpcResponse>({
              jsonrpc: "2.0",
              id: key,
              error: {
                code: -32600,
                message: `Invalid Request: duplicate id "${key}" within batch.`,
              },
            }),
          );
          continue;
        }
        seenIds.add(key);
      }
      tasks.push(this.handleRequest(r));
    }
    return Promise.all(tasks);
  }

  /** Process a single JSON-RPC request and return a response. */
  async handleRequest(req: JsonRpcRequest): Promise<JsonRpcResponse | null> {
    const id = req.id ?? null;

    // ── Wave C: JSON-RPC envelope validation ─────────────────────
    // Reject non-conformant envelopes BEFORE dispatching. Per
    // JSON-RPC 2.0 + MCP 2025-11-25: jsonrpc MUST equal "2.0", and
    // request IDs MUST be a string or number (null is forbidden for
    // requests; notifications omit id entirely).
    //
    // Detection of "is this a notification?" is by the presence of an
    // `id` field at all. We can't distinguish missing-vs-null without
    // looking at the raw JSON, so we accept the JS semantics here: if
    // `id` is undefined (absent from the parsed object), treat it as a
    // notification; if it's explicitly null, that's a violation.
    if (req.jsonrpc !== "2.0") {
      // Can't trust the id either — echo back what the caller sent (or null).
      return {
        jsonrpc: "2.0",
        id,
        error: {
          code: -32600,
          message: `Invalid Request: jsonrpc must equal "2.0" (got ${JSON.stringify(req.jsonrpc)}).`,
        },
      };
    }

    // Methods must be a non-empty string per JSON-RPC.
    if (typeof req.method !== "string" || req.method.length === 0) {
      return {
        jsonrpc: "2.0",
        id,
        error: { code: -32600, message: "Invalid Request: method must be a non-empty string." },
      };
    }

    // Notifications (no id at all) — we only permit the known notification
    // method `notifications/initialized`. Everything else is either a
    // silently-dropped unknown notification or a malformed request.
    const isNotification = !("id" in req);

    if (!isNotification) {
      // Request (not a notification): id MUST be string or number, not null.
      if (req.id === null) {
        return {
          jsonrpc: "2.0",
          id: null,
          error: { code: -32600, message: "Invalid Request: id MUST NOT be null for requests." },
        };
      }
      if (typeof req.id !== "string" && typeof req.id !== "number") {
        return {
          jsonrpc: "2.0",
          id: null,
          error: { code: -32600, message: "Invalid Request: id must be a string or number." },
        };
      }
    }

    // ── Wave C: initialize-state gate ────────────────────────────
    // Spec: "The initialization phase MUST be the first interaction".
    // Only `initialize`, `ping`, and notifications are allowed before
    // the client has completed initialization. Notifications don't
    // return a response, so unknown-method notifications are silently
    // ignored (per JSON-RPC).
    if (!this.initialized && !isNotification && !PRE_INIT_ALLOWED_METHODS.has(req.method)) {
      return {
        jsonrpc: "2.0",
        id,
        error: {
          code: -32002,
          message: `Server not initialized. Client must send 'initialize' before '${req.method}'.`,
        },
      };
    }

    // Refresh settings before handling tool calls so permission checks are never stale
    if (req.method === "tools/call") {
      await this.refreshSettings();
    }

    switch (req.method) {
      case "initialize": {
        // ── Wave C: protocol version negotiation ────────────────
        const params = (req.params ?? {}) as Record<string, unknown>;
        const requested = params.protocolVersion;
        // A missing protocolVersion from the client is tolerated — we fall
        // back to our preferred version. Per spec the client is required
        // to send it, but rejecting missing-version would break older
        // clients without meaningful benefit. We log it via the response
        // shape (we return the preferred version and let the client
        // decide whether to continue).
        let negotiated: string = PREFERRED_MCP_PROTOCOL_VERSION;
        if (typeof requested === "string" && requested.length > 0) {
          const supported = (SUPPORTED_MCP_PROTOCOL_VERSIONS as readonly string[]).includes(
            requested,
          );
          if (supported) {
            negotiated = requested;
          } else {
            // Client asked for a version we don't speak. Per spec example,
            // return -32602 with a clear message listing what we support.
            // Don't silently coerce.
            return {
              jsonrpc: "2.0",
              id,
              error: {
                code: -32602,
                message: `Unsupported protocol version: ${requested}. Supported versions: ${SUPPORTED_MCP_PROTOCOL_VERSIONS.join(", ")}.`,
                data: { supported: [...SUPPORTED_MCP_PROTOCOL_VERSIONS], requested },
              },
            };
          }
        }
        // ADR-0055 Decision 3: capture a connection-supplied profile name from
        // the spec-legal `capabilities.experimental['am.profile']` channel (or
        // the AM_MCP_PROFILE env fallback). stdio is one-client-per-process, so
        // this scopes the whole process. The Scope itself is resolved lazily in
        // refreshSettings (which runs before tools/list and tools/call).
        const caps = params.capabilities as Record<string, unknown> | undefined;
        const experimental = caps?.experimental as Record<string, unknown> | undefined;
        const expProfile = experimental?.["am.profile"];
        const envProfile = process.env.AM_MCP_PROFILE;
        if (typeof expProfile === "string" && expProfile.length > 0) {
          this.connectionProfile = expProfile;
        } else if (typeof envProfile === "string" && envProfile.length > 0) {
          this.connectionProfile = envProfile;
        }
        // Flip the init flag AFTER we've decided this is a valid initialize.
        // A failed negotiation (above) does NOT mark the session initialized.
        this.initialized = true;
        return {
          jsonrpc: "2.0",
          id,
          result: {
            protocolVersion: negotiated,
            capabilities: { tools: {} },
            serverInfo: {
              name: "agent-manager",
              version: AM_VERSION,
            },
          },
        };
      }

      case "ping":
        // MCP ping is a no-op that returns an empty result object. It's
        // explicitly allowed pre-init, so clients can health-check before
        // the handshake completes.
        return { jsonrpc: "2.0", id, result: {} };

      case "notifications/initialized":
        // Client acknowledgement — no response needed
        return null;

      case "tools/list": {
        // Filter by the active profile's runtime Scope intersected with the
        // global tool-group ceiling (ADR-0055, superseding ADR-0021's
        // global-only filter). A profile without `scope` resolves to the global
        // ceiling, so the default surface is unchanged.
        await this.refreshSettings();
        let visibleTools = this.tools.filter((t) => this.isToolScoped(t.def.name));
        // Auth gate (Wave 2.B): if no token is configured AND unsafe-local is
        // not enabled, hide write-tier tools from discovery. Read-only stays
        // visible for unauthenticated clients.
        if (!this.auth.token && !this.auth.allowUnsafeLocal) {
          visibleTools = visibleTools.filter((t) => t.tier === "read-only");
        }
        return {
          jsonrpc: "2.0",
          id,
          result: {
            // ADR-0037 Phase 1 (2026-05-03): augment each tool def with
            // `x-am` metadata (group, tier, auth_required, deprecated,
            // deprecation?, progress_supported). MCP spec permits unknown
            // fields — clients that don't read x-am simply ignore it.
            tools: visibleTools.map((t) => ({
              ...t.def,
              "x-am": buildToolMetadata(t.def.name, t.tier),
            })),
          },
        };
      }

      case "tools/call": {
        const params = req.params ?? {};
        const toolName = params.name as string;
        const toolArgs = (params.arguments as Record<string, unknown>) ?? {};

        const tool = this.tools.find((t) => t.def.name === toolName);
        if (!tool) {
          return {
            jsonrpc: "2.0",
            id,
            error: {
              code: -32601,
              message: `Unknown tool: ${toolName}. Use tools/list to see available tools.`,
            },
          };
        }

        // ADR-0055 Decision 2: when a profile declares a `scope`, it is an
        // access boundary enforced at DISPATCH too, not only at discovery —
        // hiding a tool from tools/list is not a boundary (an agent can call a
        // name it saw before switching profile, or hallucinated). We gate calls
        // ONLY when a Scope is active: the global `settings.mcp_serve.tools`
        // groups remain a DISCOVERY-only filter (ADR-0021 semantics — calling a
        // non-core tool without configuring groups has always worked and is
        // gated by tier/auth, not group). `this.scope` is defined only when the
        // active profile opted into scoping. (refreshSettings ran above.)
        if (this.scope && !this.isToolScoped(toolName)) {
          const activeProfile =
            this.connectionProfile ?? this.settings?.default_profile ?? "default";
          return {
            jsonrpc: "2.0",
            id,
            error: {
              code: -32601,
              message: `Tool "${toolName}" is not available in the active profile "${activeProfile}". Its tool group is outside the profile's scope. Use tools/list to see the tools this profile exposes.`,
            },
          };
        }

        // Permission check (ADR-0009 tier: write-remote opt-in)
        const perm = checkPermission(tool.tier, this.settings);
        if (!perm.allowed) {
          return {
            jsonrpc: "2.0",
            id,
            result: {
              content: [{ type: "text", text: JSON.stringify({ error: perm.reason }) }],
              isError: true,
            },
          };
        }

        // Auth gate (Wave 2.B): write-tier tools require AM_MCP_TOKEN or
        // AM_MCP_ALLOW_UNSAFE_LOCAL=1. Read-only passes through.
        const authDecision = checkWriteAuth(tool.tier, this.auth, req);
        if (!authDecision.allowed) {
          return {
            jsonrpc: "2.0",
            id,
            result: {
              content: [{ type: "text", text: JSON.stringify({ error: authDecision.reason }) }],
              isError: true,
            },
          };
        }

        // Sensitive read-only gate: full-config disclosure (am_config_show) is
        // token-gated whenever AM_MCP_TOKEN is configured, so a tokenless
        // client can't read the merged config even though it's a read-only
        // tier. No-op when no token is set (local-dev default unchanged).
        const sensitiveDecision = checkSensitiveReadAuth(toolName, this.auth, req);
        if (!sensitiveDecision.allowed) {
          return {
            jsonrpc: "2.0",
            id,
            result: {
              content: [
                { type: "text", text: JSON.stringify({ error: sensitiveDecision.reason }) },
              ],
              isError: true,
            },
          };
        }

        // Zod runtime validation of arguments (Wave 2.B).
        const schema = TOOL_SCHEMAS[toolName];
        if (schema) {
          const validation = validateInput(schema, toolArgs);
          if (!validation.ok) {
            return {
              jsonrpc: "2.0",
              id,
              result: {
                content: [{ type: "text", text: JSON.stringify({ error: validation.error }) }],
                isError: true,
              },
            };
          }
        }

        try {
          // Wave D: build the ToolContext. Extract a progressToken from
          // params._meta (standard MCP convention). When present, we emit
          // `notifications/progress` via the configured sink; when absent,
          // emitProgress is a no-op (graceful fallback for older clients).
          const meta = (params._meta as Record<string, unknown> | undefined) ?? undefined;
          const rawToken = meta?.progressToken;
          const progressToken: string | number | undefined =
            typeof rawToken === "string" || typeof rawToken === "number" ? rawToken : undefined;
          const sink = this.progressSink;
          const ctx: ToolContext = {
            progressToken,
            emitProgress: (payload) => {
              if (progressToken === undefined) return;
              // REV-2 HIGH-1 fix: redact secret-shaped content in the progress
              // message before it leaves the server. ACP agent_message_chunk
              // content and A2A status/artifact events can contain the user's
              // own paste of credentials or whatever the remote agent echoes
              // back. Apply redactSecretish to every string leaf.
              const safeMessage =
                payload.message !== undefined ? redactProgressMessage(payload.message) : undefined;
              sink({
                jsonrpc: "2.0",
                method: "notifications/progress",
                params: {
                  progressToken,
                  ...(payload.progress !== undefined ? { progress: payload.progress } : {}),
                  ...(payload.total !== undefined ? { total: payload.total } : {}),
                  ...(safeMessage !== undefined ? { message: safeMessage } : {}),
                },
              });
            },
          };
          // C1-lite (2026-05-02, all-pillars P2 §5.2 observability): emit a
          // tool-timing line to stderr when AM_MCP_TIMING=1. Opt-in only so
          // we don't spam users who don't care. Format is grep-friendly:
          // `[am-mcp-timing] <tool> ms=<N> ok=<true|false>`. No user data,
          // no secret risk — just the tool name + duration + success flag.
          const timingEnabled = process.env.AM_MCP_TIMING === "1";
          const t0 = timingEnabled ? Bun.nanoseconds() : 0;
          try {
            const result = await tool.handler(toolArgs, ctx);
            if (timingEnabled) {
              const ms = ((Bun.nanoseconds() - t0) / 1e6).toFixed(1);
              process.stderr.write(`[am-mcp-timing] ${toolName} ms=${ms} ok=true\n`);
            }
            return {
              jsonrpc: "2.0",
              id,
              result: {
                content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
              },
            };
          } catch (err: unknown) {
            if (timingEnabled) {
              const ms = ((Bun.nanoseconds() - t0) / 1e6).toFixed(1);
              process.stderr.write(`[am-mcp-timing] ${toolName} ms=${ms} ok=false\n`);
            }
            throw err;
          }
        } catch (err: unknown) {
          // Redact secrets from error text before it leaves the server.
          const msg = safeErrorMessage(err);
          // Split "What failed. Recovery hint." into error + hint
          const dotIdx = msg.indexOf(". ");
          const error = dotIdx > 0 ? msg.slice(0, dotIdx + 1) : msg;
          const hint = dotIdx > 0 ? msg.slice(dotIdx + 2) : undefined;
          return {
            jsonrpc: "2.0",
            id,
            result: {
              content: [
                {
                  type: "text",
                  text: JSON.stringify({ error, ...(hint ? { hint } : {}) }),
                },
              ],
              isError: true,
            },
          };
        }
      }

      default:
        // Unknown method
        if (req.id != null) {
          return {
            jsonrpc: "2.0",
            id,
            error: {
              code: -32601,
              message: `Method not found: ${req.method}`,
            },
          };
        }
        // Notifications (no id) get no response
        return null;
    }
  }

  /** Run the server on stdio, reading newline-delimited JSON-RPC from stdin. */
  async serve(): Promise<void> {
    // Wave C: real sessions enforce the MCP initialize handshake. Flip the
    // gate to "not yet initialized" so the first non-initialize/non-ping
    // request is rejected with -32002 per spec.
    this.initialized = false;

    // Load settings once at startup for permission checks
    try {
      const configDir = resolveConfigDir();
      const projectFile = resolveProjectConfig(process.cwd());
      const config = await loadResolvedConfig({ configDir, projectFile });
      this.settings = config.settings;
    } catch {
      // No config yet — all write-remote tools will be denied
    }

    const decoder = new TextDecoder();
    let buffer = "";
    const write = (obj: unknown) => process.stdout.write(`${JSON.stringify(obj)}\n`);

    for await (const chunk of Bun.stdin.stream()) {
      buffer += decoder.decode(chunk, { stream: true });

      // SEC-5: split off any complete newline-delimited lines and bound the
      // unflushed remainder. `drainStdinBuffer` returns oversized-line markers
      // so a peer streaming bytes without a newline can't grow the buffer
      // without limit.
      const { lines, remainder } = McpServer.drainStdinBuffer(buffer);
      buffer = remainder;

      for (const item of lines) {
        if (item.overflow) {
          // Oversized line (complete or pending) → JSON-RPC parse error.
          write({
            jsonrpc: "2.0",
            id: null,
            error: {
              code: -32700,
              message: `Parse error: line exceeds maximum length (${MAX_STDIN_LINE_BYTES} bytes)`,
            },
          });
          continue;
        }

        const line = item.line.trim();
        if (!line) continue;

        let req: JsonRpcRequest;
        try {
          req = JSON.parse(line);
        } catch {
          write({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
          continue;
        }

        if (Array.isArray(req)) {
          // Wave C: batch ID dedup. Per JSON-RPC 2.0 each request in a
          // batch must have a unique id. We track ids seen in this batch
          // and respond to any duplicate with -32600 instead of dispatching.
          // Notifications (no id) are skipped from the dedup check.
          const responses = await this.handleBatch(req);
          const filtered = responses.filter(Boolean);
          if (filtered.length > 0) {
            write(filtered);
          }
          continue;
        }

        const resp = await this.handleRequest(req);
        if (resp) {
          write(resp);
        }
      }
    }
  }

  /**
   * SEC-5: split a stdin buffer into complete lines, bounding line length.
   *
   * Returns the parsed `lines` (each either a normal `line` string or an
   * `overflow` marker for a line that exceeds {@link MAX_STDIN_LINE_BYTES})
   * and the `remainder` to retain for the next chunk.
   *
   * - Complete lines (terminated by `\n`) that are over the cap are emitted as
   *   `{ overflow: true }` instead of returning a multi-megabyte string to
   *   `JSON.parse`.
   * - An unterminated remainder over the cap is also emitted as
   *   `{ overflow: true }` and discarded (remainder reset to ""), so a peer
   *   that never sends a newline cannot grow memory without bound.
   *
   * Pure and static so it can be unit-tested without driving real stdin.
   */
  static drainStdinBuffer(buffer: string): {
    lines: Array<{ line: string; overflow?: false } | { overflow: true }>;
    remainder: string;
  } {
    const lines: Array<{ line: string; overflow?: false } | { overflow: true }> = [];
    let rest = buffer;

    let newlineIdx = rest.indexOf("\n");
    while (newlineIdx !== -1) {
      const line = rest.substring(0, newlineIdx);
      rest = rest.substring(newlineIdx + 1);
      if (line.length > MAX_STDIN_LINE_BYTES) {
        lines.push({ overflow: true });
      } else {
        lines.push({ line });
      }
      newlineIdx = rest.indexOf("\n");
    }

    // Bound the unterminated remainder.
    if (rest.length > MAX_STDIN_LINE_BYTES) {
      lines.push({ overflow: true });
      rest = "";
    }

    return { lines, remainder: rest };
  }

  /** Expose tools for testing. */
  getTools(): ToolEntry[] {
    return this.tools;
  }

  /** Set settings for permission checks (useful for testing). */
  setSettings(settings: Settings): void {
    this.settings = settings;
  }
}
