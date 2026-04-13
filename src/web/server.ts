import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Hono } from "hono";
import { serveStatic } from "hono/bun";
import { getAdapter, getDetectedAdapters, listAdapters } from "../adapters/registry";
import { readActiveProfile, writeActiveProfile } from "../commands/use";
import {
  buildResolvedConfig,
  loadResolvedConfig,
  readConfig,
  resolveConfigDir,
  resolveProjectConfig,
  writeConfig,
} from "../core/config";
import { commitAll, getStatus, pull as gitPull, push as gitPush } from "../core/git";
import { encryptValue, generateKey, importKey, loadKey, saveKey } from "../core/secrets";
import { errorMessage } from "../lib/errors";

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
  writeFileSync(tokenPath, `${token}\n`, { encoding: "utf-8", mode: 0o600 });
  return token;
}

/**
 * Returns the path where the auth token is stored, for display to the user.
 */
export function getTokenPath(configDir: string): string {
  return join(configDir, TOKEN_FILENAME);
}

// ── Redact encrypted secrets from config responses ──────────────

function redactSecrets(obj: unknown): unknown {
  if (typeof obj === "string" && obj.startsWith("enc:v1:")) return "[encrypted]";
  if (Array.isArray(obj)) return obj.map(redactSecrets);
  if (obj && typeof obj === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      result[key] = redactSecrets(value);
    }
    return result;
  }
  return obj;
}

export function createApp() {
  const app = new Hono();
  const configDir = resolveConfigDir();
  const authToken = ensureAuthToken(configDir);

  // ── Auth middleware — require Bearer token on all non-health endpoints ──
  app.use("*", async (c, next) => {
    // Allow health check without auth
    if (c.req.path === "/api/health") return next();

    // Allow static assets without auth
    if (!c.req.path.startsWith("/api/")) return next();

    const authHeader = c.req.header("authorization");
    if (!authHeader) {
      return c.json(
        {
          error: "Authentication required",
          hint: `Provide Bearer token from ${getTokenPath(configDir)}`,
        },
        401,
      );
    }

    const [scheme, token] = authHeader.split(" ", 2);
    if (scheme?.toLowerCase() !== "bearer" || token !== authToken) {
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
    return c.json({ status: "ok", version: "0.1.0" });
  });

  app.get("/api/config", async (c) => {
    try {
      const { config, profileName } = await getConfigAndProfile();
      return c.json({ profile: profileName, config: redactSecrets(config) });
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

      const { config, configPath, configDir: dir } = await getConfigAndWritePath();
      if (!config.servers) config.servers = {};
      if (config.servers[name]) {
        return c.json({ error: `Server "${name}" already exists` }, 409);
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

      // Secret detection + encryption
      const { scanServerForSecrets, substituteSecret } = await import("../core/secret-detection");
      const scanResult = await scanServerForSecrets(name, config.servers[name]);
      if (scanResult.secrets.length > 0) {
        let key = await loadKey(dir);
        if (!key) {
          const b64 = await generateKey();
          await saveKey(dir, b64);
          key = await importKey(b64);
        }
        for (const secret of scanResult.secrets) {
          substituteSecret(config.servers[name], secret, secret.suggestedEnvVar);
          if (!config.settings) config.settings = {};
          if (!config.settings.env) config.settings.env = {};
          config.settings.env[secret.suggestedEnvVar] = await encryptValue(secret.value, key);
        }
      }

      await writeConfig(configPath, config);
      try {
        await commitAll(dir, `add server: ${name}`);
      } catch {}

      return c.json({ action: "add", server: name }, 201);
    } catch (err) {
      return c.json({ error: errorMessage(err) }, 500);
    }
  });

  app.put("/api/servers/:name", async (c) => {
    try {
      const serverName = c.req.param("name");
      const body = await c.req.json();

      const { config, configPath, configDir: dir } = await getConfigAndWritePath();
      if (!config.servers?.[serverName]) {
        return c.json({ error: `Server "${serverName}" not found` }, 404);
      }

      const existing = config.servers[serverName];
      if (body.command !== undefined) existing.command = body.command;
      if (body.args !== undefined) existing.args = body.args;
      if (body.env !== undefined) existing.env = body.env;
      if (body.tags !== undefined) existing.tags = body.tags;
      if (body.description !== undefined) existing.description = body.description;
      if (body.transport !== undefined) existing.transport = body.transport;
      if (body.enabled !== undefined) existing.enabled = body.enabled;

      await writeConfig(configPath, config);
      try {
        await commitAll(dir, `update server: ${serverName}`);
      } catch {}

      return c.json({ action: "update", server: serverName });
    } catch (err) {
      return c.json({ error: errorMessage(err) }, 500);
    }
  });

  app.delete("/api/servers/:name", async (c) => {
    try {
      const serverName = c.req.param("name");

      const { config, configPath, configDir: dir } = await getConfigAndWritePath();
      if (!config.servers?.[serverName]) {
        return c.json({ error: `Server "${serverName}" not found` }, 404);
      }

      delete config.servers[serverName];

      await writeConfig(configPath, config);
      try {
        await commitAll(dir, `remove server: ${serverName}`);
      } catch {}

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

      const imported = adapter.import({});
      const { config, configPath, configDir: dir } = await getConfigAndWritePath();

      // Merge imported servers into config
      if (imported.servers) {
        if (!config.servers) config.servers = {};
        for (const [name, srv] of Object.entries(imported.servers)) {
          config.servers[name] = srv;
        }
      }

      // Secret detection + encryption on imported servers
      if (imported.servers) {
        const { scanServerForSecrets, substituteSecret } = await import("../core/secret-detection");
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
              substituteSecret(config.servers![name], secret, secret.suggestedEnvVar);
              if (!config.settings) config.settings = {};
              if (!config.settings.env) config.settings.env = {};
              config.settings.env[secret.suggestedEnvVar] = await encryptValue(secret.value, key);
            }
          }
        }
      }

      await writeConfig(configPath, config);
      try {
        await commitAll(dir, `import from ${adapterName}`);
      } catch {}

      return c.json({
        action: "import",
        adapter: adapterName,
        servers: Object.keys(imported.servers ?? {}),
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
      let gitStatus;
      try {
        gitStatus = await getStatus(configDir);
      } catch {
        gitStatus = { branch: "unknown", clean: true, dirty: [], remotes: [] };
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
          const diffResult = adapter.diff(resolved);
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
      const { config, configDir, profileName } = await getConfigAndProfile();

      // Decrypt encrypted values before building resolved config
      const encryptionKey = await loadKey(configDir);
      const { config: interpolated } = await interpolateEnvAsync(config, {
        encryptionKey: encryptionKey ?? undefined,
      });

      const resolved = buildResolvedConfig(interpolated, profileName, configDir);

      const adapters = await getDetectedAdapters();
      const results: Array<{
        adapter: string;
        files: Array<{ path: string; written: boolean }>;
        warnings: string[];
      }> = [];

      for (const adapter of adapters) {
        try {
          const result = adapter.export(resolved, { dryRun: false });
          results.push({
            adapter: adapter.meta.name,
            files: result.files.map((f) => ({
              path: f.path,
              written: f.written,
            })),
            warnings: result.warnings,
          });
        } catch (e: unknown) {
          results.push({
            adapter: adapter.meta.name,
            files: [],
            warnings: [errorMessage(e) || "export failed"],
          });
        }
      }

      return c.json({
        action: "apply",
        profile: profileName,
        dryRun: false,
        results,
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
      return c.json({ error: errorMessage(e) || "Push failed" }, 500);
    }
  });

  app.post("/api/sync/pull", async (c) => {
    try {
      const configDir = resolveConfigDir();
      await gitPull(configDir);
      return c.json({ action: "pull", success: true });
    } catch (e: unknown) {
      return c.json({ error: errorMessage(e) || "Pull failed" }, 500);
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

  // ── A2A Agent Card endpoint ────────────────────────────────────
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
    const global = c.req.query("global") === "true";
    const wikiDir = resolveWikiDir({ global });
    const page = await readPage(c.req.param("slug"), wikiDir);
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
