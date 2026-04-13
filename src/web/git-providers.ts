/**
 * Git provider abstraction for the stateless web worker.
 * Each provider knows how to: OAuth, list repos, read/write files, list trees.
 *
 * Supports GitHub, GitLab, Codeberg/Gitea (configurable base URL), and
 * self-hosted instances via env var configuration.
 *
 * See ADR-0025 for design rationale.
 */

// ---------------------------------------------------------------------------
// Interface
// ---------------------------------------------------------------------------

export interface GitProvider {
  name: string;
  displayName: string;

  /** OAuth authorization URL */
  authUrl(clientId: string, redirectUri: string, state: string): string;

  /** Token exchange endpoint */
  tokenUrl(): string;

  /** OAuth scopes needed for repo access */
  scopes(): string;

  /** Get authenticated user info */
  userUrl(): string;

  /** List user's repos */
  reposUrl(page?: number): string;

  /** Get file contents (raw) */
  fileUrl(owner: string, repo: string, path: string): string;

  /** Get file metadata (for SHA needed on updates) */
  fileMetaUrl(owner: string, repo: string, path: string): string;

  /** Update/create file */
  updateFileUrl(owner: string, repo: string, path: string): string;

  /** Git tree (recursive, for wiki page listing) */
  treeUrl(owner: string, repo: string, branch: string): string;

  /** Directory listing */
  dirUrl(owner: string, repo: string, path: string): string;

  /** Accept header for raw content */
  rawAccept(): string;

  /** Auth header format */
  authHeader(token: string): string;

  /** Parse repo list response to uniform format */
  parseRepos(
    data: unknown,
  ): Array<{ name: string; url: string; private: boolean; updated: string }>;

  /** Parse tree response for wiki pages */
  parseTree(data: unknown, prefix: string): Array<{ slug: string; type: string; path: string }>;

  /** Parse directory listing for project names */
  parseDirs(data: unknown): string[];

  /** Parse file metadata to extract the SHA (for updates). Returns empty string if not found. */
  parseFileSha(data: unknown): string;

  /** Build the update/create file request body */
  buildUpdateBody(content: string, sha: string, message: string): Record<string, unknown>;

  /** Parse the commit response to extract the commit SHA */
  parseCommitSha(data: unknown): string;

  /** Token exchange requires grant_type form param (GitLab/Gitea) vs JSON (GitHub) */
  tokenExchangeBody(
    clientId: string,
    clientSecret: string,
    code: string,
    redirectUri: string,
  ): { body: string; contentType: string };

  /** Parse the token exchange response to extract the access token */
  parseTokenResponse(data: unknown): string | undefined;

  /** Parse user info response */
  parseUser(data: unknown): { login: string; avatar: string };
}

// ---------------------------------------------------------------------------
// GitHub
// ---------------------------------------------------------------------------

export const githubProvider: GitProvider = {
  name: "github",
  displayName: "GitHub",

  authUrl: (clientId, redirectUri, state) => {
    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      scope: "contents:read contents:write",
      state,
    });
    return `https://github.com/login/oauth/authorize?${params}`;
  },

  tokenUrl: () => "https://github.com/login/oauth/access_token",
  scopes: () => "contents:read contents:write",
  userUrl: () => "https://api.github.com/user",
  reposUrl: (page = 1) =>
    `https://api.github.com/user/repos?per_page=100&sort=updated&page=${page}`,

  fileUrl: (owner, repo, path) => `https://api.github.com/repos/${owner}/${repo}/contents/${path}`,
  fileMetaUrl: (owner, repo, path) =>
    `https://api.github.com/repos/${owner}/${repo}/contents/${path}`,
  updateFileUrl: (owner, repo, path) =>
    `https://api.github.com/repos/${owner}/${repo}/contents/${path}`,

  treeUrl: (owner, repo, branch) =>
    `https://api.github.com/repos/${owner}/${repo}/git/trees/${branch}?recursive=1`,
  dirUrl: (owner, repo, path) => `https://api.github.com/repos/${owner}/${repo}/contents/${path}`,

  rawAccept: () => "application/vnd.github.raw+json",
  authHeader: (token) => `Bearer ${token}`,

  parseRepos: (data) =>
    (
      data as Array<{ full_name: string; clone_url: string; private: boolean; updated_at: string }>
    ).map((r) => ({
      name: r.full_name,
      url: r.clone_url,
      private: r.private,
      updated: r.updated_at,
    })),

  parseTree: (data, prefix) =>
    ((data as { tree: Array<{ path: string; type: string }> }).tree ?? [])
      .filter((f) => f.path.startsWith(prefix) && f.path.endsWith(".md") && f.type === "blob")
      .map((f) => {
        const p = f.path.split("/");
        return {
          slug: p[p.length - 1].replace(".md", ""),
          type: p[p.length - 2],
          path: f.path,
        };
      }),

  parseDirs: (data) =>
    Array.isArray(data)
      ? (data as Array<{ type: string; name: string }>)
          .filter((f) => f.type === "dir")
          .map((f) => f.name)
      : [],

  parseFileSha: (data) => (data as { sha?: string }).sha ?? "",

  buildUpdateBody: (content, sha, message) => ({
    message,
    content: btoa(content),
    sha,
  }),

  parseCommitSha: (data) => (data as { commit?: { sha?: string } }).commit?.sha ?? "",

  tokenExchangeBody: (clientId, clientSecret, code, _redirectUri) => ({
    body: JSON.stringify({
      client_id: clientId,
      client_secret: clientSecret,
      code,
    }),
    contentType: "application/json",
  }),

  parseTokenResponse: (data) => (data as { access_token?: string }).access_token,

  parseUser: (data) => {
    const d = data as { login: string; avatar_url: string };
    return { login: d.login, avatar: d.avatar_url };
  },
};

// ---------------------------------------------------------------------------
// GitLab
// ---------------------------------------------------------------------------

export const gitlabProvider: GitProvider = {
  name: "gitlab",
  displayName: "GitLab",

  authUrl: (clientId, redirectUri, state) => {
    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: "code",
      scope: "read_repository write_repository",
      state,
    });
    return `https://gitlab.com/oauth/authorize?${params}`;
  },

  tokenUrl: () => "https://gitlab.com/oauth/token",
  scopes: () => "read_repository write_repository",
  userUrl: () => "https://gitlab.com/api/v4/user",
  reposUrl: (page = 1) =>
    `https://gitlab.com/api/v4/projects?membership=true&per_page=100&order_by=updated_at&page=${page}`,

  fileUrl: (owner, repo, path) =>
    `https://gitlab.com/api/v4/projects/${encodeURIComponent(`${owner}/${repo}`)}/repository/files/${encodeURIComponent(path)}/raw?ref=main`,
  fileMetaUrl: (owner, repo, path) =>
    `https://gitlab.com/api/v4/projects/${encodeURIComponent(`${owner}/${repo}`)}/repository/files/${encodeURIComponent(path)}?ref=main`,
  updateFileUrl: (owner, repo, path) =>
    `https://gitlab.com/api/v4/projects/${encodeURIComponent(`${owner}/${repo}`)}/repository/files/${encodeURIComponent(path)}`,

  treeUrl: (owner, repo, _branch) =>
    `https://gitlab.com/api/v4/projects/${encodeURIComponent(`${owner}/${repo}`)}/repository/tree?recursive=true&per_page=100`,
  dirUrl: (owner, repo, path) =>
    `https://gitlab.com/api/v4/projects/${encodeURIComponent(`${owner}/${repo}`)}/repository/tree?path=${encodeURIComponent(path)}&per_page=100`,

  rawAccept: () => "text/plain",
  authHeader: (token) => `Bearer ${token}`,

  parseRepos: (data) =>
    (
      data as Array<{
        path_with_namespace: string;
        http_url_to_repo: string;
        visibility: string;
        last_activity_at: string;
      }>
    ).map((r) => ({
      name: r.path_with_namespace,
      url: r.http_url_to_repo,
      private: r.visibility === "private",
      updated: r.last_activity_at,
    })),

  parseTree: (data, prefix) =>
    (data as Array<{ path: string; type: string }>)
      .filter((f) => f.path.startsWith(prefix) && f.path.endsWith(".md") && f.type === "blob")
      .map((f) => {
        const p = f.path.split("/");
        return {
          slug: p[p.length - 1].replace(".md", ""),
          type: p[p.length - 2],
          path: f.path,
        };
      }),

  parseDirs: (data) =>
    Array.isArray(data)
      ? (data as Array<{ type: string; name: string }>)
          .filter((f) => f.type === "tree")
          .map((f) => f.name)
      : [],

  parseFileSha: (data) => (data as { content_sha256?: string; blob_id?: string }).blob_id ?? "",

  buildUpdateBody: (content, _sha, message) => ({
    branch: "main",
    content,
    commit_message: message,
    encoding: "text",
  }),

  parseCommitSha: (data) => (data as { file_path?: string; branch?: string }).branch ?? "main",

  tokenExchangeBody: (clientId, clientSecret, code, redirectUri) => ({
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      code,
      grant_type: "authorization_code",
      redirect_uri: redirectUri,
    }).toString(),
    contentType: "application/x-www-form-urlencoded",
  }),

  parseTokenResponse: (data) => (data as { access_token?: string }).access_token,

  parseUser: (data) => {
    const d = data as { username: string; avatar_url: string };
    return { login: d.username, avatar: d.avatar_url ?? "" };
  },
};

// ---------------------------------------------------------------------------
// Gitea / Codeberg (configurable base URL)
// ---------------------------------------------------------------------------

export function createGiteaProvider(
  baseUrl: string,
  name: string,
  displayName: string,
): GitProvider {
  const api = `${baseUrl}/api/v1`;

  return {
    name,
    displayName,

    authUrl: (clientId, redirectUri, state) => {
      const params = new URLSearchParams({
        client_id: clientId,
        redirect_uri: redirectUri,
        response_type: "code",
        scope: "repository",
        state,
      });
      return `${baseUrl}/login/oauth/authorize?${params}`;
    },

    tokenUrl: () => `${baseUrl}/login/oauth/access_token`,
    scopes: () => "repository",
    userUrl: () => `${api}/user`,
    reposUrl: (page = 1) => `${api}/user/repos?page=${page}&limit=50&sort=updated`,

    fileUrl: (owner, repo, path) =>
      `${api}/repos/${owner}/${repo}/raw/${encodeURIComponent(path)}?ref=main`,
    fileMetaUrl: (owner, repo, path) =>
      `${api}/repos/${owner}/${repo}/contents/${encodeURIComponent(path)}?ref=main`,
    updateFileUrl: (owner, repo, path) =>
      `${api}/repos/${owner}/${repo}/contents/${encodeURIComponent(path)}`,

    treeUrl: (owner, repo, _branch) =>
      `${api}/repos/${owner}/${repo}/git/trees/main?recursive=true`,
    dirUrl: (owner, repo, path) =>
      `${api}/repos/${owner}/${repo}/contents/${encodeURIComponent(path)}?ref=main`,

    rawAccept: () => "application/json",
    authHeader: (token) => `token ${token}`,

    parseRepos: (data) =>
      (
        data as Array<{
          full_name: string;
          clone_url: string;
          private: boolean;
          updated_at: string;
        }>
      ).map((r) => ({
        name: r.full_name,
        url: r.clone_url,
        private: r.private,
        updated: r.updated_at,
      })),

    parseTree: (data, prefix) => {
      const tree = (data as { tree?: Array<{ path: string; type: string }> }).tree ?? [];
      return tree
        .filter((f) => f.path?.startsWith(prefix) && f.path.endsWith(".md"))
        .map((f) => {
          const p = f.path.split("/");
          return {
            slug: p[p.length - 1].replace(".md", ""),
            type: p[p.length - 2],
            path: f.path,
          };
        });
    },

    parseDirs: (data) =>
      Array.isArray(data)
        ? (data as Array<{ type: string; name: string }>)
            .filter((f) => f.type === "dir")
            .map((f) => f.name)
        : [],

    parseFileSha: (data) => (data as { sha?: string }).sha ?? "",

    buildUpdateBody: (content, sha, message) => ({
      message,
      content: btoa(content),
      sha,
    }),

    parseCommitSha: (data) => (data as { content?: { sha?: string } })?.content?.sha ?? "",

    tokenExchangeBody: (clientId, clientSecret, code, redirectUri) => ({
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        code,
        grant_type: "authorization_code",
        redirect_uri: redirectUri,
      }).toString(),
      contentType: "application/x-www-form-urlencoded",
    }),

    parseTokenResponse: (data) => (data as { access_token?: string }).access_token,

    parseUser: (data) => {
      const d = data as { login: string; avatar_url: string };
      return { login: d.login, avatar: d.avatar_url ?? "" };
    },
  };
}

/** Pre-built Codeberg provider (Gitea-based) */
export const codebergProvider = createGiteaProvider("https://codeberg.org", "codeberg", "Codeberg");

// ---------------------------------------------------------------------------
// Provider registry
// ---------------------------------------------------------------------------

const PROVIDERS: Record<string, GitProvider> = {
  github: githubProvider,
  gitlab: gitlabProvider,
  codeberg: codebergProvider,
};

export function getProvider(name: string): GitProvider | undefined {
  return PROVIDERS[name];
}

export function listProviders(): GitProvider[] {
  return Object.values(PROVIDERS);
}

/** Register a self-hosted Gitea instance as a provider. Returns the new provider. */
export function registerGiteaInstance(url: string, name: string): GitProvider {
  const provider = createGiteaProvider(url, name, `Gitea (${url})`);
  PROVIDERS[name] = provider;
  return provider;
}
