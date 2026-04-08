import { describe, it, expect } from "bun:test";
import app from "../../src/web/worker";

// ---------------------------------------------------------------------------
// Mock KV store — in-memory implementation matching the KVStore interface
// in worker.ts (avoids needing @cloudflare/workers-types globally)
// ---------------------------------------------------------------------------

interface KVStore {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void>;
  delete(key: string): Promise<void>;
}

function createMockKV(): KVStore {
  const store = new Map<string, { value: string; expiry?: number }>();
  return {
    get: async (key: string) => {
      const entry = store.get(key);
      if (!entry) return null;
      if (entry.expiry && Date.now() > entry.expiry) {
        store.delete(key);
        return null;
      }
      return entry.value;
    },
    put: async (key: string, value: string, opts?: { expirationTtl?: number }) => {
      const expiry = opts?.expirationTtl
        ? Date.now() + opts.expirationTtl * 1000
        : undefined;
      store.set(key, { value, expiry });
    },
    delete: async (key: string) => {
      store.delete(key);
    },
  };
}

// ---------------------------------------------------------------------------
// Test env bindings
// ---------------------------------------------------------------------------

const MOCK_ENV = {
  GITHUB_CLIENT_ID: "test-client-id",
  GITHUB_CLIENT_SECRET: "test-client-secret",
  SESSION_SECRET: "test-session-secret",
  AM_SESSIONS: createMockKV(),
  ENVIRONMENT: "test",
};

function req(path: string, init?: RequestInit) {
  return app.request(path, init, MOCK_ENV);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Worker — Health check", () => {
  it("GET /api/health returns 200 with runtime marker", async () => {
    const res = await req("/api/health");
    expect(res.status).toBe(200);
    const data = (await res.json()) as { status: string; version: string; runtime: string };
    expect(data.status).toBe("ok");
    expect(data.version).toBe("0.1.0");
    expect(data.runtime).toBe("cloudflare-workers");
  });
});

describe("Worker — Authentication", () => {
  it("GET /api/repos without session returns 401", async () => {
    const res = await req("/api/repos");
    expect(res.status).toBe(401);
    const data = (await res.json()) as { error: string; login: string };
    expect(data.error).toContain("Not authenticated");
    expect(data.login).toBe("/auth/github/login");
  });

  it("GET /api/servers/:owner/:repo without session returns 401", async () => {
    const res = await req("/api/servers/user/repo");
    expect(res.status).toBe(401);
    const data = (await res.json()) as { error: string };
    expect(data.error).toContain("Not authenticated");
  });

  it("GET /api/config/:owner/:repo without session returns 401", async () => {
    const res = await req("/api/config/user/repo");
    expect(res.status).toBe(401);
  });

  it("POST /api/config/:owner/:repo without session returns 401", async () => {
    const res = await req("/api/config/user/repo", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "test", message: "test" }),
    });
    expect(res.status).toBe(401);
  });

  it("GET /auth/check without session returns authenticated: false", async () => {
    const res = await req("/auth/check");
    expect(res.status).toBe(200);
    const data = (await res.json()) as { authenticated: boolean };
    expect(data.authenticated).toBe(false);
  });
});

describe("Worker — OAuth flow", () => {
  it("GET /auth/github/login redirects to GitHub OAuth", async () => {
    const res = await req("/auth/github/login");
    expect(res.status).toBe(302);
    const location = res.headers.get("location");
    expect(location).toBeTruthy();
    expect(location).toContain("github.com/login/oauth/authorize");
    expect(location).toContain("client_id=test-client-id");
    expect(location).toContain("scope=repo");
    expect(location).toContain("state=");
  });

  it("GET /auth/github/callback without code returns 400", async () => {
    const res = await req("/auth/github/callback");
    expect(res.status).toBe(400);
    const data = (await res.json()) as { error: string };
    expect(data.error).toContain("Missing code or state");
  });

  it("GET /auth/github/callback with invalid state returns 403", async () => {
    const res = await req("/auth/github/callback?code=abc&state=bad-state");
    expect(res.status).toBe(403);
    const data = (await res.json()) as { error: string };
    expect(data.error).toContain("CSRF");
  });

  it("POST /auth/logout clears session cookie", async () => {
    const res = await req("/auth/logout", { method: "POST" });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/");
    const cookie = res.headers.get("set-cookie") ?? "";
    expect(cookie).toContain("am_session=");
    expect(cookie).toContain("Max-Age=0");
  });
});

describe("Worker — Session with valid cookie", () => {
  it("expired session returns 401", async () => {
    // Create a session, then delete it from KV to simulate expiry
    const kv = MOCK_ENV.AM_SESSIONS;
    const sessionId = "test-expired-session";
    await kv.put(`session:${sessionId}`, JSON.stringify({ token: "tok", created: Date.now() }));
    await kv.delete(`session:${sessionId}`);

    const res = await app.request("/api/repos", {
      headers: { cookie: `am_session=${sessionId}` },
    }, MOCK_ENV);

    expect(res.status).toBe(401);
    const data = (await res.json()) as { error: string };
    expect(data.error).toContain("Session expired");
  });
});
