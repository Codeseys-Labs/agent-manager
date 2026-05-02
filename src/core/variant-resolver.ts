/**
 * Variant Resolver (ADR-0036)
 *
 * Resolves which variant of an agent to use when spawning. A variant is a
 * named `{ protocol, command, args, env, permission_policy? }` tuple on an
 * AgentProfile — one agent entry, many ways to launch it (anthropic direct
 * vs Bedrock vs OpenRouter, etc.).
 *
 * Resolution order (highest priority wins):
 *   1. Explicit variant name (from `am run --variant <name>`).
 *   2. Project config's `agents.<name>.default_variant`.
 *   3. Global config's `agents.<name>.default_variant`.
 *   4. First-defined variant in the merged TOML map (stable by insertion order).
 *
 * MVP scope (per ADR-0036):
 *   - Accepts variants on both global and project `AgentProfile` entries.
 *   - Returns resolved `{ command, args, env, permission_policy? }` for the
 *     caller to pass to the ACP spawn path.
 *   - Rejects unknown variant names with a helpful message listing what IS
 *     defined.
 *
 * Out of scope:
 *   - A2A variants (ACP-only in this PR).
 *   - Per-variant permission policy enforcement (schema only).
 *   - `${VAR}` secret interpolation in variant env values — callers should
 *     run the resolved env through `interpolateEnvAsync` before spawning.
 */

import type { AgentVariant, Config, ProjectConfig } from "./schema";

/**
 * Source of the resolved variant — which level of the resolution cascade
 * produced it. Surfaced in `am run --dry-run` output so operators can see
 * WHERE a `default_variant` was inherited from.
 *
 *   - "cli-flag"         : explicit `--variant <name>` from the CLI
 *   - "project-default"  : `default_variant` in .agent-manager.toml
 *   - "global-default"   : `default_variant` in the global config.toml
 *   - "first-defined"    : no default anywhere — first variant by insertion order
 *   - null               : agent has no variants at all (back-compat)
 */
export type VariantSource =
  | "cli-flag"
  | "project-default"
  | "global-default"
  | "sole-variant"
  | null;

/** Shape of the resolved variant, ready for the ACP spawn path. */
export interface ResolvedVariant {
  /** Name of the variant that was selected (e.g. "bedrock"). Null if the
   *  agent has no variants at all (back-compat: caller falls back to
   *  `agents.<name>.acp.command`). */
  name: string | null;
  /** Which resolution level picked this variant. */
  source: VariantSource;
  /** Protocol. Today always "acp" in the MVP. */
  protocol: "acp" | "a2a";
  /** Launch command. Undefined when the variant did not override it (caller
   *  falls back to the agent's top-level `acp.command`). */
  command?: string;
  /** Extra args appended to the launch command. */
  args?: string[];
  /** Env overlay to pass to `sandboxEnv({ ...env })` at spawn. */
  env?: Record<string, string>;
  /** Optional permission-policy override. Schema-accepted, not enforced in MVP. */
  permission_policy?: "auto-approve" | "deny";
}

export class VariantResolverError extends Error {
  constructor(
    message: string,
    public code:
      | "UNKNOWN_VARIANT"
      | "DEFAULT_VARIANT_NOT_FOUND"
      | "AGENT_HAS_NO_VARIANTS"
      | "AMBIGUOUS_VARIANT" = "UNKNOWN_VARIANT",
  ) {
    super(message);
    this.name = "VariantResolverError";
  }
}

/**
 * Resolve which variant to use for an agent.
 *
 * Returns `null` name when the agent has no variants defined anywhere AND
 * the caller did not pass an explicit variant — this is the back-compat
 * path (agents without ADR-0036 variants keep working untouched).
 *
 * @param agentName Name of the agent (e.g. "claude").
 * @param explicitVariant Variant name passed via CLI (`--variant bedrock`).
 *                        Takes priority over any default_variant setting.
 * @param config Global config (optional). Its `agents.<name>.variants` and
 *               `default_variant` are consulted at priority 3.
 * @param projectConfig Project config (optional). Its `agents.<name>.variants`
 *                      and `default_variant` are consulted at priority 2.
 */
export function resolveVariant(
  agentName: string,
  explicitVariant: string | undefined,
  config?: Config,
  projectConfig?: ProjectConfig,
): ResolvedVariant {
  // Merge variants from global + project configs. Project wins on name collision.
  const globalAgent = config?.agents?.[agentName];
  const projectAgent = projectConfig?.agents?.[agentName];

  const mergedVariants: Record<string, AgentVariant> = {};
  if (globalAgent?.variants) {
    for (const [name, variant] of Object.entries(globalAgent.variants)) {
      mergedVariants[name] = variant;
    }
  }
  if (projectAgent?.variants) {
    for (const [name, variant] of Object.entries(projectAgent.variants)) {
      mergedVariants[name] = variant;
    }
  }

  const variantNames = Object.keys(mergedVariants);

  // ── Priority 1: explicit CLI flag
  if (explicitVariant !== undefined) {
    if (variantNames.length === 0) {
      throw new VariantResolverError(
        `Agent "${agentName}" has no variants defined; cannot select "${explicitVariant}".`,
        "AGENT_HAS_NO_VARIANTS",
      );
    }
    const variant = mergedVariants[explicitVariant];
    if (!variant) {
      throw new VariantResolverError(
        `variant "${explicitVariant}" not defined for "${agentName}"; available: ${variantNames.join(", ")}`,
        "UNKNOWN_VARIANT",
      );
    }
    return toResolved(explicitVariant, variant, "cli-flag");
  }

  // No variants defined at all → back-compat (caller uses agent.acp.command).
  if (variantNames.length === 0) {
    return { name: null, source: null, protocol: "acp" };
  }

  // ── Priority 2: project config default_variant
  if (projectAgent?.default_variant !== undefined) {
    const name = projectAgent.default_variant;
    const variant = mergedVariants[name];
    if (!variant) {
      throw new VariantResolverError(
        `default_variant "${name}" (from project config) not defined for "${agentName}"; available: ${variantNames.join(", ")}`,
        "DEFAULT_VARIANT_NOT_FOUND",
      );
    }
    return toResolved(name, variant, "project-default");
  }

  // ── Priority 3: global config default_variant
  if (globalAgent?.default_variant !== undefined) {
    const name = globalAgent.default_variant;
    const variant = mergedVariants[name];
    if (!variant) {
      throw new VariantResolverError(
        `default_variant "${name}" (from global config) not defined for "${agentName}"; available: ${variantNames.join(", ")}`,
        "DEFAULT_VARIANT_NOT_FOUND",
      );
    }
    return toResolved(name, variant, "global-default");
  }

  // ── Priority 4: implicit selection
  //
  // ADR-0036 Correction 1 (Codex review): "first-defined wins" was dropped
  // because it's a silent-ordering footgun — adding a variant at the top of
  // the TOML would change which one was launched. Instead:
  //   - If exactly ONE variant exists, use it implicitly (no ambiguity).
  //   - If MORE than one exists with no default_variant anywhere AND no
  //     --variant flag, ERROR with a clear "ambiguous" message.
  if (variantNames.length === 1) {
    const soleName = variantNames[0];
    return toResolved(soleName, mergedVariants[soleName], "sole-variant");
  }
  throw new VariantResolverError(
    `ambiguous variant for "${agentName}": ${variantNames.length} variants defined (${variantNames.join(", ")}) but no default_variant is set and no --variant flag was passed. Either set default_variant in config or pass --variant <name>.`,
    "AMBIGUOUS_VARIANT",
  );
}

function toResolved(name: string, v: AgentVariant, source: VariantSource): ResolvedVariant {
  return {
    name,
    source,
    protocol: v.protocol,
    command: v.command,
    args: v.args,
    env: v.env,
    permission_policy: v.permission_policy,
  };
}

/**
 * True if ADR-0036 variants are enabled via the `AM_VARIANTS=1` env var.
 * Per the ADR, variants are gated behind an opt-in flag for the first
 * release post-acceptance. Remove the gate in the release-after-next.
 */
export function isVariantsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.AM_VARIANTS === "1";
}
