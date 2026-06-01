/**
 * SSRF guard + Agent Card validation for A2A remote fetches (WAVE SEC / SEC-3).
 *
 * A2A discovery and task delegation fetch Agent Cards and JSON-RPC endpoints
 * from user-supplied URLs (roster entries, `settings.a2a.discovery_sources`,
 * direct `am agents discover <url>`). Without a guard a hostile or mistyped
 * URL can point the client at `file://`, `localhost`, link-local metadata
 * endpoints (`169.254.169.254`), or RFC1918 internal hosts — a classic SSRF.
 *
 * Policy:
 *   - Only `http:` and `https:` schemes are allowed. Everything else
 *     (`file:`, `ftp:`, `gopher:`, `data:`, …) is rejected outright.
 *   - Hosts that are loopback, link-local, or private (RFC1918 / unique-local
 *     IPv6 / `*.localhost` / bare `localhost`) are rejected UNLESS the caller
 *     opts in via `allowPrivateNetwork` (or the `AM_A2A_ALLOW_PRIVATE=1` env
 *     var). Local development against `http://localhost:8080` is the primary
 *     legitimate use of the opt-in.
 *
 * The Agent Card returned by a peer is untrusted JSON; {@link AgentCardSchema}
 * validates its shape before any caller treats it as an `AgentCard`.
 */

import { z } from "zod";

/** Thrown when a remote URL is rejected by the SSRF guard. */
export class A2AUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "A2AUrlError";
  }
}

const ALLOWED_PROTOCOLS = new Set(["http:", "https:"]);

/**
 * Returns true when `allowPrivateNetwork` was not explicitly set and the
 * `AM_A2A_ALLOW_PRIVATE` environment variable opts in.
 */
function envAllowsPrivate(): boolean {
  const v = process.env.AM_A2A_ALLOW_PRIVATE;
  return v === "1" || v === "true";
}

/** Strip an IPv6 zone id and surrounding brackets from a URL hostname. */
function normalizeHost(hostname: string): string {
  let h = hostname.toLowerCase();
  if (h.startsWith("[") && h.endsWith("]")) h = h.slice(1, -1);
  const pct = h.indexOf("%");
  if (pct !== -1) h = h.slice(0, pct);
  // Strip a single trailing dot (fully-qualified form). Without this,
  // `localhost.` / `127.0.0.1.` are valid FQDNs that resolve to loopback but
  // slip past the literal checks (SSRF guard bypass caught in review).
  if (h.endsWith(".")) h = h.slice(0, -1);
  return h;
}

/**
 * Best-effort classification of a hostname as loopback / link-local /
 * private. Operates on the literal host string (no DNS resolution — DNS
 * rebinding is out of scope for this lightweight guard, but the common
 * footguns of literal internal addresses and `localhost` are covered).
 */
export function isPrivateHost(hostname: string): boolean {
  const host = normalizeHost(hostname);
  if (host.length === 0) return true;

  // localhost and any *.localhost label.
  if (host === "localhost" || host.endsWith(".localhost")) return true;

  // IPv6 loopback / unspecified / unique-local / link-local.
  if (host === "::1" || host === "::") return true;
  if (host.startsWith("fc") || host.startsWith("fd")) return true; // fc00::/7 unique-local
  if (host.startsWith("fe80")) return true; // link-local
  // IPv4-mapped IPv6, all spellings:
  //   - dotted tail   ::ffff:127.0.0.1            → recurse on the IPv4 tail
  //   - hex tail      ::ffff:7f00:1               → decode the last two hextets
  //   - expanded      0:0:0:0:0:ffff:7f00:1       → same, after the ffff marker
  // Anchor on the `ffff:` marker so any spelling that embeds it is covered.
  const ffffIdx = host.lastIndexOf("ffff:");
  if (host.includes("::ffff:") || /(^|:)0*:?ffff:/.test(host)) {
    const tail = host.slice(ffffIdx + "ffff:".length);
    if (tail.includes(".")) return isPrivateHost(tail); // dotted-quad tail
    // Hex tail: two hextets → 4 octets. e.g. 7f00:1 → 127.0.0.1
    const hextets = tail.split(":").filter(Boolean);
    if (hextets.length === 2) {
      const hi = Number.parseInt(hextets[0], 16);
      const lo = Number.parseInt(hextets[1], 16);
      if (Number.isFinite(hi) && Number.isFinite(lo)) {
        const a = (hi >> 8) & 0xff;
        const b = hi & 0xff;
        return isPrivateHost(`${a}.${b}.${(lo >> 8) & 0xff}.${lo & 0xff}`);
      }
    }
  }

  // IPv4 dotted-quad checks.
  const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) {
    const [a, b] = [Number(m[1]), Number(m[2])];
    if (a === 127) return true; // loopback 127.0.0.0/8
    if (a === 10) return true; // 10.0.0.0/8
    if (a === 0) return true; // 0.0.0.0/8 "this host"
    if (a === 169 && b === 254) return true; // link-local / cloud metadata 169.254.0.0/16
    if (a === 192 && b === 168) return true; // 192.168.0.0/16
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
    return false;
  }

  return false;
}

export interface UrlGuardOptions {
  /**
   * When true, private/loopback/link-local hosts are permitted. Defaults to
   * the `AM_A2A_ALLOW_PRIVATE` env var. Intended for local development only.
   */
  allowPrivateNetwork?: boolean;
}

/**
 * Validate `rawUrl` against the SSRF policy. Returns the parsed `URL` on
 * success; throws {@link A2AUrlError} on any rejection.
 */
export function validateRemoteUrl(rawUrl: string, opts?: UrlGuardOptions): URL {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new A2AUrlError(`Invalid A2A URL: ${JSON.stringify(rawUrl)}`);
  }

  if (!ALLOWED_PROTOCOLS.has(parsed.protocol)) {
    throw new A2AUrlError(
      `A2A URL scheme "${parsed.protocol}" is not allowed (only http/https): ${rawUrl}`,
    );
  }

  const allowPrivate = opts?.allowPrivateNetwork ?? envAllowsPrivate();
  if (!allowPrivate && isPrivateHost(parsed.hostname)) {
    throw new A2AUrlError(
      `A2A URL targets a private/loopback host (${parsed.hostname}); refused. ` +
        `Set AM_A2A_ALLOW_PRIVATE=1 (or pass allowPrivateNetwork) to permit local targets: ${rawUrl}`,
    );
  }

  return parsed;
}

// ── Agent Card validation (untrusted remote JSON) ────────────────

const AgentProviderSchema = z
  .object({
    organization: z.string(),
    url: z.string().optional(),
  })
  .passthrough();

const AgentCapabilitiesSchema = z
  .object({
    streaming: z.boolean().optional(),
    pushNotifications: z.boolean().optional(),
    stateTransitionHistory: z.boolean().optional(),
  })
  .passthrough();

const AgentSkillSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    description: z.string(),
    inputModes: z.array(z.string()).optional(),
    outputModes: z.array(z.string()).optional(),
    tags: z.array(z.string()).optional(),
  })
  .passthrough();

/**
 * Zod schema for an A2A Agent Card. Validates the required core fields a
 * client relies on (name, description, version, url, capabilities, skills)
 * and tolerates extra/optional v0.3 fields via `.passthrough()`. Use
 * {@link parseAgentCard} to validate untrusted remote JSON.
 */
export const AgentCardSchema = z
  .object({
    protocolVersion: z.string().optional(),
    name: z.string(),
    description: z.string(),
    version: z.string(),
    url: z.string(),
    preferredTransport: z.string().optional(),
    provider: AgentProviderSchema.optional(),
    capabilities: AgentCapabilitiesSchema,
    skills: z.array(AgentSkillSchema),
    defaultInputModes: z.array(z.string()).optional(),
    defaultOutputModes: z.array(z.string()).optional(),
  })
  .passthrough();

/**
 * Validate untrusted JSON as an Agent Card. Throws {@link A2AUrlError} with a
 * concise message on failure (the field path of the first issue).
 */
export function parseAgentCard(value: unknown): z.infer<typeof AgentCardSchema> {
  const result = AgentCardSchema.safeParse(value);
  if (!result.success) {
    const issue = result.error.issues[0];
    const path = issue?.path.join(".") || "(root)";
    throw new A2AUrlError(
      `Invalid Agent Card at "${path}": ${issue?.message ?? "validation failed"}`,
    );
  }
  return result.data;
}
