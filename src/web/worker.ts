/**
 * Cloudflare Workers entry point for agent-manager web UI.
 *
 * Stateless, git-backed via GitHub API. The CLI's `am serve` stays for local
 * use; this worker is for cloud deployment. See ADR-0015 for architecture.
 */
import { Hono } from "hono";
import { cors } from "hono/cors";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Cloudflare Workers KV — minimal interface for type safety without
 *  requiring @cloudflare/workers-types in the main tsconfig. */
interface KVStore {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void>;
  delete(key: string): Promise<void>;
}

type Bindings = {
  GITHUB_CLIENT_ID: string;
  GITHUB_CLIENT_SECRET: string;
  SESSION_SECRET: string;
  AM_SESSIONS: KVStore;
  ENVIRONMENT: string;
  ASSETS?: { fetch: (req: Request) => Promise<Response> };
};

type Variables = {
  githubToken: string;
};

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------

const app = new Hono<{ Bindings: Bindings; Variables: Variables }>();

// CORS for the SPA
app.use("/api/*", cors());

// ---------------------------------------------------------------------------
// Health check (unauthenticated)
// ---------------------------------------------------------------------------

app.get("/api/health", (c) =>
  c.json({ status: "ok", version: "0.1.0", runtime: "cloudflare-workers" }),
);

// ---------------------------------------------------------------------------
// GitHub OAuth flow
// ---------------------------------------------------------------------------

app.get("/auth/github/login", async (c) => {
  const clientId = c.env.GITHUB_CLIENT_ID;
  const redirectUri = new URL("/auth/github/callback", c.req.url).toString();
  const state = crypto.randomUUID();

  // Store state in KV for CSRF verification (5 min TTL)
  await c.env.AM_SESSIONS.put(`oauth-state:${state}`, "1", {
    expirationTtl: 300,
  });

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    scope: "repo",
    state,
  });

  return c.redirect(`https://github.com/login/oauth/authorize?${params}`);
});

app.get("/auth/github/callback", async (c) => {
  const code = c.req.query("code");
  const state = c.req.query("state");

  if (!code || !state) {
    return c.json({ error: "Missing code or state" }, 400);
  }

  // Verify CSRF state
  const valid = await c.env.AM_SESSIONS.get(`oauth-state:${state}`);
  if (!valid) {
    return c.json({ error: "Invalid state — CSRF check failed" }, 403);
  }
  await c.env.AM_SESSIONS.delete(`oauth-state:${state}`);

  // Exchange code for access token
  const tokenRes = await fetch(
    "https://github.com/login/oauth/access_token",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        client_id: c.env.GITHUB_CLIENT_ID,
        client_secret: c.env.GITHUB_CLIENT_SECRET,
        code,
      }),
    },
  );

  const tokenData = (await tokenRes.json()) as {
    access_token?: string;
    error?: string;
  };

  if (!tokenData.access_token) {
    return c.json(
      { error: tokenData.error ?? "Token exchange failed" },
      400,
    );
  }

  // Create session in KV (24h TTL)
  const sessionId = crypto.randomUUID();
  await c.env.AM_SESSIONS.put(
    `session:${sessionId}`,
    JSON.stringify({ token: tokenData.access_token, created: Date.now() }),
    { expirationTtl: 86400 },
  );

  return new Response(null, {
    status: 302,
    headers: {
      Location: "/",
      "Set-Cookie": `am_session=${sessionId}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=86400`,
    },
  });
});

// Logout
app.post("/auth/logout", async (c) => {
  const sessionId = getSessionId(c);
  if (sessionId) {
    await c.env.AM_SESSIONS.delete(`session:${sessionId}`);
  }
  return new Response(null, {
    status: 302,
    headers: {
      Location: "/",
      "Set-Cookie":
        "am_session=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0",
    },
  });
});

// ---------------------------------------------------------------------------
// Auth check endpoint (for the SPA to detect login state)
// ---------------------------------------------------------------------------

app.get("/auth/check", async (c) => {
  const sessionId = getSessionId(c);
  if (!sessionId) {
    return c.json({ authenticated: false });
  }
  const sessionData = await c.env.AM_SESSIONS.get(`session:${sessionId}`);
  if (!sessionData) {
    return c.json({ authenticated: false });
  }
  // Fetch GitHub user info
  const session = JSON.parse(sessionData);
  try {
    const userRes = await fetch("https://api.github.com/user", {
      headers: {
        Authorization: `Bearer ${session.token}`,
        "User-Agent": "agent-manager",
      },
    });
    if (!userRes.ok) {
      return c.json({ authenticated: false });
    }
    const user = (await userRes.json()) as { login: string; avatar_url: string };
    return c.json({ authenticated: true, user: { login: user.login, avatar: user.avatar_url } });
  } catch {
    return c.json({ authenticated: false });
  }
});

// ---------------------------------------------------------------------------
// Auth middleware for /api/* (skip health check)
// ---------------------------------------------------------------------------

app.use("/api/*", async (c, next) => {
  if (c.req.path === "/api/health") return next();

  const sessionId = getSessionId(c);
  if (!sessionId) {
    return c.json(
      { error: "Not authenticated", login: "/auth/github/login" },
      401,
    );
  }

  const sessionData = await c.env.AM_SESSIONS.get(`session:${sessionId}`);
  if (!sessionData) {
    return c.json(
      { error: "Session expired", login: "/auth/github/login" },
      401,
    );
  }

  const session = JSON.parse(sessionData);
  c.set("githubToken", session.token);
  return next();
});

// ---------------------------------------------------------------------------
// API: List user's repos (to pick config repo)
// ---------------------------------------------------------------------------

app.get("/api/repos", async (c) => {
  const token = c.get("githubToken");
  const res = await fetch(
    "https://api.github.com/user/repos?per_page=100&sort=updated",
    {
      headers: {
        Authorization: `Bearer ${token}`,
        "User-Agent": "agent-manager",
      },
    },
  );

  if (!res.ok) {
    return c.json({ error: "Failed to fetch repos" }, res.status as any);
  }

  const repos = (await res.json()) as Array<{
    full_name: string;
    clone_url: string;
    private: boolean;
    updated_at: string;
  }>;

  return c.json(
    repos.map((r) => ({
      name: r.full_name,
      url: r.clone_url,
      private: r.private,
      updated: r.updated_at,
    })),
  );
});

// ---------------------------------------------------------------------------
// API: Read config from a repo
// ---------------------------------------------------------------------------

app.get("/api/config/:owner/:repo", async (c) => {
  const token = c.get("githubToken");
  const { owner, repo } = c.req.param();

  const res = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/contents/config.toml`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        "User-Agent": "agent-manager",
        Accept: "application/vnd.github.v3.raw",
      },
    },
  );

  if (!res.ok) {
    return c.json({ error: "Config not found", status: res.status }, 404);
  }

  const content = await res.text();

  // TOML parsing — dynamic import so it degrades gracefully in Workers
  try {
    const TOML = await import("@iarna/toml");
    const parsed = TOML.parse(content);
    return c.json({ raw: content, parsed });
  } catch {
    return c.json({
      raw: content,
      parsed: null,
      warning: "TOML parsing unavailable — returning raw content",
    });
  }
});

// ---------------------------------------------------------------------------
// API: List servers from a repo's config
// ---------------------------------------------------------------------------

app.get("/api/servers/:owner/:repo", async (c) => {
  const token = c.get("githubToken");
  const { owner, repo } = c.req.param();

  const res = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/contents/config.toml`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        "User-Agent": "agent-manager",
        Accept: "application/vnd.github.v3.raw",
      },
    },
  );

  if (!res.ok) {
    return c.json({ error: "Config not found" }, 404);
  }

  const content = await res.text();

  try {
    const TOML = await import("@iarna/toml");
    const config = TOML.parse(content) as Record<string, any>;
    const servers = Object.entries(config.servers ?? {}).map(
      ([name, s]: [string, any]) => ({
        name,
        command: s.command,
        args: s.args,
        tags: s.tags,
        enabled: s.enabled ?? true,
      }),
    );
    return c.json({ servers });
  } catch (e) {
    return c.json(
      { error: "Failed to parse config", detail: String(e) },
      500,
    );
  }
});

// ---------------------------------------------------------------------------
// API: Commit a change to the repo (edit config.toml)
// ---------------------------------------------------------------------------

app.post("/api/config/:owner/:repo", async (c) => {
  const token = c.get("githubToken");
  const { owner, repo } = c.req.param();
  const body = (await c.req.json()) as { content: string; message?: string };

  if (!body.content) {
    return c.json({ error: "Missing content field" }, 400);
  }

  // Get current file SHA (required for update)
  const getRes = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/contents/config.toml`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        "User-Agent": "agent-manager",
      },
    },
  );

  if (!getRes.ok) {
    return c.json({ error: "Config not found" }, 404);
  }

  const fileData = (await getRes.json()) as { sha: string };

  // Update file via GitHub Contents API
  const updateRes = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/contents/config.toml`,
    {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${token}`,
        "User-Agent": "agent-manager",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        message:
          body.message ?? "Update config via agent-manager web UI",
        content: btoa(body.content),
        sha: fileData.sha,
      }),
    },
  );

  if (!updateRes.ok) {
    const err = await updateRes.json();
    return c.json({ error: "Commit failed", detail: err }, 500);
  }

  const result = (await updateRes.json()) as { commit: { sha: string } };
  return c.json({ success: true, sha: result.commit.sha });
});

// ---------------------------------------------------------------------------
// Static assets — Cloudflare Workers static assets via `assets` in wrangler.toml
// serve index.html for all non-API, non-auth routes (SPA fallback)
// ---------------------------------------------------------------------------

app.get("/*", async (c) => {
  // Workers Sites / assets binding handles static files automatically via
  // the `assets` config in wrangler.toml. For any unmatched route, serve
  // index.html so the SPA can handle client-side routing.
  return c.env.ASSETS
    ? c.env.ASSETS.fetch(new Request(new URL("/index.html", c.req.url)))
    : c.text("Not found", 404);
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getSessionId(c: { req: { header: (name: string) => string | undefined } }): string | null {
  const cookie = c.req.header("cookie") ?? "";
  const match = cookie.match(/am_session=([^;]+)/);
  return match?.[1] ?? null;
}

export default app;
