// ── Git Platform Adapter Types ──────────────────────────────────

export interface AuthResult {
  authenticated: boolean;
  username?: string;
}

export interface RepoOptions {
  private?: boolean;
  description?: string;
}

export interface GitPlatformAdapter {
  meta: {
    name: string;
    displayName: string;
  };

  /** Does this remote URL belong to this platform? */
  detect(remoteUrl: string): boolean;

  /** Authenticate with the platform (optional — bare git has no login). */
  login?(): Promise<AuthResult>;

  /** Check if already authenticated (optional). */
  isAuthenticated?(): Promise<boolean>;

  /** Store encryption key in platform secret store for CI/CD (optional). */
  storeKey?(repoUrl: string, key: string): Promise<void>;

  /** Retrieve encryption key from platform secret store (optional). */
  retrieveKey?(repoUrl: string): Promise<string | null>;

  /** Create a new repository on the platform (optional). */
  createRepo?(name: string, options: RepoOptions): Promise<string>;
}
