/**
 * Canonical version constant.
 *
 * Build pipeline sets BUILD_VERSION to the package.json version at compile
 * time. The fallback is "0.0.0-dev" — a SemVer-compatible sentinel that
 * signals "unreleased local build" rather than pretending to be a real
 * release (the previous "0.1.0" fallback lied and confused users).
 */
export const AM_VERSION = process.env.BUILD_VERSION ?? "0.0.0-dev";
