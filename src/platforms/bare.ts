import type { GitPlatformAdapter } from "./types";

/**
 * Bare git adapter — default fallback for any git remote.
 * No platform-specific features; relies on SSH/HTTP auth.
 */
export const bare: GitPlatformAdapter = {
  meta: { name: "bare", displayName: "Git" },
  detect: () => true,
};
