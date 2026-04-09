/**
 * Cloudflare Workers entry point for agent-manager web UI.
 *
 * FULLY STATELESS — no KV, D1, or R2. Zero persistent storage.
 * Sessions use encrypted cookies. Config lives in user's git repo.
 * See ADR-0015 for architecture.
 */
import { Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Bindings = {
  GITHUB_CLIENT_ID: string;
  GITHUB_CLIENT_SECRET: string;
  SESSION_SECRET: string;
  ENVIRONMENT: string;
  ASSETS?: { fetch: (req: Request) => Promise<Response> };
};

type Variables = {
  githubToken: string;
};

// ---------------------------------------------------------------------------
// Cookie-based session helpers (no persistent storage)
// ---------------------------------------------------------------------------

async function encryptSession(data: Record<string, unknown>, secret: string): Promise<string> {
  const key = await deriveKey(secret);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(JSON.stringify(data));
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, encoded);
  const combined = new Uint8Array(iv.length + new Uint8Array(ciphertext).length);
  combined.set(iv);
  combined.set(new Uint8Array(ciphertext), iv.length);
  return btoa(String.fromCharCode(...combined));
}

async function decryptSession(
  encrypted: string,
  secret: string,
): Promise<Record<string, unknown> | null> {
  try {
    const key = await deriveKey(secret);
    const combined = Uint8Array.from(atob(encrypted), (c) => c.charCodeAt(0));
    const iv = combined.slice(0, 12);
    const ciphertext = combined.slice(12);
    const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ciphertext);
    return JSON.parse(new TextDecoder().decode(plaintext));
  } catch {
    return null;
  }
}

async function deriveKey(secret: string): Promise<CryptoKey> {
  const encoder = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey("raw", encoder.encode(secret), "HKDF", false, [
    "deriveKey",
  ]);
  return crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: encoder.encode("agent-manager-session"),
      info: encoder.encode("aes-gcm-key"),
    },
    keyMaterial,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

function getSessionCookie(c: {
  req: { header: (name: string) => string | undefined };
}): string | null {
  const cookie = c.req.header("cookie") ?? "";
  const match = cookie.match(/am_session=([^;]+)/);
  return match?.[1] ?? null;
}

function sessionCookie(value: string, maxAge = 86400): string {
  return `am_session=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
}

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------

const app = new Hono<{ Bindings: Bindings; Variables: Variables }>();

// ---------------------------------------------------------------------------
// Health check (unauthenticated)
// ---------------------------------------------------------------------------

app.get("/api/health", (c) =>
  c.json({ status: "ok", version: "0.1.0", runtime: "cloudflare-workers" }),
);

// ---------------------------------------------------------------------------
// GitHub OAuth flow (stateless — CSRF state in short-lived encrypted cookie)
// ---------------------------------------------------------------------------

app.get("/auth/github/login", async (c) => {
  const clientId = c.env.GITHUB_CLIENT_ID;
  const redirectUri = new URL("/auth/github/callback", c.req.url).toString();
  const state = crypto.randomUUID();

  // Store CSRF state in a short-lived encrypted cookie (5 min)
  const stateCookie = await encryptSession({ state, ts: Date.now() }, c.env.SESSION_SECRET);

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    // Minimal OAuth scopes: contents:read for pull, contents:write for push.
    // Avoids overly broad 'repo' scope that grants access to all repo settings.
    scope: "contents:read contents:write",
    state,
  });

  return new Response(null, {
    status: 302,
    headers: {
      Location: `https://github.com/login/oauth/authorize?${params}`,
      "Set-Cookie": `am_oauth_state=${stateCookie}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=300`,
    },
  });
});

app.get("/auth/github/callback", async (c) => {
  const code = c.req.query("code");
  const state = c.req.query("state");

  if (!code || !state) {
    return c.json({ error: "Missing code or state" }, 400);
  }

  // Verify CSRF state from cookie
  const stateCookieRaw = c.req.header("cookie")?.match(/am_oauth_state=([^;]+)/)?.[1];
  if (!stateCookieRaw) {
    return c.json({ error: "Missing state cookie" }, 403);
  }

  const stateData = await decryptSession(stateCookieRaw, c.env.SESSION_SECRET);
  if (!stateData || stateData.state !== state) {
    return c.json({ error: "Invalid state — CSRF check failed" }, 403);
  }

  // Check state isn't too old (5 min)
  if (Date.now() - (stateData.ts as number) > 300000) {
    return c.json({ error: "State expired" }, 403);
  }

  // Exchange code for access token
  const tokenRes = await fetch("https://github.com/login/oauth/access_token", {
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
  });

  const tokenData = (await tokenRes.json()) as {
    access_token?: string;
    error?: string;
  };

  if (!tokenData.access_token) {
    return c.json({ error: tokenData.error ?? "Token exchange failed" }, 400);
  }

  // Create encrypted session cookie (no server-side storage)
  const sessionCookieValue = await encryptSession(
    { token: tokenData.access_token, created: Date.now() },
    c.env.SESSION_SECRET,
  );

  const headers = new Headers();
  headers.set("Location", "/");
  headers.append("Set-Cookie", sessionCookie(sessionCookieValue));
  headers.append("Set-Cookie", "am_oauth_state=; Path=/; HttpOnly; Secure; Max-Age=0");
  return new Response(null, { status: 302, headers });
});

// Logout — just clear the cookie
app.post("/auth/logout", (c) => {
  return new Response(null, {
    status: 302,
    headers: {
      Location: "/",
      "Set-Cookie": sessionCookie("", 0),
    },
  });
});

// ---------------------------------------------------------------------------
// Auth check (for SPA to detect login state)
// ---------------------------------------------------------------------------

app.get("/auth/check", async (c) => {
  const encrypted = getSessionCookie(c);
  if (!encrypted) return c.json({ authenticated: false });

  const session = await decryptSession(encrypted, c.env.SESSION_SECRET);
  if (!session?.token) return c.json({ authenticated: false });

  try {
    const userRes = await fetch("https://api.github.com/user", {
      headers: {
        Authorization: `Bearer ${session.token}`,
        "User-Agent": "agent-manager",
      },
    });
    if (!userRes.ok) return c.json({ authenticated: false });
    const user = (await userRes.json()) as {
      login: string;
      avatar_url: string;
    };
    return c.json({
      authenticated: true,
      user: { login: user.login, avatar: user.avatar_url },
    });
  } catch {
    return c.json({ authenticated: false });
  }
});

// ---------------------------------------------------------------------------
// Auth middleware for /api/* (skip health check)
// ---------------------------------------------------------------------------

app.use("/api/*", async (c, next) => {
  if (c.req.path === "/api/health") return next();

  const encrypted = getSessionCookie(c);
  if (!encrypted) {
    return c.json({ error: "Not authenticated", login: "/auth/github/login" }, 401);
  }

  const session = await decryptSession(encrypted, c.env.SESSION_SECRET);
  if (!session?.token) {
    return c.json({ error: "Session expired", login: "/auth/github/login" }, 401);
  }

  c.set("githubToken", session.token as string);
  return next();
});

// ---------------------------------------------------------------------------
// API: List user's repos
// ---------------------------------------------------------------------------

app.get("/api/repos", async (c) => {
  const token = c.get("githubToken");
  const res = await fetch("https://api.github.com/user/repos?per_page=100&sort=updated", {
    headers: {
      Authorization: `Bearer ${token}`,
      "User-Agent": "agent-manager",
    },
  });

  if (!res.ok) {
    return c.json({ error: "Failed to fetch repos" }, res.status as ContentfulStatusCode);
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

  const res = await fetch(`https://api.github.com/repos/${owner}/${repo}/contents/config.toml`, {
    headers: {
      Authorization: `Bearer ${token}`,
      "User-Agent": "agent-manager",
      Accept: "application/vnd.github.v3.raw",
    },
  });

  if (!res.ok) {
    return c.json({ error: "Config not found", status: res.status }, 404);
  }

  const content = await res.text();

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

  const res = await fetch(`https://api.github.com/repos/${owner}/${repo}/contents/config.toml`, {
    headers: {
      Authorization: `Bearer ${token}`,
      "User-Agent": "agent-manager",
      Accept: "application/vnd.github.v3.raw",
    },
  });

  if (!res.ok) return c.json({ error: "Config not found" }, 404);

  const content = await res.text();
  try {
    const TOML = await import("@iarna/toml");
    const config = TOML.parse(content) as Record<string, any>;
    const servers = Object.entries(config.servers ?? {}).map(([name, s]: [string, any]) => ({
      name,
      command: s.command,
      args: s.args,
      tags: s.tags,
      enabled: s.enabled ?? true,
    }));
    return c.json({ servers });
  } catch (e) {
    return c.json({ error: "Failed to parse config", detail: String(e) }, 500);
  }
});

// ---------------------------------------------------------------------------
// API: Commit a change to the repo
// ---------------------------------------------------------------------------

app.post("/api/config/:owner/:repo", async (c) => {
  const token = c.get("githubToken");
  const { owner, repo } = c.req.param();
  const body = (await c.req.json()) as { content: string; message?: string };

  if (!body.content) {
    return c.json({ error: "Missing content field" }, 400);
  }

  const getRes = await fetch(`https://api.github.com/repos/${owner}/${repo}/contents/config.toml`, {
    headers: {
      Authorization: `Bearer ${token}`,
      "User-Agent": "agent-manager",
    },
  });

  if (!getRes.ok) return c.json({ error: "Config not found" }, 404);

  const fileData = (await getRes.json()) as { sha: string };

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
        message: body.message ?? "Update config via agent-manager web UI",
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
// Static assets — SPA fallback
// ---------------------------------------------------------------------------

app.get("/*", async (c) => {
  return c.env.ASSETS
    ? c.env.ASSETS.fetch(new Request(new URL("/index.html", c.req.url)))
    : c.text("Not found", 404);
});

export default app;
