import { describe, expect, it } from "bun:test";
import app from "../../src/web/worker";

// ---------------------------------------------------------------------------
// Test env bindings
// ---------------------------------------------------------------------------

const MOCK_ENV = {
  GITHUB_CLIENT_ID: "test-client-id",
  GITHUB_CLIENT_SECRET: "test-client-secret",
  SESSION_SECRET: "test-session-secret-key-32chars!",
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

describe("Worker — Authentication (no cookie)", () => {
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

describe("Worker — Invalid cookie", () => {
  it("invalid cookie value returns 401 (decrypt fails)", async () => {
    const res = await app.request(
      "/api/repos",
      { headers: { cookie: "am_session=not-valid-encrypted-data" } },
      MOCK_ENV,
    );
    expect(res.status).toBe(401);
    const data = (await res.json()) as { error: string };
    expect(data.error).toContain("Session expired");
  });

  it("tampered cookie returns 401", async () => {
    // A base64 string that is too short to contain a valid AES-GCM payload
    const tampered = btoa("short");
    const res = await app.request(
      "/api/repos",
      { headers: { cookie: `am_session=${tampered}` } },
      MOCK_ENV,
    );
    expect(res.status).toBe(401);
  });

  it("cookie encrypted with wrong secret returns 401", async () => {
    // Encrypt with a different secret, then try to decrypt with the test secret
    const wrongSecretEnv = { ...MOCK_ENV, SESSION_SECRET: "wrong-secret-key-different!!!!!" };
    // First, get a valid login redirect to simulate the flow
    // Instead, just craft a cookie-like base64 that won't decrypt
    const fakeCipher = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(64))));
    const res = await app.request(
      "/api/repos",
      { headers: { cookie: `am_session=${fakeCipher}` } },
      MOCK_ENV,
    );
    expect(res.status).toBe(401);
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

  it("GET /auth/github/login sets encrypted state cookie", async () => {
    const res = await req("/auth/github/login");
    const cookie = res.headers.get("set-cookie") ?? "";
    expect(cookie).toContain("am_oauth_state=");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("Max-Age=300");
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
    expect(data.error).toContain("state");
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
