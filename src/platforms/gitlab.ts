import type { AuthResult, GitPlatformAdapter, RepoOptions } from "./types";

/** Run a command safely using Bun.spawn (array form, no shell injection). */
async function run(cmd: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(cmd, {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const code = await proc.exited;
  return { code, stdout: stdout.trim(), stderr: stderr.trim() };
}

/** Extract owner/repo from a GitLab URL. */
function parseRepo(url: string): string | null {
  // git@gitlab.com:owner/repo.git or https://gitlab.com/owner/repo.git
  // Also handles self-hosted: git@gitlab.example.com:group/subgroup/repo.git
  const sshMatch = url.match(/gitlab[^:/]*[:/](.+?)(?:\.git)?$/);
  if (sshMatch) return sshMatch[1];
  return null;
}

export const gitlab: GitPlatformAdapter = {
  meta: { name: "gitlab", displayName: "GitLab" },

  detect(remoteUrl: string): boolean {
    return remoteUrl.includes("gitlab");
  },

  async login(): Promise<AuthResult> {
    const which = await run(["which", "glab"]);
    if (which.code !== 0) {
      return { authenticated: false };
    }

    const status = await run(["glab", "auth", "status"]);
    if (status.code === 0) {
      const match = status.stdout.match(/Logged in to\s+\S+\s+as\s+(\S+)/);
      return {
        authenticated: true,
        username: match?.[1],
      };
    }

    return { authenticated: false };
  },

  async isAuthenticated(): Promise<boolean> {
    const result = await run(["glab", "auth", "status"]);
    return result.code === 0;
  },

  async storeKey(repoUrl: string, key: string): Promise<void> {
    const repo = parseRepo(repoUrl);
    if (!repo) {
      throw new Error(`Cannot parse GitLab repo from URL: ${repoUrl}`);
    }
    const result = await run([
      "glab",
      "variable",
      "set",
      "AM_ENCRYPTION_KEY",
      "--value",
      key,
      "--repo",
      repo,
    ]);
    if (result.code !== 0) {
      throw new Error(`Failed to store variable: ${result.stderr}`);
    }
  },

  async retrieveKey(repoUrl: string): Promise<string | null> {
    const repo = parseRepo(repoUrl);
    if (!repo) {
      throw new Error(`Cannot parse GitLab repo from URL: ${repoUrl}`);
    }
    const result = await run(["glab", "variable", "get", "AM_ENCRYPTION_KEY", "--repo", repo]);
    if (result.code !== 0) {
      return null;
    }
    return result.stdout || null;
  },

  async createRepo(name: string, options: RepoOptions = {}): Promise<string> {
    const args = ["glab", "repo", "create", name];
    if (options.private !== false) args.push("--private");
    if (options.description) args.push("--description", options.description);

    const result = await run(args);
    if (result.code !== 0) {
      throw new Error(`Failed to create repo: ${result.stderr}`);
    }
    return result.stdout;
  },
};
