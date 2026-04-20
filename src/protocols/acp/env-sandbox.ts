/**
 * env-sandbox.ts — Scrub the parent-process environment before spawning
 * ACP agent subprocesses or terminals.
 *
 * REV-2 HIGH-3 / ADR-0033 Phase B prelaunch gate: `Bun.spawn({ env: process.env })`
 * leaks `AM_MCP_TOKEN`, `AM_ENCRYPTION_KEY`, `AWS_SESSION_TOKEN`, bearer tokens,
 * and every OpenAI/Anthropic/Google credential present in the parent environment
 * into the spawned agent. For Tier-1 native ACP agents this was already a latent
 * risk; for Phase B tier-2 shim wrappers (aider / amazon-q / cody) it becomes a
 * material exfiltration path because those CLIs have verbose logging modes we
 * don't control.
 *
 * Strategy: allowlist first, deny-regex on top. Even if an entry is on the
 * allowlist, a suspicious name (matches the deny regex) is still stripped.
 * The caller may explicitly overlay env via the `extra` parameter (e.g. from
 * `am run --env KEY=VALUE`) — that overlay IS trusted and bypasses the deny
 * regex so the user can forward a specific var they need.
 *
 * REV-4 MED-2: `NODE_OPTIONS` is NOT on the default allow-list. It is an attack
 * surface because it lets the parent environment inject `--require shim.js`,
 * `--inspect`, or `--env-file=...` into every Node-based agent subprocess —
 * including the Phase B tier-2 shim wrappers (aider/amazon-q/cody) that run
 * under Node in some installs. Callers that genuinely need NODE_OPTIONS for a
 * specific tier-1 Node-based agent must pass it explicitly via the `extra`
 * parameter, e.g. `sandboxEnv({ NODE_OPTIONS: "--max-old-space-size=4096" })`.
 * No built-in ACP agent currently requires this.
 */

/**
 * Environment variables that are safe to inherit by default.
 *
 * Rationale per-entry:
 *   PATH, HOME, USER, SHELL   — required for most CLIs to find binaries / identify caller
 *   LANG, LC_*, TERM          — locale / terminal behaviour (affects output encoding)
 *   TMPDIR                    — tools that write temp files (aider, q) look here first
 *   XDG_CONFIG_HOME, XDG_DATA_HOME — config/data path resolution for many CLIs
 *
 * Deliberately OMITTED (REV-4 MED-2): NODE_OPTIONS — see module docstring.
 */
const DEFAULT_ALLOW_LIST = [
  "PATH",
  "HOME",
  "USER",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "LC_MESSAGES",
  "TERM",
  "TMPDIR",
  "SHELL",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
] as const;

/**
 * Deny regex applied AFTER the allowlist. Any variable whose name matches
 * this pattern is stripped even if it made it onto the allowlist (defence
 * in depth).
 *
 * Patterns:
 *   AM_*              — agent-manager internals (AM_MCP_TOKEN, AM_ENCRYPTION_KEY, AM_KEY_PATH)
 *   *_(TOKEN|SECRET|KEY|PASSWORD|CRED|SESSION)
 *                     — generic credential naming conventions
 *   AWS_*             — AWS SDK credentials (AWS_ACCESS_KEY_ID, AWS_SESSION_TOKEN, ...)
 *   GITHUB_TOKEN      — gh-cli / CI tokens
 *   OPENAI_*          — OpenAI SDK credentials
 *   ANTHROPIC_*       — Anthropic SDK credentials
 *   GOOGLE_*          — Google auth (GOOGLE_APPLICATION_CREDENTIALS, GOOGLE_API_KEY)
 */
const DENY_PATTERN =
  /^(AM_|.*_(TOKEN|SECRET|KEY|PASSWORD|CRED|SESSION)|AWS_.*|GITHUB_TOKEN|OPENAI_.*|ANTHROPIC_.*|GOOGLE_.*)/i;

/**
 * Build a scrubbed env for a subprocess. Uses the allowlist from
 * `process.env`, strips anything matching the deny regex, then overlays
 * `extra` (which is trusted — the caller has already decided to pass these).
 *
 * @param extra   Explicitly-forwarded env vars (e.g. from `am run --env X=Y`).
 *                These bypass the deny regex on the assumption that the caller
 *                made a deliberate choice.
 * @returns       A fresh object safe to pass to `Bun.spawn({ env })`.
 */
export function sandboxEnv(extra?: Record<string, string>): Record<string, string> {
  const result: Record<string, string> = {};

  // Phase 1: allow-list from process.env, filtered by the deny regex.
  for (const key of DEFAULT_ALLOW_LIST) {
    const value = process.env[key];
    if (value === undefined) continue;
    if (DENY_PATTERN.test(key)) continue;
    result[key] = value;
  }

  // Phase 2: overlay trusted extras.
  if (extra) {
    for (const [key, value] of Object.entries(extra)) {
      if (value === undefined) continue;
      result[key] = value;
    }
  }

  return result;
}

/**
 * Test helper — exposed for unit tests that want to verify the deny regex
 * without reaching into module internals.
 */
export function isDeniedEnvName(name: string): boolean {
  return DENY_PATTERN.test(name);
}
