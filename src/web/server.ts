import { Hono } from "hono";
import { serveStatic } from "hono/bun";
import { join } from "node:path";
import {
  resolveConfigDir,
  loadResolvedConfig,
  resolveProjectConfig,
} from "../core/config";
import { getStatus, push as gitPush, pull as gitPull } from "../core/git";
import { readActiveProfile, writeActiveProfile } from "../commands/use";
import {
  getDetectedAdapters,
  getAdapter,
  listAdapters,
} from "../adapters/registry";
import type { ResolvedConfig, ResolvedServer } from "../adapters/types";

export function createApp() {
  const app = new Hono();

  // --- Helpers ---

  function buildResolvedConfig(
    config: Awaited<ReturnType<typeof loadResolvedConfig>>,
    profileName: string,
  ): ResolvedConfig {
    const servers: Record<string, ResolvedServer> = {};
    for (const [name, srv] of Object.entries(config.servers ?? {})) {
      servers[name] = {
        name,
        command: srv.command,
        args: srv.args ?? [],
        env: srv.env ?? {},
        transport: srv.transport ?? "stdio",
        description: srv.description ?? "",
        tags: srv.tags ?? [],
        enabled: srv.enabled ?? true,
        adapters:
          (srv.adapters as Record<string, Record<string, unknown>>) ?? {},
      };
    }
    return {
      servers,
      instructions: {},
      skills: {},
      agents: {},
      profile: profileName,
      adapters:
        (config.adapters as Record<string, Record<string, unknown>>) ?? {},
    };
  }

  async function getConfigAndProfile() {
    const configDir = resolveConfigDir();
    const projectFile = resolveProjectConfig(process.cwd());
    const config = await loadResolvedConfig({ configDir, projectFile });
    const profileName =
      (await readActiveProfile(configDir)) ??
      config.settings?.default_profile ??
      "default";
    return { configDir, config, profileName };
  }

  // --- API Routes ---

  app.get("/api/health", (c) => {
    return c.json({ status: "ok", version: "0.1.0" });
  });

  app.get("/api/config", async (c) => {
    try {
      const { config, profileName } = await getConfigAndProfile();
      return c.json({ profile: profileName, config });
    } catch {
      return c.json({ error: "Config not found. Run `am init` first." }, 500);
    }
  });

  app.get("/api/servers", async (c) => {
    try {
      const { config } = await getConfigAndProfile();
      const servers = Object.entries(config.servers ?? {}).map(
        ([name, srv]) => ({
          name,
          command: srv.command,
          args: srv.args ?? [],
          tags: srv.tags ?? [],
          enabled: srv.enabled ?? true,
          description: srv.description ?? "",
          transport: srv.transport ?? "stdio",
        }),
      );
      return c.json({ servers });
    } catch {
      return c.json({ error: "Config not found" }, 500);
    }
  });

  app.get("/api/profiles", async (c) => {
    try {
      const { config, profileName } = await getConfigAndProfile();
      const profiles = Object.entries(config.profiles ?? {}).map(
        ([name, profile]) => ({
          name,
          description: profile.description ?? "",
          inherits: profile.inherits ?? null,
          active: name === profileName,
        }),
      );
      return c.json({ profiles, active: profileName });
    } catch {
      return c.json({ error: "Config not found" }, 500);
    }
  });

  app.get("/api/status", async (c) => {
    try {
      const { config, configDir, profileName } = await getConfigAndProfile();
      const resolved = buildResolvedConfig(config, profileName);

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
    } catch (e: any) {
      return c.json({ error: e?.message ?? "Failed to switch profile" }, 500);
    }
  });

  app.post("/api/apply", async (c) => {
    try {
      const { config, profileName } = await getConfigAndProfile();
      const resolved = buildResolvedConfig(config, profileName);

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
        } catch (e: any) {
          results.push({
            adapter: adapter.meta.name,
            files: [],
            warnings: [e?.message ?? "export failed"],
          });
        }
      }

      return c.json({
        action: "apply",
        profile: profileName,
        dryRun: false,
        results,
      });
    } catch (e: any) {
      return c.json({ error: e?.message ?? "Apply failed" }, 500);
    }
  });

  app.post("/api/sync/push", async (c) => {
    try {
      const configDir = resolveConfigDir();
      await gitPush(configDir);
      return c.json({ action: "push", success: true });
    } catch (e: any) {
      return c.json({ error: e?.message ?? "Push failed" }, 500);
    }
  });

  app.post("/api/sync/pull", async (c) => {
    try {
      const configDir = resolveConfigDir();
      await gitPull(configDir);
      return c.json({ action: "pull", success: true });
    } catch (e: any) {
      return c.json({ error: e?.message ?? "Pull failed" }, 500);
    }
  });

  // SSE endpoint for real-time status
  app.get("/api/events", async (c) => {
    const stream = new ReadableStream({
      start(controller) {
        const encoder = new TextEncoder();
        const send = (event: string, data: unknown) => {
          controller.enqueue(
            encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`),
          );
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
