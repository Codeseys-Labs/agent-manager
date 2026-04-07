import type { GitPlatformAdapter } from "./types";

/**
 * GitLab platform adapter — stub for Phase 2.
 * Detection works; all platform features throw with a Phase 2 notice.
 */
export const gitlab: GitPlatformAdapter = {
  meta: { name: "gitlab", displayName: "GitLab" },

  detect(remoteUrl: string): boolean {
    return remoteUrl.includes("gitlab");
  },

  async login() {
    throw new Error("GitLab platform adapter coming in Phase 2");
  },

  async isAuthenticated() {
    throw new Error("GitLab platform adapter coming in Phase 2");
  },

  async storeKey() {
    throw new Error("GitLab platform adapter coming in Phase 2");
  },

  async retrieveKey() {
    throw new Error("GitLab platform adapter coming in Phase 2");
  },

  async createRepo() {
    throw new Error("GitLab platform adapter coming in Phase 2");
  },
};
