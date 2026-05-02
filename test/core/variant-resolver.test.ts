/**
 * variant-resolver.test.ts — ADR-0036 Phase A (Correction 1 applied).
 *
 * Covers the resolution order:
 *   1. Explicit CLI flag (`--variant bedrock`)
 *   2. Project config `agents.<name>.default_variant`
 *   3. Global config `agents.<name>.default_variant`
 *   4. Sole variant (exactly one declared) → implicit selection
 *      Multiple variants + no default + no flag → AMBIGUOUS_VARIANT error
 *
 * Plus error cases (unknown variant name, unknown default_variant, ambiguous)
 * and the back-compat path (agent declares no variants — name=null).
 */

import { describe, expect, test } from "bun:test";
import type { Config, ProjectConfig } from "../../src/core/schema";
import {
  VariantResolverError,
  isVariantsEnabled,
  resolveVariant,
} from "../../src/core/variant-resolver";

// ── Helpers ────────────────────────────────────────────────────

const baseAgent = { name: "claude" };

/** Build a Config with a single agent entry. */
function config(variants: Record<string, unknown>, defaultVariant?: string): Config {
  return {
    agents: {
      claude: {
        ...baseAgent,
        ...(defaultVariant !== undefined ? { default_variant: defaultVariant } : {}),
        variants,
      },
    },
  } as unknown as Config;
}

function projectConfig(variants: Record<string, unknown>, defaultVariant?: string): ProjectConfig {
  return {
    agents: {
      claude: {
        ...baseAgent,
        ...(defaultVariant !== undefined ? { default_variant: defaultVariant } : {}),
        variants,
      },
    },
  } as unknown as ProjectConfig;
}

// ── Resolution order ───────────────────────────────────────────

describe("resolveVariant: resolution order", () => {
  test("priority 1: explicit flag beats project + global defaults", () => {
    const variants = {
      anthropic: { protocol: "acp", command: "npx claude-agent-acp" },
      bedrock: { protocol: "acp", command: "npx claude-agent-acp", env: { AWS: "1" } },
      vertex: { protocol: "acp", command: "npx claude-agent-acp", env: { GCP: "1" } },
    };
    const result = resolveVariant(
      "claude",
      "bedrock", // explicit flag
      config(variants, "anthropic"),
      projectConfig(variants, "vertex"),
    );
    expect(result.name).toBe("bedrock");
    expect(result.env).toEqual({ AWS: "1" });
  });

  test("priority 2: project default_variant beats global default_variant", () => {
    const variants = {
      anthropic: { protocol: "acp", command: "npx claude-agent-acp" },
      bedrock: { protocol: "acp", command: "npx claude-agent-acp", env: { AWS: "1" } },
    };
    const result = resolveVariant(
      "claude",
      undefined, // no explicit flag
      config(variants, "anthropic"),
      projectConfig(variants, "bedrock"),
    );
    expect(result.name).toBe("bedrock");
    expect(result.env).toEqual({ AWS: "1" });
  });

  test("priority 3: global default_variant wins when project has no default", () => {
    const variants = {
      anthropic: { protocol: "acp", command: "npx claude-agent-acp" },
      bedrock: { protocol: "acp", command: "npx claude-agent-acp", env: { AWS: "1" } },
    };
    const result = resolveVariant(
      "claude",
      undefined,
      config(variants, "bedrock"),
      undefined, // no project config
    );
    expect(result.name).toBe("bedrock");
  });

  test("priority 4: sole variant is picked implicitly when exactly one is declared", () => {
    const variants = {
      anthropic: { protocol: "acp", command: "npx claude-agent-acp" },
    };
    const result = resolveVariant("claude", undefined, config(variants), undefined);
    expect(result.name).toBe("anthropic");
    expect(result.source).toBe("sole-variant");
  });

  test("ADR-0036 Correction 1: ambiguous (>1 variant, no default, no flag) → error", () => {
    const variants = {
      anthropic: { protocol: "acp", command: "npx claude-agent-acp" },
      bedrock: { protocol: "acp", command: "npx claude-agent-acp" },
      vertex: { protocol: "acp", command: "npx claude-agent-acp" },
    };
    try {
      resolveVariant("claude", undefined, config(variants), undefined);
      throw new Error("expected throw");
    } catch (err: unknown) {
      if (!(err instanceof VariantResolverError)) throw err;
      expect(err.code).toBe("AMBIGUOUS_VARIANT");
      expect(err.message.toLowerCase()).toContain("ambiguous");
      expect(err.message).toContain("default_variant");
      expect(err.message).toContain("--variant");
      // Lists the offenders so operators know what names are available.
      expect(err.message).toContain("anthropic");
      expect(err.message).toContain("bedrock");
      expect(err.message).toContain("vertex");
    }
  });

  test("project variants merge with global variants — project wins on name collision", () => {
    const globalVariants = {
      anthropic: { protocol: "acp", command: "npx claude", env: { SOURCE: "global" } },
      bedrock: { protocol: "acp", command: "npx claude", env: { SOURCE: "global" } },
    };
    const projectVariants = {
      bedrock: { protocol: "acp", command: "npx claude", env: { SOURCE: "project" } },
      vertex: { protocol: "acp", command: "npx claude", env: { SOURCE: "project" } },
    };
    // Explicit bedrock — project env wins.
    const result = resolveVariant(
      "claude",
      "bedrock",
      config(globalVariants),
      projectConfig(projectVariants),
    );
    expect(result.name).toBe("bedrock");
    expect(result.env).toEqual({ SOURCE: "project" });
  });
});

// ── Back-compat ────────────────────────────────────────────────

describe("resolveVariant: back-compat (no variants)", () => {
  test("returns name=null when agent has no variants AND no explicit request", () => {
    const result = resolveVariant("claude", undefined, undefined, undefined);
    expect(result.name).toBeNull();
    expect(result.protocol).toBe("acp");
    expect(result.command).toBeUndefined();
  });

  test("returns name=null when config exists but agent has no variants field", () => {
    const cfg: Config = { agents: { claude: { name: "claude" } } } as unknown as Config;
    const result = resolveVariant("claude", undefined, cfg, undefined);
    expect(result.name).toBeNull();
  });
});

// ── Error cases ────────────────────────────────────────────────

describe("resolveVariant: errors", () => {
  test("unknown explicit variant → clear error listing available variants", () => {
    const variants = {
      anthropic: { protocol: "acp", command: "npx claude-agent-acp" },
      bedrock: { protocol: "acp", command: "npx claude-agent-acp" },
    };
    expect(() => resolveVariant("claude", "vertex", config(variants), undefined)).toThrow(
      VariantResolverError,
    );

    // Message format lock (users grep error output; don't drift silently)
    try {
      resolveVariant("claude", "vertex", config(variants), undefined);
      throw new Error("expected throw");
    } catch (err: unknown) {
      if (!(err instanceof VariantResolverError)) throw err;
      expect(err.code).toBe("UNKNOWN_VARIANT");
      expect(err.message).toContain('variant "vertex" not defined for "claude"');
      expect(err.message).toContain("anthropic");
      expect(err.message).toContain("bedrock");
    }
  });

  test("explicit variant on agent with no variants → AGENT_HAS_NO_VARIANTS", () => {
    try {
      resolveVariant("claude", "bedrock", undefined, undefined);
      throw new Error("expected throw");
    } catch (err: unknown) {
      if (!(err instanceof VariantResolverError)) throw err;
      expect(err.code).toBe("AGENT_HAS_NO_VARIANTS");
      expect(err.message).toContain('Agent "claude" has no variants defined');
    }
  });

  test("project default_variant pointing at missing name → DEFAULT_VARIANT_NOT_FOUND", () => {
    const variants = {
      anthropic: { protocol: "acp", command: "npx claude-agent-acp" },
    };
    try {
      resolveVariant("claude", undefined, config(variants), projectConfig(variants, "nonexistent"));
      throw new Error("expected throw");
    } catch (err: unknown) {
      if (!(err instanceof VariantResolverError)) throw err;
      expect(err.code).toBe("DEFAULT_VARIANT_NOT_FOUND");
      expect(err.message).toContain('"nonexistent"');
      expect(err.message).toContain("project config");
    }
  });

  test("global default_variant pointing at missing name → DEFAULT_VARIANT_NOT_FOUND", () => {
    const variants = {
      anthropic: { protocol: "acp", command: "npx claude-agent-acp" },
    };
    try {
      resolveVariant("claude", undefined, config(variants, "nonexistent"), undefined);
      throw new Error("expected throw");
    } catch (err: unknown) {
      if (!(err instanceof VariantResolverError)) throw err;
      expect(err.code).toBe("DEFAULT_VARIANT_NOT_FOUND");
      expect(err.message).toContain("global config");
    }
  });
});

// ── Returned fields ────────────────────────────────────────────

describe("resolveVariant: ResolvedVariant shape", () => {
  test("returns command/args/env/permission_policy fields", () => {
    const variants = {
      bedrock: {
        protocol: "acp",
        command: "npx claude-agent-acp",
        args: ["--model", "sonnet"],
        env: { CLAUDE_CODE_USE_BEDROCK: "1", AWS_REGION: "us-east-1" },
        permission_policy: "auto-approve",
      },
    };
    const result = resolveVariant("claude", "bedrock", config(variants), undefined);
    expect(result.name).toBe("bedrock");
    expect(result.protocol).toBe("acp");
    expect(result.command).toBe("npx claude-agent-acp");
    expect(result.args).toEqual(["--model", "sonnet"]);
    expect(result.env).toEqual({
      CLAUDE_CODE_USE_BEDROCK: "1",
      AWS_REGION: "us-east-1",
    });
    expect(result.permission_policy).toBe("auto-approve");
  });
});

// ── Source tag ─────────────────────────────────────────────────

describe("resolveVariant: source attribution", () => {
  const variants = {
    anthropic: { protocol: "acp", command: "npx claude" },
    bedrock: { protocol: "acp", command: "npx claude" },
  };

  test("explicit CLI flag → source = 'cli-flag'", () => {
    const result = resolveVariant("claude", "bedrock", config(variants), undefined);
    expect(result.source).toBe("cli-flag");
  });

  test("project default_variant → source = 'project-default'", () => {
    const result = resolveVariant(
      "claude",
      undefined,
      config(variants),
      projectConfig(variants, "bedrock"),
    );
    expect(result.source).toBe("project-default");
  });

  test("global default_variant → source = 'global-default'", () => {
    const result = resolveVariant("claude", undefined, config(variants, "bedrock"), undefined);
    expect(result.source).toBe("global-default");
  });

  test("sole variant → source = 'sole-variant'", () => {
    const soleVariant = {
      anthropic: { protocol: "acp", command: "npx claude-agent-acp" },
    };
    const result = resolveVariant("claude", undefined, config(soleVariant), undefined);
    expect(result.source).toBe("sole-variant");
  });

  test("no variants → source = null (back-compat)", () => {
    const result = resolveVariant("claude", undefined, undefined, undefined);
    expect(result.source).toBeNull();
  });
});

// ── AM_VARIANTS gating ─────────────────────────────────────────

describe("isVariantsEnabled", () => {
  test("returns true when AM_VARIANTS=1", () => {
    expect(isVariantsEnabled({ AM_VARIANTS: "1" } as NodeJS.ProcessEnv)).toBe(true);
  });

  test("returns false when AM_VARIANTS unset or empty", () => {
    expect(isVariantsEnabled({} as NodeJS.ProcessEnv)).toBe(false);
    expect(isVariantsEnabled({ AM_VARIANTS: "" } as NodeJS.ProcessEnv)).toBe(false);
  });

  test("returns false for non-1 values (strict match)", () => {
    expect(isVariantsEnabled({ AM_VARIANTS: "true" } as NodeJS.ProcessEnv)).toBe(false);
    expect(isVariantsEnabled({ AM_VARIANTS: "yes" } as NodeJS.ProcessEnv)).toBe(false);
    expect(isVariantsEnabled({ AM_VARIANTS: "0" } as NodeJS.ProcessEnv)).toBe(false);
  });
});
