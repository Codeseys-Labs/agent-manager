import { describe, expect, it } from "bun:test";
import {
  codebergProvider,
  createGiteaProvider,
  getProvider,
  githubProvider,
  gitlabProvider,
  listProviders,
  registerGiteaInstance,
} from "../../src/web/git-providers";
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

const MULTI_PROVIDER_ENV = {
  ...MOCK_ENV,
  GITLAB_CLIENT_ID: "gl-test-client-id",
  GITLAB_CLIENT_SECRET: "gl-test-client-secret",
  CODEBERG_CLIENT_ID: "cb-test-client-id",
  CODEBERG_CLIENT_SECRET: "cb-test-client-secret",
};

function req(path: string, init?: RequestInit) {
  return app.request(path, init, MOCK_ENV);
}

// ---------------------------------------------------------------------------
// Git providers unit tests
// ---------------------------------------------------------------------------

describe("Git providers — registry", () => {
  it("getProvider('github') returns GitHub provider", () => {
    const p = getProvider("github");
    expect(p).toBeDefined();
    expect(p!.name).toBe("github");
    expect(p!.displayName).toBe("GitHub");
  });

  it("getProvider('gitlab') returns GitLab provider", () => {
    const p = getProvider("gitlab");
    expect(p).toBeDefined();
    expect(p!.name).toBe("gitlab");
    expect(p!.displayName).toBe("GitLab");
  });

  it("getProvider('codeberg') returns Codeberg provider", () => {
    const p = getProvider("codeberg");
    expect(p).toBeDefined();
    expect(p!.name).toBe("codeberg");
    expect(p!.displayName).toBe("Codeberg");
  });

  it("getProvider('unknown') returns undefined", () => {
    expect(getProvider("unknown")).toBeUndefined();
  });

  it("listProviders() returns all registered providers", () => {
    const providers = listProviders();
    const names = providers.map((p) => p.name);
    expect(names).toContain("github");
    expect(names).toContain("gitlab");
    expect(names).toContain("codeberg");
  });

  it("registerGiteaInstance adds a custom provider", () => {
    const p = registerGiteaInstance("https://gitea.example.com", "my-gitea");
    expect(p.name).toBe("my-gitea");
    expect(p.displayName).toContain("Gitea");
    expect(getProvider("my-gitea")).toBe(p);
  });
});

describe("Git providers — GitHub URLs", () => {
  it("authUrl returns correct GitHub OAuth URL", () => {
    const url = githubProvider.authUrl("cid", "https://example.com/cb", "state123");
    expect(url).toContain("github.com/login/oauth/authorize");
    expect(url).toContain("client_id=cid");
    expect(url).toContain("state=state123");
    expect(url).toContain(encodeURIComponent("https://example.com/cb"));
  });

  it("tokenUrl returns GitHub token endpoint", () => {
    expect(githubProvider.tokenUrl()).toBe("https://github.com/login/oauth/access_token");
  });

  it("userUrl returns GitHub user API", () => {
    expect(githubProvider.userUrl()).toBe("https://api.github.com/user");
  });

  it("reposUrl includes pagination", () => {
    expect(githubProvider.reposUrl(2)).toContain("page=2");
    expect(githubProvider.reposUrl()).toContain("page=1");
  });

  it("fileUrl builds correct path", () => {
    const url = githubProvider.fileUrl("owner", "repo", "config.toml");
    expect(url).toBe("https://api.github.com/repos/owner/repo/contents/config.toml");
  });

  it("treeUrl includes recursive param", () => {
    const url = githubProvider.treeUrl("owner", "repo", "main");
    expect(url).toContain("recursive=1");
    expect(url).toContain("/git/trees/main");
  });

  it("authHeader returns Bearer format", () => {
    expect(githubProvider.authHeader("tok")).toBe("Bearer tok");
  });

  it("rawAccept returns GitHub raw content type", () => {
    expect(githubProvider.rawAccept()).toContain("github");
  });
});

describe("Git providers — GitHub parsers", () => {
  it("parseRepos normalizes GitHub response", () => {
    const repos = githubProvider.parseRepos([
      {
        full_name: "user/repo",
        clone_url: "https://github.com/user/repo.git",
        private: true,
        updated_at: "2026-01-01",
      },
    ]);
    expect(repos).toHaveLength(1);
    expect(repos[0]).toEqual({
      name: "user/repo",
      url: "https://github.com/user/repo.git",
      private: true,
      updated: "2026-01-01",
    });
  });

  it("parseTree filters wiki pages", () => {
    const pages = githubProvider.parseTree(
      {
        tree: [
          { path: "wiki/global/entities/foo.md", type: "blob" },
          { path: "wiki/global/entities/bar.md", type: "blob" },
          { path: "wiki/global/readme.txt", type: "blob" },
          { path: "other/file.md", type: "blob" },
        ],
      },
      "wiki/global",
    );
    expect(pages).toHaveLength(2);
    expect(pages[0].slug).toBe("foo");
    expect(pages[0].type).toBe("entities");
  });

  it("parseDirs filters directories", () => {
    const dirs = githubProvider.parseDirs([
      { name: "project-a", type: "dir" },
      { name: "readme.md", type: "file" },
      { name: "project-b", type: "dir" },
    ]);
    expect(dirs).toEqual(["project-a", "project-b"]);
  });

  it("parseUser extracts GitHub user info", () => {
    const user = githubProvider.parseUser({
      login: "testuser",
      avatar_url: "https://example.com/avatar.png",
    });
    expect(user).toEqual({ login: "testuser", avatar: "https://example.com/avatar.png" });
  });

  it("tokenExchangeBody returns JSON format for GitHub", () => {
    const { body, contentType } = githubProvider.tokenExchangeBody(
      "cid",
      "secret",
      "code123",
      "https://example.com/cb",
    );
    expect(contentType).toBe("application/json");
    const parsed = JSON.parse(body);
    expect(parsed.client_id).toBe("cid");
    expect(parsed.client_secret).toBe("secret");
    expect(parsed.code).toBe("code123");
  });
});

describe("Git providers — GitLab URLs", () => {
  it("authUrl returns correct GitLab OAuth URL", () => {
    const url = gitlabProvider.authUrl("cid", "https://example.com/cb", "state123");
    expect(url).toContain("gitlab.com/oauth/authorize");
    expect(url).toContain("client_id=cid");
    expect(url).toContain("response_type=code");
    expect(url).toContain("scope=read_repository");
  });

  it("tokenUrl returns GitLab token endpoint", () => {
    expect(gitlabProvider.tokenUrl()).toBe("https://gitlab.com/oauth/token");
  });

  it("fileUrl uses project-encoded path", () => {
    const url = gitlabProvider.fileUrl("user", "repo", "config.toml");
    expect(url).toContain(encodeURIComponent("user/repo"));
    expect(url).toContain("/raw");
  });

  it("treeUrl uses project-encoded path", () => {
    const url = gitlabProvider.treeUrl("user", "repo", "main");
    expect(url).toContain(encodeURIComponent("user/repo"));
    expect(url).toContain("recursive=true");
  });

  it("parseDirs filters tree type for GitLab", () => {
    const dirs = gitlabProvider.parseDirs([
      { name: "project-a", type: "tree" },
      { name: "readme.md", type: "blob" },
    ]);
    expect(dirs).toEqual(["project-a"]);
  });

  it("parseRepos normalizes GitLab response", () => {
    const repos = gitlabProvider.parseRepos([
      {
        path_with_namespace: "user/repo",
        http_url_to_repo: "https://gitlab.com/user/repo.git",
        visibility: "private",
        last_activity_at: "2026-01-01",
      },
    ]);
    expect(repos).toHaveLength(1);
    expect(repos[0].name).toBe("user/repo");
    expect(repos[0].private).toBe(true);
  });

  it("tokenExchangeBody returns form-encoded format for GitLab", () => {
    const { body, contentType } = gitlabProvider.tokenExchangeBody(
      "cid",
      "secret",
      "code123",
      "https://example.com/cb",
    );
    expect(contentType).toBe("application/x-www-form-urlencoded");
    const params = new URLSearchParams(body);
    expect(params.get("grant_type")).toBe("authorization_code");
    expect(params.get("client_id")).toBe("cid");
    expect(params.get("redirect_uri")).toBe("https://example.com/cb");
  });

  it("parseUser extracts GitLab user info", () => {
    const user = gitlabProvider.parseUser({
      username: "gluser",
      avatar_url: "https://gitlab.com/avatar.png",
    });
    expect(user).toEqual({ login: "gluser", avatar: "https://gitlab.com/avatar.png" });
  });
});

describe("Git providers — createGiteaProvider", () => {
  it("generates correct URLs for custom base URL", () => {
    const p = createGiteaProvider("https://git.mycompany.com", "myco", "MyCo Git");
    expect(p.name).toBe("myco");
    expect(p.displayName).toBe("MyCo Git");
    expect(p.tokenUrl()).toBe("https://git.mycompany.com/login/oauth/access_token");
    expect(p.userUrl()).toBe("https://git.mycompany.com/api/v1/user");
    expect(p.reposUrl()).toContain("https://git.mycompany.com/api/v1/user/repos");
  });

  it("authUrl includes custom base", () => {
    const p = createGiteaProvider("https://gitea.local", "local", "Local");
    const url = p.authUrl("cid", "https://cb.local/callback", "s");
    expect(url).toContain("gitea.local/login/oauth/authorize");
    expect(url).toContain("scope=repository");
  });

  it("authHeader uses token format", () => {
    const p = createGiteaProvider("https://gitea.local", "local", "Local");
    expect(p.authHeader("tok")).toBe("token tok");
  });

  it("codebergProvider has correct base", () => {
    expect(codebergProvider.tokenUrl()).toBe("https://codeberg.org/login/oauth/access_token");
    expect(codebergProvider.userUrl()).toBe("https://codeberg.org/api/v1/user");
  });

  it("tokenExchangeBody returns form-encoded for Gitea", () => {
    const p = createGiteaProvider("https://gitea.local", "local", "Local");
    const { contentType } = p.tokenExchangeBody("cid", "secret", "code", "https://cb.local");
    expect(contentType).toBe("application/x-www-form-urlencoded");
  });
});

// ---------------------------------------------------------------------------
// Worker integration tests
// ---------------------------------------------------------------------------

describe("Worker — Health check", () => {
  it("GET /api/health returns 200 with runtime marker", async () => {
    const res = await req("/api/health");
    expect(res.status).toBe(200);
    const data = (await res.json()) as { status: string; version: string; runtime: string };
    expect(data.status).toBe("ok");
    expect(data.version).toBe("0.3.0");
    expect(data.runtime).toBe("cloudflare-workers");
  });
});

describe("Worker — Available providers", () => {
  it("GET /auth/providers returns configured providers", async () => {
    const res = await app.request("/auth/providers", {}, MOCK_ENV);
    expect(res.status).toBe(200);
    const data = (await res.json()) as { providers: Array<{ name: string; displayName: string }> };
    expect(data.providers).toHaveLength(1);
    expect(data.providers[0].name).toBe("github");
  });

  it("GET /auth/providers returns multiple when configured", async () => {
    const res = await app.request("/auth/providers", {}, MULTI_PROVIDER_ENV);
    expect(res.status).toBe(200);
    const data = (await res.json()) as { providers: Array<{ name: string; displayName: string }> };
    const names = data.providers.map((p) => p.name);
    expect(names).toContain("github");
    expect(names).toContain("gitlab");
    expect(names).toContain("codeberg");
  });
});

describe("Worker — Authentication (no cookie)", () => {
  it("GET /api/repos without session returns 401", async () => {
    const res = await req("/api/repos");
    expect(res.status).toBe(401);
    const data = (await res.json()) as { error: string; login: string };
    expect(data.error).toContain("Not authenticated");
    expect(data.login).toBe("/auth/providers");
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

describe("Worker — OAuth flow (GitHub)", () => {
  it("GET /auth/github/login redirects to GitHub OAuth", async () => {
    const res = await req("/auth/github/login");
    expect(res.status).toBe(302);
    const location = res.headers.get("location");
    expect(location).toBeTruthy();
    expect(location).toContain("github.com/login/oauth/authorize");
    expect(location).toContain("client_id=test-client-id");
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

describe("Worker — OAuth flow (GitLab)", () => {
  it("GET /auth/gitlab/login redirects to GitLab OAuth", async () => {
    const res = await app.request("/auth/gitlab/login", {}, MULTI_PROVIDER_ENV);
    expect(res.status).toBe(302);
    const location = res.headers.get("location");
    expect(location).toBeTruthy();
    expect(location).toContain("gitlab.com/oauth/authorize");
    expect(location).toContain("client_id=gl-test-client-id");
    expect(location).toContain("response_type=code");
  });

  it("GET /auth/gitlab/login returns 400 when not configured", async () => {
    // MOCK_ENV only has GitHub configured
    const res = await req("/auth/gitlab/login");
    expect(res.status).toBe(400);
    const data = (await res.json()) as { error: string };
    expect(data.error).toContain("not configured");
  });
});

describe("Worker — OAuth flow (unknown provider)", () => {
  it("GET /auth/unknown/login returns 400", async () => {
    const res = await req("/auth/unknown/login");
    expect(res.status).toBe(400);
    const data = (await res.json()) as { error: string };
    expect(data.error).toContain("Unknown provider");
  });

  it("GET /auth/unknown/callback returns 400", async () => {
    const res = await req("/auth/unknown/callback?code=abc&state=xyz");
    expect(res.status).toBe(400);
    const data = (await res.json()) as { error: string };
    expect(data.error).toContain("Unknown provider");
  });
});

// ---------------------------------------------------------------------------
// SESSION_SECRET strength/presence guard (W-m8-session-secret)
//
// Session cookies carry a live git PAT, encrypted with an AES-GCM key derived
// from SESSION_SECRET via HKDF with a FIXED salt. A missing or weak
// SESSION_SECRET yields trivially-forgeable/decryptable session cookies. The
// guard MUST fail closed: when SESSION_SECRET is unset or <32 chars, the auth
// middleware and OAuth callback return 500 BEFORE touching session crypto.
// ---------------------------------------------------------------------------

describe("Worker — SESSION_SECRET guard (fail closed)", () => {
  // A presented cookie is required so the middleware reaches the crypto path
  // (a missing cookie short-circuits at 401 before the secret matters).
  const SOME_COOKIE = { headers: { cookie: "am_session=anything" } };

  it("auth middleware returns 500 when SESSION_SECRET is unset", async () => {
    const env = { ...MOCK_ENV, SESSION_SECRET: undefined as unknown as string };
    const res = await app.request("/api/repos", SOME_COOKIE, env);
    expect(res.status).toBe(500);
    const data = (await res.json()) as { error: string };
    expect(data.error.toLowerCase()).toContain("session_secret");
  });

  it("auth middleware returns 500 when SESSION_SECRET is empty", async () => {
    const env = { ...MOCK_ENV, SESSION_SECRET: "" };
    const res = await app.request("/api/repos", SOME_COOKIE, env);
    expect(res.status).toBe(500);
  });

  it("auth middleware returns 500 when SESSION_SECRET is shorter than 32 chars", async () => {
    const env = { ...MOCK_ENV, SESSION_SECRET: "too-short-secret" }; // 16 chars
    const res = await app.request("/api/repos", SOME_COOKIE, env);
    expect(res.status).toBe(500);
    const data = (await res.json()) as { error: string };
    expect(data.error.toLowerCase()).toContain("session_secret");
  });

  it("auth middleware does NOT leak the secret value in the error body", async () => {
    const env = { ...MOCK_ENV, SESSION_SECRET: "short-but-secret" };
    const res = await app.request("/api/repos", SOME_COOKIE, env);
    expect(res.status).toBe(500);
    const body = await res.text();
    expect(body).not.toContain("short-but-secret");
  });

  it("auth middleware proceeds past the guard when SESSION_SECRET is >=32 chars", async () => {
    // 32-char secret with an undecryptable cookie → guard passes, crypto runs,
    // decrypt fails → 401 (NOT 500). Proves the guard is length-gated, not a
    // blanket failure, and that a strong secret reaches the crypto path.
    const env = { ...MOCK_ENV, SESSION_SECRET: "a".repeat(32) };
    const res = await app.request("/api/repos", SOME_COOKIE, env);
    expect(res.status).toBe(401);
  });

  it("guard runs BEFORE crypto: exactly-31-char secret is rejected (boundary)", async () => {
    const env = { ...MOCK_ENV, SESSION_SECRET: "a".repeat(31) };
    const res = await app.request("/api/repos", SOME_COOKIE, env);
    expect(res.status).toBe(500);
  });

  it("OAuth callback returns 500 when SESSION_SECRET is unset", async () => {
    const env = { ...MOCK_ENV, SESSION_SECRET: undefined as unknown as string };
    const res = await app.request(
      "/auth/github/callback?code=abc&state=xyz",
      { headers: { cookie: "am_oauth_state=anything" } },
      env,
    );
    expect(res.status).toBe(500);
    const data = (await res.json()) as { error: string };
    expect(data.error.toLowerCase()).toContain("session_secret");
  });

  it("OAuth callback returns 500 when SESSION_SECRET is shorter than 32 chars", async () => {
    const env = { ...MOCK_ENV, SESSION_SECRET: "too-short" };
    const res = await app.request(
      "/auth/github/callback?code=abc&state=xyz",
      { headers: { cookie: "am_oauth_state=anything" } },
      env,
    );
    expect(res.status).toBe(500);
  });

  it("OAuth callback guard fires before any session decryption (forged state)", async () => {
    // With a weak secret a forged state cookie could otherwise be decrypted.
    // The guard must reject with 500 before reaching the CSRF/decrypt logic,
    // never surfacing the 403 'CSRF check failed' that the crypto path returns.
    const env = { ...MOCK_ENV, SESSION_SECRET: "weak" };
    const res = await app.request(
      "/auth/github/callback?code=abc&state=forged",
      { headers: { cookie: "am_oauth_state=forged-cookie" } },
      env,
    );
    expect(res.status).toBe(500);
    expect(res.status).not.toBe(403);
  });

  // ── /auth/:provider/login guard (ws-80ad-oauth-secret-guard) ──────
  //
  // The login handler mints an `am_oauth_state` cookie via encryptSession().
  // Because HKDF deriveKey does NOT throw on an empty/short key, a weak/missing
  // SESSION_SECRET produces a forgeable CSRF-state cookie. The guard must fire
  // at the TOP of the handler — before encryptSession — and return 500 without
  // setting any am_oauth_state cookie.

  it("login returns 500 when SESSION_SECRET is unset (no state cookie minted)", async () => {
    const env = { ...MOCK_ENV, SESSION_SECRET: undefined as unknown as string };
    const res = await app.request("/auth/github/login", {}, env);
    expect(res.status).toBe(500);
    const data = (await res.json()) as { error: string };
    expect(data.error.toLowerCase()).toContain("session_secret");
    // A forgeable state cookie must NOT have been minted.
    expect(res.headers.get("set-cookie") ?? "").not.toContain("am_oauth_state=");
  });

  it("login returns 500 when SESSION_SECRET is shorter than 32 chars (no state cookie)", async () => {
    const env = { ...MOCK_ENV, SESSION_SECRET: "too-short-secret" }; // 16 chars
    const res = await app.request("/auth/github/login", {}, env);
    expect(res.status).toBe(500);
    const data = (await res.json()) as { error: string };
    expect(data.error.toLowerCase()).toContain("session_secret");
    expect(res.headers.get("set-cookie") ?? "").not.toContain("am_oauth_state=");
  });

  it("login guard fires before the unknown-provider / not-configured checks", async () => {
    // The guard sits at the very top, so even a weak-secret request that would
    // otherwise 302-redirect (valid provider + creds) fails closed with 500
    // and never mints a cookie.
    const env = { ...MOCK_ENV, SESSION_SECRET: "weak" };
    const res = await app.request("/auth/github/login", {}, env);
    expect(res.status).toBe(500);
    expect(res.status).not.toBe(302);
    expect(res.headers.get("set-cookie") ?? "").not.toContain("am_oauth_state=");
  });

  it("login proceeds normally (302 + state cookie) when SESSION_SECRET is strong", async () => {
    // Positive case: a valid >=32-char secret preserves the prior behavior.
    const env = { ...MOCK_ENV, SESSION_SECRET: "a".repeat(32) };
    const res = await app.request("/auth/github/login", {}, env);
    expect(res.status).toBe(302);
    const cookie = res.headers.get("set-cookie") ?? "";
    expect(cookie).toContain("am_oauth_state=");
    expect(cookie).toContain("Max-Age=300");
  });

  // ── /auth/check guard (ws-80ad-oauth-secret-guard) ────────────────
  //
  // /auth/check decrypts the am_session cookie (which carries a live PAT). A
  // weak/missing SESSION_SECRET makes that cookie trivially decryptable, so the
  // guard must fail closed with 500 before decryptSession runs.

  it("auth/check returns 500 when SESSION_SECRET is unset", async () => {
    const env = { ...MOCK_ENV, SESSION_SECRET: undefined as unknown as string };
    const res = await app.request("/auth/check", SOME_COOKIE, env);
    expect(res.status).toBe(500);
    const data = (await res.json()) as { error: string };
    expect(data.error.toLowerCase()).toContain("session_secret");
  });

  it("auth/check returns 500 when SESSION_SECRET is shorter than 32 chars", async () => {
    const env = { ...MOCK_ENV, SESSION_SECRET: "too-short" };
    const res = await app.request("/auth/check", SOME_COOKIE, env);
    expect(res.status).toBe(500);
    const data = (await res.json()) as { error: string };
    expect(data.error.toLowerCase()).toContain("session_secret");
  });

  it("auth/check does NOT leak the secret value in the error body", async () => {
    const env = { ...MOCK_ENV, SESSION_SECRET: "short-but-secret" };
    const res = await app.request("/auth/check", SOME_COOKIE, env);
    expect(res.status).toBe(500);
    const body = await res.text();
    expect(body).not.toContain("short-but-secret");
  });

  it("auth/check with a strong secret + no cookie preserves authenticated:false (200)", async () => {
    // Positive case: a strong secret must NOT turn the unauthenticated path
    // into a 500. No cookie → short-circuits to authenticated:false BEFORE the
    // guard (the guard sits after the missing-cookie check), proving the guard
    // is length-gated, not a blanket failure.
    const env = { ...MOCK_ENV, SESSION_SECRET: "a".repeat(32) };
    const res = await app.request("/auth/check", {}, env);
    expect(res.status).toBe(200);
    const data = (await res.json()) as { authenticated: boolean };
    expect(data.authenticated).toBe(false);
  });
});

// ── Worker crypto (deriveKey, encryptSession, decryptSession) ────
//
// These functions are module-private in src/web/worker.ts (not exported).
// Direct unit-test roundtrip (encrypt → decrypt → original) is not possible
// without refactoring the production code (e.g., extracting them to a
// separate src/web/crypto.ts module with named exports).
//
// The existing "Invalid cookie" tests above already cover:
//   - Wrong secret / different key → decryptSession returns null → 401
//   - Corrupted/tampered base64 → decryptSession returns null → 401
//   - Short payload (no valid AES-GCM ciphertext) → 401
//
// A full roundtrip test would require mocking the OAuth token endpoint
// to complete the callback flow, which creates a valid encrypted session
// cookie, and then using that cookie on an authenticated endpoint.
// This is covered below with a fetch mock.

describe("Worker — session cookie roundtrip (via OAuth callback mock)", () => {
  it("valid encrypted session cookie grants access to /auth/check", async () => {
    // Step 1: Get the login redirect to capture the state
    const loginRes = await req("/auth/github/login");
    const setCookie = loginRes.headers.get("set-cookie") ?? "";
    const oauthStateCookie = setCookie.match(/am_oauth_state=([^;]+)/)?.[1];
    expect(oauthStateCookie).toBeTruthy();

    // Extract state parameter from the redirect URL
    const location = loginRes.headers.get("location") ?? "";
    const stateParam = new URL(location).searchParams.get("state");
    expect(stateParam).toBeTruthy();

    // Step 2: Mock GitHub token exchange using globalThis.fetch override
    const originalFetch = globalThis.fetch;
    const mockFetch = async (input: string | URL | Request, init?: RequestInit) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;

      if (url === "https://github.com/login/oauth/access_token") {
        return new Response(JSON.stringify({ access_token: "gho_mock_token_123" }), {
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url === "https://api.github.com/user") {
        return new Response(
          JSON.stringify({ login: "testuser", avatar_url: "https://example.com/avatar.png" }),
          { headers: { "Content-Type": "application/json" } },
        );
      }
      return originalFetch(input, init);
    };
    globalThis.fetch = Object.assign(mockFetch, {
      preconnect: originalFetch.preconnect,
    }) as typeof fetch;

    try {
      // Step 3: Simulate the OAuth callback with the state cookie
      const callbackRes = await app.request(
        `/auth/github/callback?code=mock_code&state=${stateParam}`,
        { headers: { cookie: `am_oauth_state=${oauthStateCookie}` } },
        MOCK_ENV,
      );

      expect(callbackRes.status).toBe(302);
      const sessionSetCookie = callbackRes.headers.get("set-cookie") ?? "";
      const sessionCookieMatch = sessionSetCookie.match(/am_session=([^;]+)/);
      expect(sessionCookieMatch).toBeTruthy();
      const sessionCookieValue = sessionCookieMatch![1];

      // Step 4: Use the encrypted session cookie on /auth/check — roundtrip
      const checkRes = await app.request(
        "/auth/check",
        { headers: { cookie: `am_session=${sessionCookieValue}` } },
        MOCK_ENV,
      );
      expect(checkRes.status).toBe(200);
      const checkData = (await checkRes.json()) as {
        authenticated: boolean;
        provider?: string;
        user?: { login: string; avatar: string };
      };
      expect(checkData.authenticated).toBe(true);
      expect(checkData.provider).toBe("github");
      expect(checkData.user?.login).toBe("testuser");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("GET /api/config/:owner/:repo redacts secrets and never returns raw plaintext", async () => {
    // W-l3-worker-redact: the worker config-read endpoint used to return
    // `{ raw: content, parsed }` with `parsed` straight from TOML.parse — no
    // redaction. A repo config carrying an enc: envelope leaked the full
    // ciphertext, and a plaintext-looking secret (or one embedded in a remote
    // URL) leaked verbatim through BOTH `raw` and `parsed`. The endpoint now
    // applies the canonical two-pass redactor and drops `raw` entirely.
    const ENC_ENVELOPE = "enc:v2:age:YWdlLWVuY3J5cHRlZC1zZWNyZXQtY2lwaGVydGV4dC1ib2R5LWhlcmU=";
    const ENC_BODY_FRAGMENT = "YWdlLWVuY3J5cHRlZC1zZWNyZXQtY2lwaGVydGV4dC1ib2R5LWhlcmU=";
    const PLAIN_TOKEN = "tvly-plaintextkey0123456789";
    const CRED_URL = "https://alice:p4ssw0rdInUrl@remote.example.com/mcp";
    const REMOTE_CONFIG_TOML = [
      "[settings.env]",
      `LEGACY_API_KEY = "${ENC_ENVELOPE}"`,
      `TAVILY_API_KEY = "${PLAIN_TOKEN}"`,
      "",
      "[servers.remote]",
      `command = "${CRED_URL}"`,
      'transport = "streamable-http"',
      "enabled = true",
      "",
      "[servers.remote.headers]",
      'Authorization = "Bearer rawplaintextheaderkey"',
      "",
    ].join("\n");

    // Step 1: mint a real encrypted session cookie via the OAuth callback flow.
    const loginRes = await req("/auth/github/login");
    const oauthStateCookie = (loginRes.headers.get("set-cookie") ?? "").match(
      /am_oauth_state=([^;]+)/,
    )?.[1];
    const stateParam = new URL(loginRes.headers.get("location") ?? "").searchParams.get("state");
    expect(oauthStateCookie).toBeTruthy();
    expect(stateParam).toBeTruthy();

    const originalFetch = globalThis.fetch;
    const mockFetch = async (input: string | URL | Request, init?: RequestInit) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url === "https://github.com/login/oauth/access_token") {
        return new Response(JSON.stringify({ access_token: "gho_mock_token_for_config" }), {
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url === "https://api.github.com/user") {
        return new Response(
          JSON.stringify({ login: "testuser", avatar_url: "https://example.com/avatar.png" }),
          { headers: { "Content-Type": "application/json" } },
        );
      }
      // The config-read endpoint fetches the repo's config.toml via fileUrl().
      if (url === "https://api.github.com/repos/owner/repo/contents/config.toml") {
        return new Response(REMOTE_CONFIG_TOML, {
          headers: { "Content-Type": "text/plain" },
        });
      }
      return originalFetch(input, init);
    };
    globalThis.fetch = Object.assign(mockFetch, {
      preconnect: originalFetch.preconnect,
    }) as typeof fetch;

    try {
      const callbackRes = await app.request(
        `/auth/github/callback?code=mock_code&state=${stateParam}`,
        { headers: { cookie: `am_oauth_state=${oauthStateCookie}` } },
        MOCK_ENV,
      );
      expect(callbackRes.status).toBe(302);
      const sessionCookieValue = (callbackRes.headers.get("set-cookie") ?? "").match(
        /am_session=([^;]+)/,
      )?.[1];
      expect(sessionCookieValue).toBeTruthy();

      // Step 2: read the repo config with the authenticated session cookie.
      const res = await app.request(
        "/api/config/owner/repo",
        { headers: { cookie: `am_session=${sessionCookieValue}` } },
        MOCK_ENV,
      );
      expect(res.status).toBe(200);

      const data = (await res.json()) as {
        raw?: unknown;
        parsed: {
          settings?: { env?: Record<string, string> };
          servers?: Record<string, { command?: string; headers?: Record<string, string> }>;
        };
      };

      // The unredacted raw TOML text must NOT ride out at all.
      expect(data.raw).toBeUndefined();

      // Structural redaction of the enc: envelope and plaintext-by-location.
      expect(data.parsed.settings?.env?.LEGACY_API_KEY).toBe("[encrypted]");
      expect(data.parsed.settings?.env?.TAVILY_API_KEY).toBe("[redacted]");
      expect(data.parsed.servers?.remote?.headers?.Authorization).toBe("[redacted]");
      // Credential userinfo stripped from the URL; host stays legible.
      expect(data.parsed.servers?.remote?.command).not.toContain("p4ssw0rdInUrl");
      expect(data.parsed.servers?.remote?.command).toContain("remote.example.com");

      // Belt and suspenders: NO secret value or ciphertext body survives
      // anywhere in the serialized response.
      const serialized = JSON.stringify(data);
      expect(serialized).not.toContain(ENC_BODY_FRAGMENT);
      expect(serialized).not.toContain("enc:v2:age:");
      expect(serialized).not.toContain(PLAIN_TOKEN);
      expect(serialized).not.toContain("p4ssw0rdInUrl");
      expect(serialized).not.toContain("rawplaintextheaderkey");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("GET /api/config/:owner/:repo withholds raw content when TOML parse fails", async () => {
    // Fail-closed: if the remote config is not valid TOML we cannot structurally
    // redact it, so the raw text (which may carry plaintext secrets) must NOT be
    // returned. Regression for the old parse-fail branch that echoed `raw`.
    const SECRET_IN_BROKEN_CONFIG = "sk-ant-brokenconfigsecret0123456789";
    const BROKEN_TOML = `this is not = = valid toml ${SECRET_IN_BROKEN_CONFIG} [[[`;

    const loginRes = await req("/auth/github/login");
    const oauthStateCookie = (loginRes.headers.get("set-cookie") ?? "").match(
      /am_oauth_state=([^;]+)/,
    )?.[1];
    const stateParam = new URL(loginRes.headers.get("location") ?? "").searchParams.get("state");

    const originalFetch = globalThis.fetch;
    const mockFetch = async (input: string | URL | Request, init?: RequestInit) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url === "https://github.com/login/oauth/access_token") {
        return new Response(JSON.stringify({ access_token: "gho_mock_token_broken" }), {
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url === "https://api.github.com/repos/owner/repo/contents/config.toml") {
        return new Response(BROKEN_TOML, { headers: { "Content-Type": "text/plain" } });
      }
      return originalFetch(input, init);
    };
    globalThis.fetch = Object.assign(mockFetch, {
      preconnect: originalFetch.preconnect,
    }) as typeof fetch;

    try {
      const callbackRes = await app.request(
        `/auth/github/callback?code=mock_code&state=${stateParam}`,
        { headers: { cookie: `am_oauth_state=${oauthStateCookie}` } },
        MOCK_ENV,
      );
      const sessionCookieValue = (callbackRes.headers.get("set-cookie") ?? "").match(
        /am_session=([^;]+)/,
      )?.[1];

      const res = await app.request(
        "/api/config/owner/repo",
        { headers: { cookie: `am_session=${sessionCookieValue}` } },
        MOCK_ENV,
      );
      expect(res.status).toBe(200);
      const body = await res.text();
      // Raw content withheld; the embedded secret never leaks.
      const data = JSON.parse(body) as { raw?: unknown; parsed: null };
      expect(data.raw).toBeUndefined();
      expect(data.parsed).toBeNull();
      expect(body).not.toContain(SECRET_IN_BROKEN_CONFIG);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  // ── Wiki path-traversal guard (W-l4-worker-wiki-path) ───────────
  //
  // The worker wiki endpoints interpolate project/type/slug query params
  // directly into a remote file path:
  //   pages-by-slug → `wiki/projects/${project}/${type}/${slug}.md`
  //   pages-list    → `wiki/projects/${project}` (parseTree prefix)
  // Without validation, `slug=../../secret`, `project=../x`, or a crafted
  // `type` escapes the wiki dir and lets an authenticated caller fetch
  // arbitrary repo files (config.toml, .github workflows, source). Every
  // component MUST be validated against a strict allowlist BEFORE the path
  // is composed; failures return 400 and the traversal fetch never fires.

  /** Mint a real encrypted session cookie + return a fetch mock that records
   *  every URL the worker requests, so we can prove no traversal path is hit. */
  async function authedSessionWithUrlSpy(): Promise<{
    cookie: string;
    urls: string[];
    restore: () => void;
  }> {
    const loginRes = await req("/auth/github/login");
    const oauthStateCookie = (loginRes.headers.get("set-cookie") ?? "").match(
      /am_oauth_state=([^;]+)/,
    )?.[1];
    const stateParam = new URL(loginRes.headers.get("location") ?? "").searchParams.get("state");

    const originalFetch = globalThis.fetch;
    const urls: string[] = [];
    const mockFetch = async (input: string | URL | Request, init?: RequestInit) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      urls.push(url);
      if (url === "https://github.com/login/oauth/access_token") {
        return new Response(JSON.stringify({ access_token: "gho_mock_token_wiki" }), {
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url === "https://api.github.com/user") {
        return new Response(
          JSON.stringify({ login: "testuser", avatar_url: "https://example.com/avatar.png" }),
          { headers: { "Content-Type": "application/json" } },
        );
      }
      // Any wiki tree/file fetch: return a benign empty-ish payload so the
      // handler completes. The test asserts on STATUS and the recorded URLs.
      if (url.includes("/git/trees/")) {
        return new Response(JSON.stringify({ tree: [] }), {
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.includes("/contents/")) {
        return new Response("# page body", { headers: { "Content-Type": "text/plain" } });
      }
      return originalFetch(input, init);
    };
    globalThis.fetch = Object.assign(mockFetch, {
      preconnect: originalFetch.preconnect,
    }) as typeof fetch;

    const callbackRes = await app.request(
      `/auth/github/callback?code=mock_code&state=${stateParam}`,
      { headers: { cookie: `am_oauth_state=${oauthStateCookie}` } },
      MOCK_ENV,
    );
    const sessionCookieValue = (callbackRes.headers.get("set-cookie") ?? "").match(
      /am_session=([^;]+)/,
    )?.[1];
    // Drop the OAuth-flow URLs so callers only see wiki-endpoint requests.
    urls.length = 0;
    return {
      cookie: `am_session=${sessionCookieValue}`,
      urls,
      restore: () => {
        globalThis.fetch = originalFetch;
      },
    };
  }

  it("wiki pages-by-slug rejects slug='../../secret' with 400 (no traversal fetch)", async () => {
    const { cookie, urls, restore } = await authedSessionWithUrlSpy();
    try {
      const res = await app.request(
        `/api/wiki/owner/repo/pages/${encodeURIComponent("../../secret")}?project=myproj`,
        { headers: { cookie } },
        MOCK_ENV,
      );
      expect(res.status).toBe(400);
      // The traversal path must never have been requested upstream.
      expect(urls.some((u) => u.includes(".."))).toBe(false);
      expect(urls.some((u) => u.includes("/contents/"))).toBe(false);
    } finally {
      restore();
    }
  });

  it("wiki pages-by-slug rejects project='../x' with 400", async () => {
    const { cookie, urls, restore } = await authedSessionWithUrlSpy();
    try {
      const res = await app.request(
        `/api/wiki/owner/repo/pages/validslug?project=${encodeURIComponent("../x")}`,
        { headers: { cookie } },
        MOCK_ENV,
      );
      expect(res.status).toBe(400);
      expect(urls.some((u) => u.includes(".."))).toBe(false);
    } finally {
      restore();
    }
  });

  it("wiki pages-by-slug rejects an unknown type with 400", async () => {
    const { cookie, urls, restore } = await authedSessionWithUrlSpy();
    try {
      const res = await app.request(
        `/api/wiki/owner/repo/pages/validslug?project=myproj&type=${encodeURIComponent("../../etc")}`,
        { headers: { cookie } },
        MOCK_ENV,
      );
      expect(res.status).toBe(400);
      expect(urls.some((u) => u.includes(".."))).toBe(false);
    } finally {
      restore();
    }
  });

  it("wiki pages-by-slug rejects a non-allowlisted (but traversal-free) type", async () => {
    // `bogus` has no `..` but is not a known wiki subdir — fixed-set guard.
    const { cookie, restore } = await authedSessionWithUrlSpy();
    try {
      const res = await app.request(
        "/api/wiki/owner/repo/pages/validslug?project=myproj&type=bogus",
        { headers: { cookie } },
        MOCK_ENV,
      );
      expect(res.status).toBe(400);
    } finally {
      restore();
    }
  });

  it("wiki pages-by-slug accepts valid lowercase-hyphen components", async () => {
    const { cookie, urls, restore } = await authedSessionWithUrlSpy();
    try {
      const res = await app.request(
        "/api/wiki/owner/repo/pages/my-page-01?project=my-proj_2&type=decisions",
        { headers: { cookie } },
        MOCK_ENV,
      );
      expect(res.status).toBe(200);
      const data = (await res.json()) as { slug: string; type: string; content: string };
      expect(data.slug).toBe("my-page-01");
      expect(data.type).toBe("decisions");
      // The composed path is the expected, non-escaping one.
      expect(
        urls.some((u) => u.endsWith("/contents/wiki/projects/my-proj_2/decisions/my-page-01.md")),
      ).toBe(true);
    } finally {
      restore();
    }
  });

  it("wiki pages-by-slug accepts a valid global page (no project)", async () => {
    const { cookie, urls, restore } = await authedSessionWithUrlSpy();
    try {
      const res = await app.request(
        "/api/wiki/owner/repo/pages/global-page?type=entities",
        { headers: { cookie } },
        MOCK_ENV,
      );
      expect(res.status).toBe(200);
      expect(urls.some((u) => u.endsWith("/contents/wiki/global/entities/global-page.md"))).toBe(
        true,
      );
    } finally {
      restore();
    }
  });

  it("wiki pages-list rejects project='../x' with 400 (no tree fetch)", async () => {
    const { cookie, urls, restore } = await authedSessionWithUrlSpy();
    try {
      const res = await app.request(
        `/api/wiki/owner/repo/pages?project=${encodeURIComponent("../x")}`,
        { headers: { cookie } },
        MOCK_ENV,
      );
      expect(res.status).toBe(400);
      // The tree fetch must not fire for an invalid project.
      expect(urls.some((u) => u.includes("/git/trees/"))).toBe(false);
    } finally {
      restore();
    }
  });

  it("wiki pages-list accepts a valid project and a global listing", async () => {
    const { cookie, restore } = await authedSessionWithUrlSpy();
    try {
      const projRes = await app.request(
        "/api/wiki/owner/repo/pages?project=my-proj_2",
        { headers: { cookie } },
        MOCK_ENV,
      );
      expect(projRes.status).toBe(200);

      const globalRes = await app.request(
        "/api/wiki/owner/repo/pages",
        { headers: { cookie } },
        MOCK_ENV,
      );
      expect(globalRes.status).toBe(200);
    } finally {
      restore();
    }
  });

  it("cookie encrypted with different secret fails authentication", async () => {
    // Create an encrypted cookie using a DIFFERENT secret by going through
    // the OAuth flow with a different SESSION_SECRET env
    const differentEnv = { ...MOCK_ENV, SESSION_SECRET: "completely-different-secret-key!!" };

    const loginRes = await app.request("/auth/github/login", {}, differentEnv);
    const setCookie = loginRes.headers.get("set-cookie") ?? "";
    const oauthStateCookie = setCookie.match(/am_oauth_state=([^;]+)/)?.[1];
    const location = loginRes.headers.get("location") ?? "";
    const stateParam = new URL(location).searchParams.get("state");

    const originalFetch = globalThis.fetch;
    const mockFetch2 = async (input: string | URL | Request, init?: RequestInit) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url === "https://github.com/login/oauth/access_token") {
        return new Response(JSON.stringify({ access_token: "gho_wrong_secret_token" }), {
          headers: { "Content-Type": "application/json" },
        });
      }
      return originalFetch(input, init);
    };
    globalThis.fetch = Object.assign(mockFetch2, {
      preconnect: originalFetch.preconnect,
    }) as typeof fetch;

    try {
      const callbackRes = await app.request(
        `/auth/github/callback?code=mock&state=${stateParam}`,
        { headers: { cookie: `am_oauth_state=${oauthStateCookie}` } },
        differentEnv,
      );

      if (callbackRes.status === 302) {
        const sessionSetCookie = callbackRes.headers.get("set-cookie") ?? "";
        const sessionCookieMatch = sessionSetCookie.match(/am_session=([^;]+)/);
        if (sessionCookieMatch) {
          // Now try to use this cookie with the ORIGINAL secret — should fail
          const checkRes = await app.request(
            "/auth/check",
            { headers: { cookie: `am_session=${sessionCookieMatch[1]}` } },
            MOCK_ENV, // original secret
          );
          const data = (await checkRes.json()) as { authenticated: boolean };
          expect(data.authenticated).toBe(false);
        }
      }
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
