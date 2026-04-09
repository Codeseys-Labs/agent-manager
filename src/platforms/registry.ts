import { bare } from "./bare";
import { github } from "./github";
import { gitlab } from "./gitlab";
import type { GitPlatformAdapter } from "./types";

/** Ordered by specificity — most specific first, bare last as fallback. */
const PLATFORMS: GitPlatformAdapter[] = [github, gitlab, bare];

/**
 * Detect the git platform from a remote URL.
 * Returns the most specific matching adapter, or bare as fallback.
 */
export function detectPlatform(remoteUrl: string): GitPlatformAdapter {
  return PLATFORMS.find((p) => p.detect(remoteUrl)) ?? bare;
}

/** List all registered platform adapter names. */
export function listPlatforms(): string[] {
  return PLATFORMS.map((p) => p.meta.name);
}
