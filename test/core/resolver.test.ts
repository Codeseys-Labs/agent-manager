import { describe, expect, test } from "bun:test";
import {
  buildScopeManifest,
  isToolInScope,
  resolveActiveServers,
  resolveProfile,
  resolveServerTags,
} from "../../src/core/resolver";
import type { Config } from "../../src/core/schema";

/** Minimal server helper */
function srv(command: string, opts: { tags?: string[]; enabled?: boolean } = {}) {
  return {
    command,
    transport: "stdio" as const,
    enabled: opts.enabled ?? true,
    tags: opts.tags,
  };
}

const baseConfig: Config = {
  servers: {
    fetch: srv("uvx mcp-server-fetch", { tags: ["utils"] }),
    outlook: srv("aws-outlook-mcp", { tags: ["email", "work"] }),
    wiki: srv("amazon-wiki-mcp", { tags: ["wiki", "work"] }),
    disabled: srv("disabled-server", { tags: ["work"], enabled: false }),
  },
  skills: {
    "research-rabbithole": {
      path: "skills/research-rabbithole",
      description: "Deep research",
    },
    "admin-lint": {
      path: "skills/admin-lint",
      description: "Vault linting",
    },
  },
  profiles: {
    base: {
      description: "Always-on utilities",
      servers: ["fetch"],
      skills: ["admin-lint"],
      instructions: ["general"],
      env: { HOME: "/home/user" },
      adapters: { "claude-code": { permission_mode: "allowEdits" } },
    },
    work: {
      description: "Work profile",
      inherits: "base",
      servers: ["outlook"],
      server_tags: ["work"],
      skills: ["research-rabbithole"],
      instructions: ["typescript"],
      env: { AWS_PROFILE: "work-sso", HOME: "/home/work" },
      adapters: { cursor: { always_allow_read: true } },
    },
    minimal: {
      description: "No inheritance, no extras",
    },
  },
};

describe("resolveProfile", () => {
  test("resolves profile with no inheritance", () => {
    const resolved = resolveProfile("base", baseConfig);
    expect(resolved.name).toBe("base");
    expect(resolved.servers).toContain("fetch");
    expect(resolved.skills).toEqual(["admin-lint"]);
    expect(resolved.instructions).toEqual(["general"]);
    expect(resolved.env).toEqual({ HOME: "/home/user" });
  });

  test("resolves with single inheritance (union arrays)", () => {
    const resolved = resolveProfile("work", baseConfig);
    // Parent servers + child servers
    expect(resolved.servers).toContain("fetch");
    expect(resolved.servers).toContain("outlook");
    // Skills union
    expect(resolved.skills).toContain("admin-lint");
    expect(resolved.skills).toContain("research-rabbithole");
    // Instructions union
    expect(resolved.instructions).toContain("general");
    expect(resolved.instructions).toContain("typescript");
  });

  test("server_tags activates matching servers", () => {
    const resolved = resolveProfile("work", baseConfig);
    // outlook and wiki both have "work" tag
    expect(resolved.servers).toContain("outlook");
    expect(resolved.servers).toContain("wiki");
  });

  test("excludes disabled servers from tag activation", () => {
    const resolved = resolveProfile("work", baseConfig);
    // disabled server has "work" tag but enabled=false
    expect(resolved.servers).not.toContain("disabled");
  });

  test("deduplicates servers (explicit + tag)", () => {
    const resolved = resolveProfile("work", baseConfig);
    // outlook is both explicit and matched by "work" tag
    const outlookCount = resolved.servers.filter((s) => s === "outlook").length;
    expect(outlookCount).toBe(1);
  });

  test("throws on unknown profile", () => {
    expect(() => resolveProfile("nonexistent", baseConfig)).toThrow(
      'Unknown profile: "nonexistent"',
    );
  });

  test("throws on circular inheritance", () => {
    const circular: Config = {
      profiles: {
        a: { inherits: "b" },
        b: { inherits: "a" },
      },
    };
    expect(() => resolveProfile("a", circular)).toThrow("Circular inheritance detected");
  });

  test("unions server_tags from parent and child", () => {
    const config: Config = {
      servers: {
        s1: srv("s1", { tags: ["parent-tag"] }),
        s2: srv("s2", { tags: ["child-tag"] }),
      },
      profiles: {
        parent: { server_tags: ["parent-tag"] },
        child: { inherits: "parent", server_tags: ["child-tag"] },
      },
    };
    const resolved = resolveProfile("child", config);
    expect(resolved.servers).toContain("s1");
    expect(resolved.servers).toContain("s2");
  });

  test("child env overrides parent env for same key", () => {
    const resolved = resolveProfile("work", baseConfig);
    // child overrides HOME
    expect(resolved.env.HOME).toBe("/home/work");
    expect(resolved.env.AWS_PROFILE).toBe("work-sso");
  });

  test("resolves minimal profile with no fields", () => {
    const resolved = resolveProfile("minimal", baseConfig);
    expect(resolved.name).toBe("minimal");
    expect(resolved.servers).toEqual([]);
    expect(resolved.skills).toEqual([]);
    expect(resolved.agents).toEqual([]);
    expect(resolved.instructions).toEqual([]);
    expect(resolved.env).toEqual({});
  });

  test("resolves agents list from profile", () => {
    const config: Config = {
      agents: {
        "code-reviewer": {
          name: "code-reviewer",
          description: "Reviews code",
          prompt: "You are a code reviewer.",
        },
        "security-auditor": {
          name: "security-auditor",
          description: "Security checks",
          prompt: "You are a security expert.",
        },
      },
      profiles: {
        parent: {
          agents: ["code-reviewer"],
        },
        child: {
          inherits: "parent",
          agents: ["security-auditor"],
        },
      },
    };
    const resolved = resolveProfile("child", config);
    expect(resolved.agents).toContain("code-reviewer");
    expect(resolved.agents).toContain("security-auditor");
    expect(resolved.agents).toHaveLength(2);
  });

  test("deduplicates agents across inheritance", () => {
    const config: Config = {
      profiles: {
        parent: {
          agents: ["code-reviewer"],
        },
        child: {
          inherits: "parent",
          agents: ["code-reviewer", "security-auditor"],
        },
      },
    };
    const resolved = resolveProfile("child", config);
    const reviewerCount = resolved.agents.filter((a) => a === "code-reviewer").length;
    expect(reviewerCount).toBe(1);
    expect(resolved.agents).toHaveLength(2);
  });
});

describe("resolveServerTags", () => {
  test("returns matching servers", () => {
    const result = resolveServerTags(["email"], baseConfig);
    expect(result).toContain("outlook");
    expect(result).not.toContain("fetch");
  });

  test("returns empty for no matching tags", () => {
    const result = resolveServerTags(["nonexistent"], baseConfig);
    expect(result).toEqual([]);
  });

  test("returns empty for empty tags array", () => {
    const result = resolveServerTags([], baseConfig);
    expect(result).toEqual([]);
  });

  test("skips disabled servers", () => {
    const result = resolveServerTags(["work"], baseConfig);
    expect(result).not.toContain("disabled");
    expect(result).toContain("outlook");
    expect(result).toContain("wiki");
  });
});

describe("resolveActiveServers", () => {
  test("returns full Server objects for resolved profile", () => {
    const resolved = resolveProfile("base", baseConfig);
    const active = resolveActiveServers(resolved, baseConfig);
    expect(active).toHaveLength(1);
    expect(active[0].name).toBe("fetch");
    expect(active[0].server.command).toBe("uvx mcp-server-fetch");
  });

  test("skips unknown server names", () => {
    const resolved = {
      name: "test",
      servers: ["fetch", "nonexistent"],
      skills: [],
      agents: [],
      instructions: [],
      env: {},
      adapters: {},
    };
    const active = resolveActiveServers(resolved, baseConfig);
    expect(active).toHaveLength(1);
    expect(active[0].name).toBe("fetch");
  });

  test("returns multiple servers for work profile", () => {
    const resolved = resolveProfile("work", baseConfig);
    const active = resolveActiveServers(resolved, baseConfig);
    const names = active.map((a) => a.name);
    expect(names).toContain("fetch");
    expect(names).toContain("outlook");
    expect(names).toContain("wiki");
  });
});

// ── ADR-0055: runtime access Scope resolution + composition ──────────────────

describe("resolveProfile — scope (ADR-0055)", () => {
  const cfg: Config = {
    profiles: {
      base: {},
      scoped: { scope: { tool_groups: ["core", "wiki"], deny_tools: ["am_apply"] } },
      child: { inherits: "scoped", scope: { allow_tools: ["am_registry_search"] } },
    },
  };

  test("a profile WITHOUT scope resolves to scope:undefined (global ceiling)", () => {
    expect(resolveProfile("base", cfg).scope).toBeUndefined();
  });

  test("a profile WITH scope surfaces toolGroups + deny", () => {
    const s = resolveProfile("scoped", cfg).scope;
    expect(s).toBeDefined();
    expect(s?.toolGroups).toEqual(["core", "wiki"]);
    expect(s?.denyTools).toEqual(["am_apply"]);
    expect(s?.allowTools).toEqual([]);
  });

  test("inherited scope: child-wins tool_groups absent → parent's kept; allow unions", () => {
    const s = resolveProfile("child", cfg).scope;
    expect(s).toBeDefined();
    // child sets no tool_groups → parent's ["core","wiki"] survives.
    expect(s?.toolGroups).toEqual(["core", "wiki"]);
    // allow unions parent(none)+child; deny inherited from parent.
    expect(s?.allowTools).toEqual(["am_registry_search"]);
    expect(s?.denyTools).toEqual(["am_apply"]);
  });
});

describe("isToolInScope — composition (ADR-0055)", () => {
  const CEILING = ["core", "registry", "a2a", "wiki", "session", "acp"] as const;

  test("no scope → visible iff group in ceiling", () => {
    expect(isToolInScope("am_status", "core", CEILING, undefined)).toBe(true);
    expect(isToolInScope("am_status", "core", ["registry"], undefined)).toBe(false);
  });

  test("ceiling is absolute — scope can never widen beyond it", () => {
    const scope = { toolGroups: ["registry" as const], allowTools: ["am_status"], denyTools: [] };
    // am_status is 'core'; ceiling here excludes 'core' → even an explicit allow can't expose it.
    expect(isToolInScope("am_status", "core", ["registry"], scope)).toBe(false);
  });

  test("tool_groups narrows within the ceiling", () => {
    const scope = { toolGroups: ["core" as const], allowTools: [], denyTools: [] };
    expect(isToolInScope("am_status", "core", CEILING, scope)).toBe(true);
    expect(isToolInScope("am_wiki_search", "wiki", CEILING, scope)).toBe(false);
  });

  test("deny_tools wins over group inclusion", () => {
    const scope = { toolGroups: ["core" as const], allowTools: [], denyTools: ["am_apply"] };
    expect(isToolInScope("am_apply", "core", CEILING, scope)).toBe(false);
    expect(isToolInScope("am_status", "core", CEILING, scope)).toBe(true);
  });

  test("allow_tools re-includes a tool whose group was narrowed out (within ceiling)", () => {
    const scope = { toolGroups: ["core" as const], allowTools: ["am_wiki_search"], denyTools: [] };
    // wiki group is narrowed out, but the explicit allow + wiki ∈ ceiling → visible.
    expect(isToolInScope("am_wiki_search", "wiki", CEILING, scope)).toBe(true);
  });

  test("deny beats allow", () => {
    const scope = { toolGroups: undefined, allowTools: ["am_apply"], denyTools: ["am_apply"] };
    expect(isToolInScope("am_apply", "core", CEILING, scope)).toBe(false);
  });
});

describe("resolveProfile scope — inheritance edge cases (K-CRIT verify follow-up)", () => {
  test("child tool_groups:[] (restrictive) OVERRIDES parent groups, not confused with undefined", () => {
    const cfg: Config = {
      profiles: {
        parent: { scope: { tool_groups: ["core", "wiki"] } },
        child: { inherits: "parent", scope: { tool_groups: [] } },
      },
    };
    const s = resolveProfile("child", cfg).scope;
    expect(s?.toolGroups).toEqual([]); // empty wins over parent's [core,wiki]
  });

  test("descendant allow CANNOT re-enable an ancestor's deny (deny-wins across chain)", () => {
    const cfg: Config = {
      profiles: {
        parent: { scope: { deny_tools: ["am_apply"] } },
        child: { inherits: "parent", scope: { allow_tools: ["am_apply"] } },
      },
    };
    const s = resolveProfile("child", cfg).scope;
    // both accumulate; isToolInScope checks deny before allow → still denied.
    expect(s?.denyTools).toContain("am_apply");
    expect(s?.allowTools).toContain("am_apply");
    expect(isToolInScope("am_apply", "core", ["core"], s)).toBe(false);
  });
});

describe("buildScopeManifest (ADR-0055 Decision 6 — auditability)", () => {
  const catalog = [
    { name: "am_status", group: "core" as const },
    { name: "am_apply", group: "core" as const },
    { name: "am_registry_search", group: "registry" as const },
    { name: "am_wiki_search", group: "wiki" as const },
  ];
  const CEILING = ["core", "registry", "wiki"] as const;

  test("no scope → all ceiling tools effective, scoped=false", () => {
    const m = buildScopeManifest("plain", catalog, CEILING, undefined);
    expect(m.scoped).toBe(false);
    expect(m.effectiveTools).toEqual([
      "am_apply",
      "am_registry_search",
      "am_status",
      "am_wiki_search",
    ]);
    expect(m.excludedTools).toEqual([]);
  });

  test("scope narrows + deny → manifest matches isToolInScope, sorted", () => {
    const m = buildScopeManifest("locked", catalog, CEILING, {
      toolGroups: ["core"],
      allowTools: [],
      denyTools: ["am_apply"],
    });
    expect(m.scoped).toBe(true);
    expect(m.toolGroups).toEqual(["core"]);
    expect(m.effectiveTools).toEqual(["am_status"]); // core minus denied am_apply
    expect(m.excludedTools).toEqual(["am_apply", "am_registry_search", "am_wiki_search"]);
  });

  test("ceiling reported verbatim; a tool outside the ceiling is always excluded", () => {
    const m = buildScopeManifest("p", catalog, ["core"], {
      toolGroups: ["core", "registry"],
      allowTools: ["am_registry_search"],
      denyTools: [],
    });
    // registry not in ceiling → am_registry_search excluded despite allow + group.
    expect(m.ceiling).toEqual(["core"]);
    expect(m.effectiveTools).not.toContain("am_registry_search");
    expect(m.excludedTools).toContain("am_registry_search");
  });
});
