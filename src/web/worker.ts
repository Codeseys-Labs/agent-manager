/**
 * Cloudflare Workers entry point for agent-manager web UI.
 *
 * FULLY STATELESS — no KV, D1, or R2. Zero persistent storage.
 * Sessions use encrypted cookies. Config lives in user's git repo.
 *
 * Supports multiple git backends: GitHub, GitLab, Codeberg, self-hosted Gitea.
 * See ADR-0015 for architecture, ADR-0025 for multi-backend design.
 */
import { Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { redactConfigPlaintextSecrets, redactConfigSecrets } from "../lib/redact";
import { type GitProvider, getProvider, registerGiteaInstance } from "./git-providers";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Bindings = {
  // GitHub
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
  // GitLab
  GITLAB_CLIENT_ID?: string;
  GITLAB_CLIENT_SECRET?: string;
  // Codeberg
  CODEBERG_CLIENT_ID?: string;
  CODEBERG_CLIENT_SECRET?: string;
  // Self-hosted Gitea
  GITEA_URL?: string;
  GITEA_CLIENT_ID?: string;
  GITEA_CLIENT_SECRET?: string;
  // Common
  SESSION_SECRET: string;
  ENVIRONMENT: string;
  ASSETS?: { fetch: (req: Request) => Promise<Response> };
};

type Variables = {
  token: string;
  provider: GitProvider;
};

// ---------------------------------------------------------------------------
// Provider credential helpers
// ---------------------------------------------------------------------------

/** Map provider name → env var names for client ID/secret */
function getProviderCredentials(
  providerName: string,
  env: Bindings,
): { clientId: string; clientSecret: string } | null {
  switch (providerName) {
    case "github":
      return env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET
        ? { clientId: env.GITHUB_CLIENT_ID, clientSecret: env.GITHUB_CLIENT_SECRET }
        : null;
    case "gitlab":
      return env.GITLAB_CLIENT_ID && env.GITLAB_CLIENT_SECRET
        ? { clientId: env.GITLAB_CLIENT_ID, clientSecret: env.GITLAB_CLIENT_SECRET }
        : null;
    case "codeberg":
      return env.CODEBERG_CLIENT_ID && env.CODEBERG_CLIENT_SECRET
        ? { clientId: env.CODEBERG_CLIENT_ID, clientSecret: env.CODEBERG_CLIENT_SECRET }
        : null;
    case "gitea":
      return env.GITEA_CLIENT_ID && env.GITEA_CLIENT_SECRET
        ? { clientId: env.GITEA_CLIENT_ID, clientSecret: env.GITEA_CLIENT_SECRET }
        : null;
    default:
      return null;
  }
}

/** Return list of provider names that have credentials configured */
function getConfiguredProviders(env: Bindings): string[] {
  const configured: string[] = [];
  if (env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET) configured.push("github");
  if (env.GITLAB_CLIENT_ID && env.GITLAB_CLIENT_SECRET) configured.push("gitlab");
  if (env.CODEBERG_CLIENT_ID && env.CODEBERG_CLIENT_SECRET) configured.push("codeberg");
  if (env.GITEA_CLIENT_ID && env.GITEA_CLIENT_SECRET && env.GITEA_URL) configured.push("gitea");
  return configured;
}

// ---------------------------------------------------------------------------
// Session secret guard (fail closed)
// ---------------------------------------------------------------------------

/** Minimum SESSION_SECRET length. The HKDF salt is fixed, so the secret is the
 *  sole source of session-key entropy — a short secret is brute-forceable and
 *  yields trivially-decryptable cookies that carry a live git PAT. */
const MIN_SESSION_SECRET_LENGTH = 32;

/**
 * Validate that SESSION_SECRET is present and strong enough BEFORE any session
 * crypto runs. Returns an error string when the secret is unset or shorter than
 * {@link MIN_SESSION_SECRET_LENGTH}; returns null when the secret is acceptable.
 *
 * Callers MUST fail closed (HTTP 500) on a non-null result and MUST NOT proceed
 * to encrypt/decrypt. The returned message never includes the secret value.
 */
function assertSessionSecret(env: Bindings): string | null {
  const secret = env.SESSION_SECRET;
  if (typeof secret !== "string" || secret.length < MIN_SESSION_SECRET_LENGTH) {
    return `Server misconfigured: SESSION_SECRET must be set and at least ${MIN_SESSION_SECRET_LENGTH} characters`;
  }
  return null;
}

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
// Wiki path-component guards (path-traversal defense, W-l4-worker-wiki-path)
// ---------------------------------------------------------------------------

/**
 * Strict allowlist for a single wiki path component (project / slug). Mirrors
 * the local MCP server's slug guard pattern (src/web/server.ts) but omits `.`
 * entirely so a `..` segment can never be assembled. A component must start
 * with [a-z0-9] and contain only lowercase alphanumerics, `_`, and `-`.
 *
 * These components are interpolated into a REMOTE git file path
 * (`wiki/projects/${project}/${type}/${slug}.md`). Without this guard a value
 * like `../../config` traverses out of the wiki dir and an authenticated
 * caller can read arbitrary repo files. Validate BEFORE composing any path.
 */
const WIKI_COMPONENT_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/** The fixed set of wiki page-type subdirectory names (src/wiki/storage.ts
 *  PAGE_SUBDIRS). `type` is constrained to this allowlist rather than a regex
 *  so an unexpected-but-traversal-free value can't address an arbitrary dir. */
const WIKI_TYPES = new Set(["entities", "concepts", "summaries", "synthesis", "decisions"]);

function isValidWikiComponent(value: string): boolean {
  return WIKI_COMPONENT_RE.test(value);
}

function isValidWikiType(value: string): boolean {
  return WIKI_TYPES.has(value);
}

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------

const app = new Hono<{ Bindings: Bindings; Variables: Variables }>();

// ---------------------------------------------------------------------------
// Self-hosted Gitea registration (lazily on first request)
// ---------------------------------------------------------------------------

app.use("*", async (c, next) => {
  if (c.env.GITEA_URL && c.env.GITEA_CLIENT_ID && c.env.GITEA_CLIENT_SECRET) {
    // Ensure the self-hosted Gitea instance is registered
    if (!getProvider("gitea")) {
      registerGiteaInstance(c.env.GITEA_URL, "gitea");
    }
  }
  return next();
});

// ---------------------------------------------------------------------------
// Health check (unauthenticated)
// ---------------------------------------------------------------------------

app.get("/api/health", (c) =>
  c.json({ status: "ok", version: "0.3.0", runtime: "cloudflare-workers" }),
);

// ---------------------------------------------------------------------------
// Available providers endpoint (unauthenticated)
// ---------------------------------------------------------------------------

app.get("/auth/providers", (c) => {
  const configured = getConfiguredProviders(c.env);
  const providers = configured
    .map((name) => {
      const p = getProvider(name);
      return p ? { name: p.name, displayName: p.displayName } : null;
    })
    .filter(Boolean);
  return c.json({ providers });
});

// ---------------------------------------------------------------------------
// Multi-provider OAuth flow (stateless — CSRF state in short-lived encrypted cookie)
// ---------------------------------------------------------------------------

app.get("/auth/:provider/login", async (c) => {
  // Fail closed before any session crypto: HKDF deriveKey does NOT throw on a
  // missing/short key, so a weak SESSION_SECRET would let encryptSession mint a
  // forgeable am_oauth_state (CSRF) cookie below. Reject before that point.
  const secretError = assertSessionSecret(c.env);
  if (secretError) {
    return c.json({ error: secretError }, 500);
  }

  const providerName = c.req.param("provider");
  const provider = getProvider(providerName);
  if (!provider) {
    return c.json({ error: `Unknown provider: ${providerName}` }, 400);
  }

  const creds = getProviderCredentials(providerName, c.env);
  if (!creds) {
    return c.json({ error: `Provider ${providerName} is not configured` }, 400);
  }

  const redirectUri = new URL(`/auth/${providerName}/callback`, c.req.url).toString();
  const state = crypto.randomUUID();

  // Store CSRF state + provider in a short-lived encrypted cookie (5 min)
  const stateCookie = await encryptSession(
    { state, provider: providerName, ts: Date.now() },
    c.env.SESSION_SECRET,
  );

  const authorizationUrl = provider.authUrl(creds.clientId, redirectUri, state);

  return new Response(null, {
    status: 302,
    headers: {
      Location: authorizationUrl,
      "Set-Cookie": `am_oauth_state=${stateCookie}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=300`,
    },
  });
});

app.get("/auth/:provider/callback", async (c) => {
  // Fail closed before any session crypto: a missing/weak SESSION_SECRET makes
  // the encrypted session cookie (which carries a live git PAT) forgeable.
  const secretError = assertSessionSecret(c.env);
  if (secretError) {
    return c.json({ error: secretError }, 500);
  }

  const providerName = c.req.param("provider");
  const provider = getProvider(providerName);
  if (!provider) {
    return c.json({ error: `Unknown provider: ${providerName}` }, 400);
  }

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

  // Verify the state cookie matches this provider
  if (stateData.provider !== providerName) {
    return c.json({ error: "Provider mismatch in state cookie" }, 403);
  }

  // Check state isn't too old (5 min)
  if (Date.now() - (stateData.ts as number) > 300000) {
    return c.json({ error: "State expired" }, 403);
  }

  const creds = getProviderCredentials(providerName, c.env);
  if (!creds) {
    return c.json({ error: `Provider ${providerName} is not configured` }, 400);
  }

  // Exchange code for access token (provider-specific)
  const redirectUri = new URL(`/auth/${providerName}/callback`, c.req.url).toString();
  const exchange = provider.tokenExchangeBody(
    creds.clientId,
    creds.clientSecret,
    code,
    redirectUri,
  );

  const tokenRes = await fetch(provider.tokenUrl(), {
    method: "POST",
    headers: {
      "Content-Type": exchange.contentType,
      Accept: "application/json",
    },
    body: exchange.body,
  });

  const tokenData = await tokenRes.json();
  const accessToken = provider.parseTokenResponse(tokenData);

  if (!accessToken) {
    const errorMsg =
      (tokenData as { error?: string; error_description?: string }).error_description ??
      (tokenData as { error?: string }).error ??
      "Token exchange failed";
    return c.json({ error: errorMsg }, 400);
  }

  // Create encrypted session cookie with provider info (no server-side storage)
  const sessionCookieValue = await encryptSession(
    { token: accessToken, provider: providerName, created: Date.now() },
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

  // Fail closed before decrypting: the am_session cookie carries a live git
  // PAT, and a missing/weak SESSION_SECRET makes it trivially decryptable.
  // Mirrors the /api/* middleware guard (cookie-presence check first).
  const secretError = assertSessionSecret(c.env);
  if (secretError) {
    return c.json({ error: secretError }, 500);
  }

  const session = await decryptSession(encrypted, c.env.SESSION_SECRET);
  if (!session?.token) return c.json({ authenticated: false });

  const providerName = (session.provider as string) ?? "github";
  const provider = getProvider(providerName);
  if (!provider) return c.json({ authenticated: false });

  try {
    const userRes = await fetch(provider.userUrl(), {
      headers: {
        Authorization: provider.authHeader(session.token as string),
        "User-Agent": "agent-manager",
      },
    });
    if (!userRes.ok) return c.json({ authenticated: false });
    const userData = await userRes.json();
    const user = provider.parseUser(userData);
    return c.json({
      authenticated: true,
      provider: providerName,
      user,
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
    return c.json({ error: "Not authenticated", login: "/auth/providers" }, 401);
  }

  // Fail closed before decrypting: a missing/weak SESSION_SECRET makes the
  // session cookie (which carries a live git PAT) trivially decryptable.
  const secretError = assertSessionSecret(c.env);
  if (secretError) {
    return c.json({ error: secretError }, 500);
  }

  const session = await decryptSession(encrypted, c.env.SESSION_SECRET);
  if (!session?.token) {
    return c.json({ error: "Session expired", login: "/auth/providers" }, 401);
  }

  const providerName = (session.provider as string) ?? "github";
  const provider = getProvider(providerName);
  if (!provider) {
    return c.json({ error: `Unknown provider in session: ${providerName}` }, 401);
  }

  c.set("token", session.token as string);
  c.set("provider", provider);
  return next();
});

// ---------------------------------------------------------------------------
// API: List user's repos
// ---------------------------------------------------------------------------

app.get("/api/repos", async (c) => {
  const token = c.get("token");
  const provider = c.get("provider");

  const res = await fetch(provider.reposUrl(), {
    headers: {
      Authorization: provider.authHeader(token),
      "User-Agent": "agent-manager",
    },
  });

  if (!res.ok) {
    return c.json({ error: "Failed to fetch repos" }, res.status as ContentfulStatusCode);
  }

  const data = await res.json();
  return c.json(provider.parseRepos(data));
});

// ---------------------------------------------------------------------------
// API: Read config from a repo
// ---------------------------------------------------------------------------

app.get("/api/config/:owner/:repo", async (c) => {
  const token = c.get("token");
  const provider = c.get("provider");
  const { owner, repo } = c.req.param();

  const res = await fetch(provider.fileUrl(owner, repo, "config.toml"), {
    headers: {
      Authorization: provider.authHeader(token),
      "User-Agent": "agent-manager",
      Accept: provider.rawAccept(),
    },
  });

  if (!res.ok) {
    return c.json({ error: "Config not found", status: res.status }, 404);
  }

  const content = await res.text();

  try {
    const TOML = await import("@iarna/toml");
    // Two-pass redaction, identical to the local server (src/web/server.ts)
    // and the MCP am_config_show path: redactConfigSecrets masks enc: envelopes
    // (v1 + v2 age), redactConfigPlaintextSecrets masks the PLAINTEXT secrets the
    // envelope pass misses (env/headers maps by location, named secret scalars
    // like a2a.auth_token, credential userinfo in URLs). The unredacted `raw`
    // TOML text is deliberately NOT returned — it would leak every plaintext
    // secret verbatim, bypassing the structural redactor entirely.
    const parsed = redactConfigPlaintextSecrets(redactConfigSecrets(TOML.parse(content)));
    return c.json({ parsed });
  } catch {
    // Parse failed: we cannot structurally redact, so we MUST NOT return the raw
    // content (it may carry plaintext secrets). Fail closed with a warning only.
    return c.json({
      parsed: null,
      warning: "TOML parsing failed — raw content withheld to avoid leaking secrets",
    });
  }
});

// ---------------------------------------------------------------------------
// API: List servers from a repo's config
// ---------------------------------------------------------------------------

app.get("/api/servers/:owner/:repo", async (c) => {
  const token = c.get("token");
  const provider = c.get("provider");
  const { owner, repo } = c.req.param();

  const res = await fetch(provider.fileUrl(owner, repo, "config.toml"), {
    headers: {
      Authorization: provider.authHeader(token),
      "User-Agent": "agent-manager",
      Accept: provider.rawAccept(),
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
  const token = c.get("token");
  const provider = c.get("provider");
  const { owner, repo } = c.req.param();
  const body = (await c.req.json()) as { content: string; message?: string };

  if (!body.content) {
    return c.json({ error: "Missing content field" }, 400);
  }

  // Get file metadata (SHA needed for updates on GitHub/Gitea)
  const getRes = await fetch(provider.fileMetaUrl(owner, repo, "config.toml"), {
    headers: {
      Authorization: provider.authHeader(token),
      "User-Agent": "agent-manager",
    },
  });

  if (!getRes.ok) return c.json({ error: "Config not found" }, 404);

  const fileData = await getRes.json();
  const sha = provider.parseFileSha(fileData);
  const commitMessage = body.message ?? "Update config via agent-manager web UI";
  const updateBody = provider.buildUpdateBody(body.content, sha, commitMessage);

  const updateRes = await fetch(provider.updateFileUrl(owner, repo, "config.toml"), {
    method: "PUT",
    headers: {
      Authorization: provider.authHeader(token),
      "User-Agent": "agent-manager",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(updateBody),
  });

  if (!updateRes.ok) {
    const err = await updateRes.json();
    return c.json({ error: "Commit failed", detail: err }, 500);
  }

  const result = await updateRes.json();
  const commitSha = provider.parseCommitSha(result);
  return c.json({ success: true, sha: commitSha });
});

// ---------------------------------------------------------------------------
// API: Wiki — browse wiki pages from git-backed AM repo
// ---------------------------------------------------------------------------

app.get("/api/wiki/:owner/:repo/pages", async (c) => {
  const token = c.get("token");
  const provider = c.get("provider");
  const { owner, repo } = c.req.param();
  const project = c.req.query("project");

  // Validate the project component BEFORE composing the wiki path: a value
  // like `../x` would escape the wiki dir. Reject with 400; never echo it back.
  if (project !== undefined && !isValidWikiComponent(project)) {
    return c.json({ error: "Invalid project" }, 400);
  }

  const wikiPath = project ? `wiki/projects/${project}` : "wiki/global";
  const treeRes = await fetch(provider.treeUrl(owner, repo, "main"), {
    headers: {
      Authorization: provider.authHeader(token),
      Accept: "application/json",
      "User-Agent": "agent-manager",
    },
  });

  if (!treeRes.ok)
    return c.json(
      { error: "Could not read wiki from repository" },
      treeRes.status as ContentfulStatusCode,
    );

  const treeData = await treeRes.json();
  const pages = provider.parseTree(treeData, wikiPath);
  return c.json({ pages });
});

app.get("/api/wiki/:owner/:repo/projects", async (c) => {
  const token = c.get("token");
  const provider = c.get("provider");
  const { owner, repo } = c.req.param();

  const treeRes = await fetch(provider.dirUrl(owner, repo, "wiki/projects"), {
    headers: {
      Authorization: provider.authHeader(token),
      Accept: "application/json",
      "User-Agent": "agent-manager",
    },
  });

  if (!treeRes.ok) return c.json({ projects: [] });
  const contents = await treeRes.json();
  const projects = provider.parseDirs(contents);
  return c.json({ projects });
});

app.get("/api/wiki/:owner/:repo/pages/:slug", async (c) => {
  const token = c.get("token");
  const provider = c.get("provider");
  const { owner, repo, slug } = c.req.param();
  const project = c.req.query("project");
  const type = c.req.query("type") ?? "entities";

  // Validate every component BEFORE composing the file path. project/type/slug
  // are interpolated into a remote git path; an unguarded `../` segment lets an
  // authenticated caller traverse to arbitrary repo files. Reject with 400 and
  // never echo the offending value back.
  if (project !== undefined && !isValidWikiComponent(project)) {
    return c.json({ error: "Invalid project" }, 400);
  }
  if (!isValidWikiType(type)) {
    return c.json({ error: "Invalid type" }, 400);
  }
  if (!isValidWikiComponent(slug)) {
    return c.json({ error: "Invalid slug" }, 400);
  }

  const filePath = project
    ? `wiki/projects/${project}/${type}/${slug}.md`
    : `wiki/global/${type}/${slug}.md`;

  const fileRes = await fetch(provider.fileUrl(owner, repo, filePath), {
    headers: {
      Authorization: provider.authHeader(token),
      Accept: provider.rawAccept(),
      "User-Agent": "agent-manager",
    },
  });

  if (!fileRes.ok) return c.json({ error: "Page not found" }, 404);
  const content = await fileRes.text();

  return c.json({ slug, type, content });
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
