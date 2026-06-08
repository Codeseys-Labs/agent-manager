import { timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Hono } from "hono";
import { serveStatic } from "hono/bun";
import { getAdapter, getDetectedAdapters, listAdapters } from "../adapters/registry";
import { readActiveProfile, writeActiveProfile } from "../commands/use";
import { atomicWriteFileSync } from "../core/atomic-write";
import {
  buildResolvedConfig,
  loadResolvedConfig,
  readConfig,
  resolveConfigDir,
  resolveProjectConfig,
  writeConfig,
} from "../core/config";
import { APPLY_SAFE_DEFAULTS, applyResolved, withConfig } from "../core/controller";
import { commitAll, getStatus, pull as gitPull, push as gitPush } from "../core/git";
import { ServerSchema } from "../core/schema";
import {
  encryptValue,
  generateKey,
  importKey,
  interpolateEnvAsync,
  loadKey,
  saveKey,
} from "../core/secrets";
import { errorMessage } from "../lib/errors";
import { redactConfigPlaintextSecrets, redactConfigSecrets, safeErrorMessage } from "../lib/redact";
import { AM_VERSION } from "../lib/version";

// ── Token-based authentication for local web server ─────────────

const TOKEN_FILENAME = "web-token.txt";

/**
 * Generate or read the localhost authentication token.
 * Token is a 32-byte cryptographically random hex string stored
 * in the agent-manager config directory with mode 0600.
 */
export function ensureAuthToken(configDir: string): string {
  const tokenPath = join(configDir, TOKEN_FILENAME);
  try {
    if (existsSync(tokenPath)) {
      return readFileSync(tokenPath, "utf-8").trim();
    }
  } catch {
    // File unreadable, regenerate
  }

  // Generate a 32-byte random token
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const token = Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  mkdirSync(configDir, { recursive: true });
  atomicWriteFileSync(tokenPath, `${token}\n`, { mode: 0o600 });
  return token;
}

/**
 * Returns the path where the auth token is stored, for display to the user.
 */
export function getTokenPath(configDir: string): string {
  return join(configDir, TOKEN_FILENAME);
}

/** Constant-time string compare. Returns false on length mismatch. */
function safeCompare(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) {
    timingSafeEqual(ab, ab);
    return false;
  }
  return timingSafeEqual(ab, bb);
}

/** Session cookie name set by POST /auth/session and read by the auth middleware. */
const SESSION_COOKIE = "am_session";

/** Extract `am_session` value from a Cookie header, or undefined. */
function readSessionCookie(cookieHeader: string | undefined): string | undefined {
  if (!cookieHeader) return undefined;
  for (const part of cookieHeader.split(";")) {
    const [rawName, ...rest] = part.trim().split("=");
    if (rawName === SESSION_COOKIE) return rest.join("=");
  }
  return undefined;
}

export interface CreateAppOptions {
  /** Enable A2A-ACP bridge for incoming A2A tasks. */
  enableBridge?: boolean;
  /**
   * Session-bound auth token. When provided (e.g. by `am serve`), the server
   * uses this token instead of the disk-persisted one. Intended for the
   * one-time URL bootstrap: each `am serve` run mints a fresh token and
   * restart invalidates the old URL.
   */
  authToken?: string;
}

export async function createApp(options?: CreateAppOptions) {
  const app = new Hono();
  const configDir = resolveConfigDir();
  const authToken = options?.authToken ?? ensureAuthToken(configDir);

  // ── Auth bootstrap — POST /auth/session exchanges ?token=X for a cookie.
  // Mounted BEFORE the bearer-enforcing middleware so the landing page can
  // seed credentials without already having them.
  app.post("/auth/session", async (c) => {
    let token: string | undefined;
    try {
      const body = (await c.req.json()) as { token?: unknown };
      if (typeof body?.token === "string") token = body.token;
    } catch {
      // fall through — token remains undefined, 400 below
    }
    if (!token) return c.json({ error: "Missing 'token' field" }, 400);
    if (!safeCompare(token, authToken)) {
      return c.json({ error: "Invalid token" }, 401);
    }
    // HttpOnly + SameSite=Lax + Path=/. No Secure (localhost http).
    // Session-bound: no Max-Age/Expires — cookie dies with the browser session.
    c.header(
      "Set-Cookie",
      `${SESSION_COOKIE}=${encodeURIComponent(authToken)}; HttpOnly; SameSite=Lax; Path=/`,
    );
    return c.json({ ok: true });
  });

  app.post("/auth/logout", (c) => {
    c.header("Set-Cookie", `${SESSION_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`);
    return c.json({ ok: true });
  });

  // ── Auth middleware — require Bearer token OR session cookie on /api/* ──
  app.use("*", async (c, next) => {
    // Allow health check without auth
    if (c.req.path === "/api/health") return next();

    // Allow static assets without auth
    if (!c.req.path.startsWith("/api/")) return next();

    // Session cookie path (set by POST /auth/session after URL bootstrap)
    const cookieTok = readSessionCookie(c.req.header("cookie"));
    if (cookieTok && safeCompare(cookieTok, authToken)) return next();

    const authHeader = c.req.header("authorization");
    if (!authHeader) {
      return c.json(
        {
          error: "Authentication required",
          hint: options?.authToken
            ? "Open the URL printed by `am serve` (includes ?token=...)"
            : `Provide Bearer token from ${getTokenPath(configDir)}`,
        },
        401,
      );
    }

    const [scheme, token] = authHeader.split(" ", 2);
    if (scheme?.toLowerCase() !== "bearer" || !token || !safeCompare(token, authToken)) {
      return c.json({ error: "Invalid authentication token" }, 401);
    }

    return next();
  });

  async function getConfigAndProfile() {
    const configDir = resolveConfigDir();
    const projectFile = resolveProjectConfig(process.cwd());
    const config = await loadResolvedConfig({ configDir, projectFile });
    const profileName =
      (await readActiveProfile(configDir)) ?? config.settings?.default_profile ?? "default";
    return { configDir, config, profileName };
  }

  /** Read the raw (non-merged) global config for mutation endpoints. */
  async function getConfigAndWritePath() {
    const dir = resolveConfigDir();
    const configPath = join(dir, "config.toml");
    const config = await readConfig(configPath);
    return { config, configPath, configDir: dir };
  }

  // --- API Routes ---

  app.get("/api/health", (c) => {
    return c.json({ status: "ok", version: AM_VERSION });
  });

  app.get("/api/config", async (c) => {
    try {
      const { config, profileName } = await getConfigAndProfile();
      // R2-SEC2: two-pass redaction, identical to the MCP am_config_show path.
      // redactConfigSecrets masks enc: envelopes (v1 + v2 age);
      // redactConfigPlaintextSecrets masks PLAINTEXT secrets the envelope pass
      // misses — env/headers maps by location, named secret scalars
      // (a2a.auth_token etc.), and credential userinfo in URLs.
      return c.json({
        profile: profileName,
        config: redactConfigPlaintextSecrets(redactConfigSecrets(config)),
      });
    } catch {
      return c.json({ error: "Config not found. Run `am init` first." }, 500);
    }
  });

  app.get("/api/servers", async (c) => {
    try {
      const { config } = await getConfigAndProfile();
      const servers = Object.entries(config.servers ?? {}).map(([name, srv]) => ({
        name,
        command: srv.command,
        args: srv.args ?? [],
        tags: srv.tags ?? [],
        enabled: srv.enabled ?? true,
        description: srv.description ?? "",
        transport: srv.transport ?? "stdio",
      }));
      return c.json({ servers });
    } catch {
      return c.json({ error: "Config not found" }, 500);
    }
  });

  app.post("/api/servers", async (c) => {
    try {
      const body = await c.req.json();
      const { name, command, args, env, tags, description, transport } = body;
      if (!name || !command) {
        return c.json({ error: "name and command are required" }, 400);
      }

      // R2-LOW: validate the candidate server against ServerSchema BEFORE any
      // write. Without this, a malformed body (e.g. transport:"bogus", or a
      // stdio server carrying a url) was TOML-serialized into config.toml as-is;
      // the next readConfig then threw on the invalid shape, bricking the whole
      // config (a 201 followed by permanent 500s — a persistent self-DoS). Every
      // other write surface (MCP am_add_server/am_server_update, registry/import)
      // upholds this invariant; the web path must too.
      const candidate = {
        command,
        args: args ?? [],
        env: env ?? {},
        tags: tags ?? [],
        description: description ?? "",
        transport: transport ?? "stdio",
        enabled: true,
      };
      const parsed = ServerSchema.safeParse(candidate);
      if (!parsed.success) {
        return c.json({ error: `Invalid server: ${parsed.error.issues[0]?.message}` }, 400);
      }

      const dir = resolveConfigDir();
      type Outcome = { status: "ok" } | { status: "duplicate" } | { status: "missing-config" };
      const outcome = await withConfig<Outcome>(dir, async (config) => {
        if (!config) return { result: { status: "missing-config" }, changed: false };
        if (!config.servers) config.servers = {};
        if (config.servers[name]) {
          return { result: { status: "duplicate" }, changed: false };
        }
        config.servers[name] = {
          command,
          args: args ?? [],
          env: env ?? {},
          tags: tags ?? [],
          description: description ?? "",
          transport: transport ?? "stdio",
          enabled: true,
        };

        const { scanServerForSecrets, substituteSecret, pickEnvVarName } = await import(
          "../core/secret-detection"
        );
        const scanResult = await scanServerForSecrets(name, config.servers[name]);
        if (scanResult.secrets.length > 0) {
          let key = await loadKey(dir);
          if (!key) {
            const b64 = await generateKey();
            await saveKey(dir, b64);
            key = await importKey(b64);
          }
          for (const secret of scanResult.secrets) {
            if (!config.settings) config.settings = {};
            if (!config.settings.env) config.settings.env = {};
            const envVarName =
              secret.source === "url-credential"
                ? pickEnvVarName(config.settings.env, secret.suggestedEnvVar, name)
                : secret.suggestedEnvVar;
            substituteSecret(config.servers[name], secret, envVarName);
            config.settings.env[envVarName] = await encryptValue(secret.value, key);
          }
        }
        return {
          result: { status: "ok" },
          commitMessage: `add server: ${name}`,
          changed: true,
        };
      });

      if (outcome.status === "missing-config") {
        return c.json({ error: "Config not found. Run `am init` first." }, 500);
      }
      if (outcome.status === "duplicate") {
        return c.json({ error: `Server "${name}" already exists` }, 409);
      }
      return c.json({ action: "add", server: name }, 201);
    } catch (err) {
      return c.json({ error: errorMessage(err) }, 500);
    }
  });

  app.put("/api/servers/:name", async (c) => {
    try {
      const serverName = c.req.param("name");
      const body = await c.req.json();

      const dir = resolveConfigDir();
      type Outcome =
        | { status: "ok" }
        | { status: "not-found" }
        | { status: "invalid"; error: string };
      const outcome = await withConfig<Outcome>(dir, async (config) => {
        if (!config?.servers?.[serverName]) {
          return { result: { status: "not-found" }, changed: false };
        }
        const existing = config.servers[serverName];
        // R2-LOW: build the MERGED candidate and validate it against ServerSchema
        // BEFORE mutating `existing`. The PUT path validated nothing, so a patch
        // like {transport:"grpc"} persisted an unloadable config (the next
        // readConfig threw → permanent 500s). Validate first, mutate only on
        // success, and return changed:false on failure so nothing is written.
        const merged = {
          ...existing,
          ...(body.command !== undefined ? { command: body.command } : {}),
          ...(body.args !== undefined ? { args: body.args } : {}),
          ...(body.env !== undefined ? { env: body.env } : {}),
          ...(body.tags !== undefined ? { tags: body.tags } : {}),
          ...(body.description !== undefined ? { description: body.description } : {}),
          ...(body.transport !== undefined ? { transport: body.transport } : {}),
          ...(body.enabled !== undefined ? { enabled: body.enabled } : {}),
        };
        const parsed = ServerSchema.safeParse(merged);
        if (!parsed.success) {
          return {
            result: {
              status: "invalid",
              error: parsed.error.issues[0]?.message ?? "invalid server",
            },
            changed: false,
          };
        }
        if (body.command !== undefined) existing.command = body.command;
        if (body.args !== undefined) existing.args = body.args;
        if (body.env !== undefined) existing.env = body.env;
        if (body.tags !== undefined) existing.tags = body.tags;
        if (body.description !== undefined) existing.description = body.description;
        if (body.transport !== undefined) existing.transport = body.transport;
        if (body.enabled !== undefined) existing.enabled = body.enabled;
        return {
          result: { status: "ok" },
          commitMessage: `update server: ${serverName}`,
          changed: true,
        };
      });

      if (outcome.status === "not-found") {
        return c.json({ error: `Server "${serverName}" not found` }, 404);
      }
      if (outcome.status === "invalid") {
        return c.json({ error: `Invalid server: ${outcome.error}` }, 400);
      }
      return c.json({ action: "update", server: serverName });
    } catch (err) {
      return c.json({ error: errorMessage(err) }, 500);
    }
  });

  app.delete("/api/servers/:name", async (c) => {
    try {
      const serverName = c.req.param("name");

      const dir = resolveConfigDir();
      type Outcome = { status: "ok" } | { status: "not-found" };
      const outcome = await withConfig<Outcome>(dir, async (config) => {
        if (!config?.servers?.[serverName]) {
          return { result: { status: "not-found" }, changed: false };
        }
        delete config.servers[serverName];
        return {
          result: { status: "ok" },
          commitMessage: `remove server: ${serverName}`,
          changed: true,
        };
      });

      if (outcome.status === "not-found") {
        return c.json({ error: `Server "${serverName}" not found` }, 404);
      }
      return c.json({ action: "delete", server: serverName });
    } catch (err) {
      return c.json({ error: errorMessage(err) }, 500);
    }
  });

  app.post("/api/import/:adapter", async (c) => {
    try {
      const adapterName = c.req.param("adapter");
      const adapter = await getAdapter(adapterName);
      if (!adapter) {
        return c.json({ error: `Adapter "${adapterName}" not found` }, 404);
      }

      const imported = await adapter.import({});
      const dir = resolveConfigDir();

      const result = await withConfig<{ servers: string[] }>(dir, async (config) => {
        if (!config) throw new Error("Config not found. Run `am init` first.");

        if (imported.servers) {
          if (!config.servers) config.servers = {};
          for (const [name, srv] of Object.entries(imported.servers)) {
            config.servers[name] = {
              command: srv.command,
              args: srv.args,
              env: srv.env,
              transport: srv.transport ?? "stdio",
              description: srv.description,
              tags: srv.tags,
              enabled: srv.enabled ?? true,
            };
          }
        }

        if (imported.servers) {
          const { scanServerForSecrets, substituteSecret, pickEnvVarName } = await import(
            "../core/secret-detection"
          );
          for (const [name, srv] of Object.entries(imported.servers)) {
            const scanResult = await scanServerForSecrets(name, srv);
            if (scanResult.secrets.length > 0) {
              let key = await loadKey(dir);
              if (!key) {
                const b64 = await generateKey();
                await saveKey(dir, b64);
                key = await importKey(b64);
              }
              for (const secret of scanResult.secrets) {
                if (!config.settings) config.settings = {};
                if (!config.settings.env) config.settings.env = {};
                const envVarName =
                  secret.source === "url-credential"
                    ? pickEnvVarName(config.settings.env, secret.suggestedEnvVar, name)
                    : secret.suggestedEnvVar;
                substituteSecret(config.servers![name], secret, envVarName);
                config.settings.env[envVarName] = await encryptValue(secret.value, key);
              }
            }
          }
        }

        const serverNames = Object.keys(imported.servers ?? {});
        return {
          result: { servers: serverNames },
          commitMessage: `import from ${adapterName}`,
          changed: serverNames.length > 0,
        };
      });

      return c.json({
        action: "import",
        adapter: adapterName,
        servers: result.servers,
      });
    } catch (err) {
      return c.json({ error: errorMessage(err) }, 500);
    }
  });

  app.get("/api/profiles", async (c) => {
    try {
      const { config, profileName } = await getConfigAndProfile();
      const profiles = Object.entries(config.profiles ?? {}).map(([name, profile]) => ({
        name,
        description: profile.description ?? "",
        inherits: profile.inherits ?? null,
        active: name === profileName,
      }));
      return c.json({ profiles, active: profileName });
    } catch {
      return c.json({ error: "Config not found" }, 500);
    }
  });

  app.get("/api/status", async (c) => {
    try {
      const { config, configDir, profileName } = await getConfigAndProfile();
      const resolved = buildResolvedConfig(config, profileName, configDir);

      // Git status
      //
      // On ANY getStatus() fault (not-a-repo, corrupt index, IO error) we must
      // report clean:FALSE, never clean:true — getStatus throws only on a real
      // fault, not on a dirty tree (a dirty tree returns clean:false normally).
      // Fabricating clean:true here would make the web sync indicator show
      // "nothing to sync" precisely when git is broken. Surface the failure via
      // a `gitError` field instead (matches the MCP am_status field naming).
      let gitStatus: {
        branch: string;
        clean: boolean;
        dirty: string[];
        remotes: Array<{ remote: string; url: string }>;
      };
      let gitError: string | undefined;
      try {
        gitStatus = await getStatus(configDir);
      } catch (err) {
        gitStatus = { branch: "unknown", clean: false, dirty: [], remotes: [] };
        // safeErrorMessage (not errorMessage): a git fault message can embed a
        // credential-bearing remote URL; scrub it before it crosses to the
        // client (R4-MED, matches the MCP am_status path).
        gitError = safeErrorMessage(err) || "git status unavailable";
      }

      // Adapter drift
      const adapters = await getDetectedAdapters();
      const tools: Array<{
        name: string;
        displayName: string;
        status: string;
        changes: number;
      }> = [];

      for (const adapter of adapters) {
        try {
          const diffResult = await adapter.diff(resolved);
          tools.push({
            name: adapter.meta.name,
            displayName: adapter.meta.displayName,
            status: diffResult.status,
            changes: diffResult.changes.length,
          });
        } catch {
          tools.push({
            name: adapter.meta.name,
            displayName: adapter.meta.displayName,
            status: "unknown",
            changes: 0,
          });
        }
      }

      return c.json({
        profile: profileName,
        servers: Object.keys(resolved.servers).length,
        git: {
          branch: gitStatus.branch,
          clean: gitStatus.clean,
          dirty: gitStatus.dirty,
          remotes: gitStatus.remotes,
          ...(gitError ? { gitError } : {}),
        },
        tools,
      });
    } catch {
      return c.json({ error: "Config not found" }, 500);
    }
  });

  app.post("/api/profile/use", async (c) => {
    try {
      const body = await c.req.json();
      const profile = body?.profile;
      if (!profile || typeof profile !== "string") {
        return c.json({ error: "Missing 'profile' field" }, 400);
      }

      const { config, configDir } = await getConfigAndProfile();
      const profiles = config.profiles ?? {};
      if (Object.keys(profiles).length > 0 && !profiles[profile]) {
        return c.json(
          {
            error: `Profile "${profile}" not found`,
            available: Object.keys(profiles),
          },
          404,
        );
      }

      await writeActiveProfile(configDir, profile);
      return c.json({ action: "use", profile });
    } catch (e: unknown) {
      return c.json({ error: errorMessage(e) || "Failed to switch profile" }, 500);
    }
  });

  app.post("/api/apply", async (c) => {
    try {
      // SEC-4b: the local web UI is a write-local surface — POST /api/apply
      // writes IDE-native config files just like `am apply`. It must inherit
      // the CLI's fail-closed drift gate so a button click cannot silently
      // overwrite a native config a human edited out of band (the 2026-04-15
      // `~/.claude.json` wipe class). Default `diff: true` so the controller
      // runs `adapter.diff()` and SKIPS drifted (or unreadable-drift) adapters.
      // The caller opts into overwriting with `{ "force": true }` in the body,
      // mirroring the CLI `--force`. The body is optional — a bodiless POST
      // keeps the safe (force=false) default.
      // Derive the safe posture from the SHARED APPLY_SAFE_DEFAULTS so the
      // fail-closed gate lives in ONE place across all four surfaces.
      let force: boolean = APPLY_SAFE_DEFAULTS.force;
      try {
        const body = (await c.req.json()) as { force?: unknown } | null;
        if (body?.force === true) force = true;
      } catch {
        // No / invalid JSON body — keep the safe default (force=false).
      }
      const applyResult = await applyResolved(resolveConfigDir(), {
        dryRun: false,
        diff: APPLY_SAFE_DEFAULTS.diff,
        force,
      });
      return c.json({
        action: "apply",
        profile: applyResult.profile,
        dryRun: false,
        results: applyResult.results.map((r) => ({
          adapter: r.adapter,
          files: r.files,
          warnings: r.warnings,
        })),
        // Surface the fail-closed gate so the UI can show which tools were
        // NOT written and offer a force re-apply.
        skipped: applyResult.skipped,
      });
    } catch (e: unknown) {
      return c.json({ error: errorMessage(e) || "Apply failed" }, 500);
    }
  });

  app.post("/api/sync/push", async (c) => {
    try {
      const configDir = resolveConfigDir();
      await gitPush(configDir);
      return c.json({ action: "push", success: true });
    } catch (e: unknown) {
      // R3-SEC: safeErrorMessage scrubs credential userinfo (and token shapes)
      // — a failed push to https://user:token@host would otherwise echo the
      // token verbatim in the error body.
      return c.json({ error: safeErrorMessage(e) || "Push failed" }, 500);
    }
  });

  app.post("/api/sync/pull", async (c) => {
    try {
      const configDir = resolveConfigDir();
      await gitPull(configDir);
      return c.json({ action: "pull", success: true });
    } catch (e: unknown) {
      // R3-SEC: see push handler — scrub credential-bearing remote URLs.
      return c.json({ error: safeErrorMessage(e) || "Pull failed" }, 500);
    }
  });

  // SSE endpoint for real-time status
  app.get("/api/events", async (c) => {
    const stream = new ReadableStream({
      start(controller) {
        const encoder = new TextEncoder();
        const send = (event: string, data: unknown) => {
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
        };

        // Send initial status
        send("connected", { time: Date.now() });

        // Periodic status updates
        const interval = setInterval(async () => {
          try {
            const configDir = resolveConfigDir();
            const gitStatus = await getStatus(configDir);
            send("status", {
              git: {
                branch: gitStatus.branch,
                clean: gitStatus.clean,
                dirty: gitStatus.dirty.length,
              },
              time: Date.now(),
            });
          } catch {
            send("status", { error: "unavailable", time: Date.now() });
          }
        }, 30000);

        // Cleanup on abort
        c.req.raw.signal.addEventListener("abort", () => {
          clearInterval(interval);
          controller.close();
        });
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    });
  });

  // ── A2A endpoints ──────────────────────────────────────────────
  // When bridge is enabled, mount full A2A routes (Agent Card + JSON-RPC with bridge handler).
  // Otherwise, serve just the Agent Card endpoint.
  if (options?.enableBridge) {
    const { createA2ARoutes } = await import("../protocols/a2a/server");
    const {
      config: bridgeFullConfig,
      configDir: bridgeCfgDir,
      profileName: bridgeProfile,
    } = await getConfigAndProfile();
    const bridgeResolved = buildResolvedConfig(bridgeFullConfig, bridgeProfile, bridgeCfgDir);
    // REV-5 MED-2: the bridge needs the raw config (not just the resolved
    // one) to honor user config-agent overrides like the
    // `agents.<name>.acp.command` that `am agent enable-shim` writes.
    // Without this, shim-enabled Tier-2 agents (aider/amazon-q/cody) are
    // invisible to A2A delegation even after the user opted in.
    const { tryReadConfig: bridgeTryReadConfig } = await import("../core/config");
    const bridgeRawConfig = (await bridgeTryReadConfig(join(bridgeCfgDir, "config.toml"))) as
      | import("../core/agent-registry").UnifiedRegistryConfig
      | undefined;
    const a2aApp = createA2ARoutes({
      config: bridgeResolved,
      cardOptions: { baseUrl: "http://localhost:3456" },
      enableBridge: true,
      auth_token: authToken,
      bridgeConfig: { registryConfig: bridgeRawConfig },
    });
    app.route("/", a2aApp);
  } else {
    app.get("/.well-known/agent.json", async (c) => {
      try {
        const { config, configDir, profileName } = await getConfigAndProfile();
        const resolved = buildResolvedConfig(config, profileName, configDir);

        // Read provider settings from settings.a2a.publish passthrough
        const a2aSettings = (config.settings as Record<string, unknown> | undefined)?.a2a as
          | Record<string, unknown>
          | undefined;
        const publishSettings = a2aSettings?.publish as Record<string, unknown> | undefined;

        const { generateAgentCard } = await import("../protocols/a2a/generate-card");
        const card = generateAgentCard(resolved, {
          baseUrl: `http://localhost:${c.req.header("host")?.split(":")[1] ?? "3000"}`,
          provider: publishSettings
            ? {
                name: publishSettings.name as string | undefined,
                description: publishSettings.description as string | undefined,
                organization: publishSettings.provider as string | undefined,
              }
            : undefined,
        });
        return c.json(card);
      } catch {
        return c.json({ error: "Failed to generate Agent Card" }, 500);
      }
    });
  }

  // ── Wiki endpoints ───────────────────────────────────────────

  app.get("/api/wiki/pages", async (c) => {
    const { listPages, resolveWikiDir } = await import("../wiki/storage");
    const type = c.req.query("type"); // optional filter
    const global = c.req.query("global") === "true";
    const wikiDir = resolveWikiDir({ global });
    const pages = await listPages({ type: type as any, wikiDir });
    return c.json({
      pages: pages.map((p) => ({
        slug: p.slug,
        title: p.title,
        type: p.type,
        tags: p.tags,
        updated: p.updated,
        confidence: p.confidence,
      })),
    });
  });

  app.get("/api/wiki/search", async (c) => {
    const query = c.req.query("q");
    if (!query) return c.json({ error: "Query parameter 'q' required" }, 400);
    const { searchPages, resolveWikiDir } = await import("../wiki/storage");
    const global = c.req.query("global") === "true";
    const limit = Number.parseInt(c.req.query("limit") ?? "20", 10);
    const wikiDir = resolveWikiDir({ global });
    const results = await searchPages(query, limit, wikiDir);
    return c.json({
      query,
      results: results.map((r) => ({
        slug: r.page.slug,
        title: r.page.title,
        type: r.page.type,
        score: r.score,
        tags: r.page.tags,
      })),
    });
  });

  app.get("/api/wiki/graph", async (c) => {
    const { loadGraph, exportGraphForViz } = await import("../wiki/graph");
    const { resolveWikiDir } = await import("../wiki/storage");
    const global = c.req.query("global") === "true";
    const wikiDir = resolveWikiDir({ global });
    const graph = await loadGraph(wikiDir);
    return c.json(exportGraphForViz(graph));
  });

  app.get("/api/wiki/projects", async (c) => {
    const { resolveConfigDir } = await import("../core/config");
    const { existsSync, readdirSync } = await import("node:fs");
    const { join } = await import("node:path");
    const projectsDir = join(resolveConfigDir(), "wiki", "projects");
    if (!existsSync(projectsDir)) return c.json({ projects: [] });
    const projects = readdirSync(projectsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
    return c.json({ projects });
  });

  app.get("/api/wiki/pages/:slug", async (c) => {
    const { readPage, resolveWikiDir } = await import("../wiki/storage");
    const slug = c.req.param("slug");
    // B-07: path-traversal guard. Without this, a slug like
    // "../../../.ssh/id_rsa" composed with `join("/wiki/notes", slug)` inside
    // readPage()'s pagePath() escapes the wiki dir and reads arbitrary `.md`
    // files post-auth. Allow only safe slug shapes; do NOT echo the raw
    // slug back to the caller.
    if (!/^[a-z0-9][a-z0-9._-]{0,127}$/.test(slug)) {
      return c.json({ error: "Invalid slug" }, 400);
    }
    const global = c.req.query("global") === "true";
    const wikiDir = resolveWikiDir({ global });
    const page = await readPage(slug, wikiDir);
    if (!page) return c.json({ error: "Page not found" }, 404);
    return c.json({ page });
  });

  // Serve static dashboard — must be after API routes
  const publicDir = join(import.meta.dir, "public");
  app.use("/*", serveStatic({ root: publicDir }));

  // SPA fallback — serve index.html for non-API routes
  app.get("/", async (c) => {
    const html = await Bun.file(join(publicDir, "index.html")).text();
    return c.html(html);
  });

  return app;
}
