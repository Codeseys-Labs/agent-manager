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

/** Extract owner/repo from a GitHub URL. */
function parseRepo(url: string): string | null {
  // git@github.com:owner/repo.git or https://github.com/owner/repo.git
  const sshMatch = url.match(/github\.com[:/]([^/]+\/[^/.]+)/);
  if (sshMatch) return sshMatch[1];
  return null;
}

export const github: GitPlatformAdapter = {
  meta: { name: "github", displayName: "GitHub" },

  detect(remoteUrl: string): boolean {
    return remoteUrl.includes("github.com");
  },

  async login(): Promise<AuthResult> {
    // Check if gh CLI is available
    const which = await run(["which", "gh"]);
    if (which.code !== 0) {
      return { authenticated: false };
    }

    // Check current auth status
    const status = await run(["gh", "auth", "status"]);
    if (status.code === 0) {
      const match = status.stdout.match(/Logged in to github\.com.*account\s+(\S+)/);
      return {
        authenticated: true,
        username: match?.[1],
      };
    }

    return { authenticated: false };
  },

  async isAuthenticated(): Promise<boolean> {
    const result = await run(["gh", "auth", "status"]);
    return result.code === 0;
  },

  async storeKey(repoUrl: string, key: string): Promise<void> {
    const repo = parseRepo(repoUrl);
    if (!repo) {
      throw new Error(`Cannot parse GitHub repo from URL: ${repoUrl}`);
    }
    const result = await run([
      "gh",
      "secret",
      "set",
      "AM_ENCRYPTION_KEY",
      "--repo",
      repo,
      "--body",
      key,
    ]);
    if (result.code !== 0) {
      throw new Error(`Failed to store secret: ${result.stderr}`);
    }
  },

  async retrieveKey(_repoUrl: string): Promise<string | null> {
    // GitHub Secrets API is write-only — cannot read values back.
    // Keys must be distributed via password manager for local dev.
    return null;
  },

  async createRepo(name: string, options: RepoOptions = {}): Promise<string> {
    const args = ["gh", "repo", "create", name];
    if (options.private !== false) args.push("--private");
    if (options.description) args.push("--description", options.description);
    args.push("--confirm");

    const result = await run(args);
    if (result.code !== 0) {
      throw new Error(`Failed to create repo: ${result.stderr}`);
    }
    return result.stdout;
  },
};
