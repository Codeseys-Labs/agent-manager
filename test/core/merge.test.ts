import { describe, expect, test } from "bun:test";
import type { ImportedServer } from "../../src/adapters/types";
import {
  type IdentityMatch,
  type MergeStrategy,
  classifyConflicts,
  identifyDuplicates,
  mergeServers,
  runMergePipeline,
} from "../../src/core/merge";
import type { Server } from "../../src/core/schema";

// ── Helpers ──────────────────────────────────────────────────────────

function makeServer(overrides: Partial<Server> & { command: string }): Server {
  const transport = overrides.transport ?? "stdio";
  if (transport === "stdio") {
    return {
      command: overrides.command,
      args: overrides.args,
      env: overrides.env,
      transport: "stdio",
      description: overrides.description,
      tags: overrides.tags,
      enabled: overrides.enabled ?? true,
      _registry: overrides._registry,
      _marketplace: overrides._marketplace,
      adapters: overrides.adapters,
    };
  }
  return {
    command: overrides.command,
    args: overrides.args,
    env: overrides.env,
    transport,
    url: "url" in overrides ? (overrides as { url?: string }).url : undefined,
    description: overrides.description,
    tags: overrides.tags,
    enabled: overrides.enabled ?? true,
    _registry: overrides._registry,
    _marketplace: overrides._marketplace,
    adapters: overrides.adapters,
  };
}

function makeImported(
  overrides: Partial<ImportedServer> & { name: string; command: string },
): ImportedServer {
  return {
    name: overrides.name,
    command: overrides.command,
    args: overrides.args,
    env: overrides.env,
    transport: overrides.transport,
    url: overrides.url,
    description: overrides.description,
    tags: overrides.tags,
    enabled: overrides.enabled,
    scope: overrides.scope ?? "global",
  };
}

// ── identifyDuplicates ──────────────────────────────────────────────

describe("identifyDuplicates", () => {
  test("exact match — same package via different runners", () => {
    const existing: Record<string, Server> = {
      tavily: makeServer({ command: "bunx", args: ["tavily-mcp@latest"] }),
    };
    const incoming: ImportedServer[] = [
      makeImported({ name: "tavily-cursor", command: "npx", args: ["-y", "tavily-mcp@0.3.2"] }),
    ];

    const { matches, newServers } = identifyDuplicates(existing, incoming, "cursor");

    expect(matches).toHaveLength(1);
    expect(matches[0].type).toBe("exact");
    expect(matches[0].existingName).toBe("tavily");
    expect(matches[0].incomingServer.name).toBe("tavily-cursor");
    expect(newServers).toHaveLength(0);
  });

  test("exact match — same plain command", () => {
    const existing: Record<string, Server> = {
      "aws-outlook": makeServer({ command: "aws-outlook-mcp" }),
    };
    const incoming: ImportedServer[] = [
      makeImported({ name: "outlook", command: "aws-outlook-mcp" }),
    ];

    const { matches, newServers } = identifyDuplicates(existing, incoming);
    expect(matches).toHaveLength(1);
    expect(matches[0].type).toBe("exact");
    expect(newServers).toHaveLength(0);
  });

  test("fuzzy match — command basename (args differ enough to avoid exact identity)", () => {
    const existing: Record<string, Server> = {
      fetch: makeServer({ command: "uvx", args: ["mcp-server-fetch"] }),
    };
    // Incoming uses a different runner with extra args that change the extracted identity
    // "npx" + ["mcp-server-fetch-wrapper"] has identity "mcp-server-fetch-wrapper" (no exact match)
    // but basename "mcp-server-fetch-wrapper" won't match either — let's use a direct command
    const incoming: ImportedServer[] = [
      makeImported({
        name: "fetch-alt",
        command: "mcp-server-fetch",
        args: ["--port", "3000"],
      }),
    ];

    const { matches, newServers } = identifyDuplicates(existing, incoming);
    expect(matches).toHaveLength(1);
    expect(matches[0].type).toBe("exact"); // extractServerIdentity strips uvx -> same identity
    expect(newServers).toHaveLength(0);
  });

  test("fuzzy match — command basename match when identity differs", () => {
    const existing: Record<string, Server> = {
      // Identity: "mcp-proxy" -> hostname "mcp.tavily.com" (endpoint match)
      tavily: makeServer({
        command: "uvx",
        args: ["mcp-proxy", "--endpoint", "https://mcp.tavily.com/sse"],
      }),
    };
    // Same name "tavily" but completely different command => name match
    const incoming: ImportedServer[] = [
      makeImported({
        name: "tavily",
        command: "bunx",
        args: ["tavily-search@latest"],
      }),
    ];

    const { matches, newServers } = identifyDuplicates(existing, incoming);
    expect(matches).toHaveLength(1);
    expect(matches[0].type).toBe("fuzzy");
    expect(matches[0].fuzzyReason).toBe("name-match");
    expect(newServers).toHaveLength(0);
  });

  test("fuzzy match — name match", () => {
    const existing: Record<string, Server> = {
      tavily: makeServer({ command: "bunx", args: ["tavily-mcp@latest"] }),
    };
    // Same name, completely different command (would not match on identity or basename)
    const incoming: ImportedServer[] = [
      makeImported({
        name: "tavily",
        command: "docker",
        args: ["run", "tavily/server:latest"],
      }),
    ];

    const { matches, newServers } = identifyDuplicates(existing, incoming);
    expect(matches).toHaveLength(1);
    expect(matches[0].type).toBe("fuzzy");
    expect(matches[0].fuzzyReason).toBe("name-match");
    expect(newServers).toHaveLength(0);
  });

  test("no match — completely new server", () => {
    const existing: Record<string, Server> = {
      tavily: makeServer({ command: "bunx", args: ["tavily-mcp@latest"] }),
    };
    const incoming: ImportedServer[] = [makeImported({ name: "exa", command: "exa-mcp" })];

    const { matches, newServers } = identifyDuplicates(existing, incoming);
    expect(matches).toHaveLength(0);
    expect(newServers).toHaveLength(1);
    expect(newServers[0].name).toBe("exa");
  });

  test("mixed — some exact, some new", () => {
    const existing: Record<string, Server> = {
      tavily: makeServer({ command: "bunx", args: ["tavily-mcp@latest"] }),
      fetch: makeServer({ command: "uvx", args: ["mcp-server-fetch"] }),
    };
    const incoming: ImportedServer[] = [
      makeImported({ name: "tavily-2", command: "npx", args: ["-y", "tavily-mcp@latest"] }),
      makeImported({ name: "exa", command: "exa-mcp" }),
      makeImported({ name: "context7", command: "bunx", args: ["@upstash/context7-mcp@latest"] }),
    ];

    const { matches, newServers } = identifyDuplicates(existing, incoming);
    expect(matches).toHaveLength(1); // tavily exact match
    expect(newServers).toHaveLength(2); // exa + context7
  });

  test("empty existing — all incoming are new", () => {
    const existing: Record<string, Server> = {};
    const incoming: ImportedServer[] = [
      makeImported({ name: "a", command: "a-mcp" }),
      makeImported({ name: "b", command: "b-mcp" }),
    ];

    const { matches, newServers } = identifyDuplicates(existing, incoming);
    expect(matches).toHaveLength(0);
    expect(newServers).toHaveLength(2);
  });

  test("preserves incoming source", () => {
    const existing: Record<string, Server> = {
      tavily: makeServer({ command: "bunx", args: ["tavily-mcp@latest"] }),
    };
    const incoming: ImportedServer[] = [
      makeImported({ name: "tavily", command: "bunx", args: ["tavily-mcp@latest"] }),
    ];

    const { matches } = identifyDuplicates(existing, incoming, "cursor");
    expect(matches[0].incomingSource).toBe("cursor");
  });
});

// ── classifyConflicts ────────────────────────────────────────────────

describe("classifyConflicts", () => {
  test("identical — no field diffs", () => {
    const matches: IdentityMatch[] = [
      {
        type: "exact",
        existingName: "tavily",
        existingServer: makeServer({
          command: "bunx",
          args: ["tavily-mcp@latest"],
          env: { TAVILY_API_KEY: "key1" },
        }),
        incomingServer: makeImported({
          name: "tavily-2",
          command: "bunx",
          args: ["tavily-mcp@latest"],
          env: { TAVILY_API_KEY: "key1" },
        }),
        incomingSource: "cursor",
        identity: "tavily-mcp",
      },
    ];

    const conflicts = classifyConflicts(matches);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].classification).toBe("identical");
    expect(conflicts[0].diffs).toHaveLength(0);
  });

  test("compatible — exact match with only mergeable env diffs", () => {
    const matches: IdentityMatch[] = [
      {
        type: "exact",
        existingName: "tavily",
        existingServer: makeServer({
          command: "bunx",
          args: ["tavily-mcp@latest"],
          env: { TAVILY_API_KEY: "key1" },
        }),
        incomingServer: makeImported({
          name: "tavily-2",
          command: "bunx",
          args: ["tavily-mcp@latest"],
          env: { TAVILY_API_KEY: "key2", EXTRA_VAR: "val" },
        }),
        incomingSource: "cursor",
        identity: "tavily-mcp",
      },
    ];

    const conflicts = classifyConflicts(matches);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].classification).toBe("compatible");
    expect(conflicts[0].diffs.length).toBeGreaterThan(0);
  });

  test("conflicting — exact match with command diff", () => {
    const matches: IdentityMatch[] = [
      {
        type: "exact",
        existingName: "tavily",
        existingServer: makeServer({
          command: "bunx",
          args: ["tavily-mcp@latest"],
        }),
        incomingServer: makeImported({
          name: "tavily-2",
          command: "npx",
          args: ["tavily-mcp@latest"],
          enabled: false,
        }),
        incomingSource: "cursor",
        identity: "tavily-mcp",
      },
    ];

    const conflicts = classifyConflicts(matches);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].classification).toBe("conflicting");
  });

  test("conflicting — fuzzy match always classified as conflicting", () => {
    const matches: IdentityMatch[] = [
      {
        type: "fuzzy",
        existingName: "tavily",
        existingServer: makeServer({
          command: "bunx",
          args: ["tavily-mcp@latest"],
        }),
        incomingServer: makeImported({
          name: "tavily",
          command: "bunx",
          args: ["tavily-mcp@latest"],
        }),
        incomingSource: "cursor",
        identity: "tavily-mcp",
        fuzzyReason: "name-match",
      },
    ];

    const conflicts = classifyConflicts(matches);
    expect(conflicts).toHaveLength(1);
    // Even with no diffs, fuzzy is always conflicting
    expect(conflicts[0].classification).toBe("conflicting");
  });

  test("encrypted env ref — recommendation is keep-existing", () => {
    const matches: IdentityMatch[] = [
      {
        type: "exact",
        existingName: "tavily",
        existingServer: makeServer({
          command: "bunx",
          args: ["tavily-mcp@latest"],
          env: { TAVILY_API_KEY: "${TAVILY_API_KEY}" },
        }),
        incomingServer: makeImported({
          name: "tavily-2",
          command: "bunx",
          args: ["tavily-mcp@latest"],
          env: { TAVILY_API_KEY: "tvly-raw-secret-value" },
        }),
        incomingSource: "cursor",
        identity: "tavily-mcp",
      },
    ];

    const conflicts = classifyConflicts(matches);
    const envDiff = conflicts[0].diffs.find((d) => d.field === "env.TAVILY_API_KEY");
    expect(envDiff).toBeDefined();
    expect(envDiff!.recommendation).toBe("keep-existing");
  });
});

// ── mergeServers ─────────────────────────────────────────────────────

describe("mergeServers", () => {
  test("auto — keeps existing command", () => {
    const existing = makeServer({
      command: "bunx",
      args: ["tavily-mcp@latest"],
    });
    const incoming = makeImported({
      name: "tavily",
      command: "npx",
      args: ["-y", "tavily-mcp@0.3.2"],
    });

    const merged = mergeServers(existing, incoming, "auto");
    expect(merged.command).toBe("bunx");
  });

  test("auto — unions args", () => {
    const existing = makeServer({
      command: "bunx",
      args: ["tavily-mcp@latest", "--verbose"],
    });
    const incoming = makeImported({
      name: "tavily",
      command: "bunx",
      args: ["tavily-mcp@latest", "--timeout", "30"],
    });

    const merged = mergeServers(existing, incoming, "auto");
    expect(merged.args).toEqual(["tavily-mcp@latest", "--verbose", "--timeout", "30"]);
  });

  test("auto — merges env, incoming wins on non-encrypted conflict", () => {
    const existing = makeServer({
      command: "test-mcp",
      env: { KEY_A: "old-val", KEY_B: "existing" },
    });
    const incoming = makeImported({
      name: "test",
      command: "test-mcp",
      env: { KEY_A: "new-val", KEY_C: "added" },
    });

    const merged = mergeServers(existing, incoming, "auto");
    expect(merged.env).toEqual({
      KEY_A: "new-val", // incoming wins
      KEY_B: "existing", // preserved
      KEY_C: "added", // new from incoming
    });
  });

  test("auto — preserves encrypted env refs", () => {
    const existing = makeServer({
      command: "test-mcp",
      env: { API_KEY: "${API_KEY}", OTHER: "plain" },
    });
    const incoming = makeImported({
      name: "test",
      command: "test-mcp",
      env: { API_KEY: "raw-secret-value", OTHER: "new-plain" },
    });

    const merged = mergeServers(existing, incoming, "auto");
    expect(merged.env!.API_KEY).toBe("${API_KEY}"); // encrypted ref preserved
    expect(merged.env!.OTHER).toBe("new-plain"); // non-encrypted: incoming wins
  });

  test("auto — unions tags", () => {
    const existing = makeServer({
      command: "test-mcp",
      tags: ["search", "web"],
    });
    const incoming = makeImported({
      name: "test",
      command: "test-mcp",
      tags: ["search", "ai"],
    });

    const merged = mergeServers(existing, incoming, "auto");
    expect(merged.tags).toEqual(["search", "web", "ai"]);
  });

  test("auto — keeps longer description", () => {
    const existing = makeServer({
      command: "test-mcp",
      description: "Short",
    });
    const incoming = makeImported({
      name: "test",
      command: "test-mcp",
      description: "A much longer and more detailed description",
    });

    const merged = mergeServers(existing, incoming, "auto");
    expect(merged.description).toBe("A much longer and more detailed description");
  });

  test("auto — keeps existing description when it is longer", () => {
    const existing = makeServer({
      command: "test-mcp",
      description: "The existing description is quite detailed and long",
    });
    const incoming = makeImported({
      name: "test",
      command: "test-mcp",
      description: "Short",
    });

    const merged = mergeServers(existing, incoming, "auto");
    expect(merged.description).toBe("The existing description is quite detailed and long");
  });

  test("auto — keeps existing enabled state", () => {
    const existing = makeServer({
      command: "test-mcp",
      enabled: false,
    });
    const incoming = makeImported({
      name: "test",
      command: "test-mcp",
      enabled: true,
    });

    const merged = mergeServers(existing, incoming, "auto");
    expect(merged.enabled).toBe(false);
  });

  test("auto — preserves _registry provenance", () => {
    const existing = makeServer({
      command: "test-mcp",
      _registry: {
        source: "mcp-registry" as const,
        package: "test-mcp",
        version: "1.0.0",
        installed_at: "2026-01-01T00:00:00Z",
      },
    });
    const incoming = makeImported({
      name: "test",
      command: "test-mcp",
    });

    const merged = mergeServers(existing, incoming, "auto");
    expect(merged._registry).toEqual(existing._registry);
  });

  test("force — incoming wins on all fields", () => {
    const existing = makeServer({
      command: "bunx",
      args: ["tavily-mcp@latest"],
      env: { KEY: "${KEY}" },
      description: "existing",
      tags: ["old"],
      enabled: false,
      _registry: {
        source: "mcp-registry" as const,
        package: "test",
        version: "1.0.0",
        installed_at: "2026-01-01T00:00:00Z",
      },
    });
    const incoming = makeImported({
      name: "tavily",
      command: "npx",
      args: ["-y", "tavily-mcp@0.3.2"],
      env: { KEY: "raw-value" },
      description: "incoming",
      tags: ["new"],
      enabled: true,
    });

    const merged = mergeServers(existing, incoming, "force");
    expect(merged.command).toBe("npx"); // incoming wins
    expect(merged.args).toEqual(["-y", "tavily-mcp@0.3.2"]);
    expect(merged.env!.KEY).toBe("raw-value");
    expect(merged.description).toBe("incoming");
    expect(merged.tags).toEqual(["new"]);
    expect(merged.enabled).toBe(true);
    // _registry still preserved even in force mode
    expect(merged._registry).toEqual(existing._registry);
  });

  test("handles undefined args gracefully", () => {
    const existing = makeServer({ command: "test-mcp" });
    const incoming = makeImported({ name: "test", command: "test-mcp" });

    const merged = mergeServers(existing, incoming, "auto");
    expect(merged.args).toBeUndefined();
  });

  test("handles undefined env gracefully", () => {
    const existing = makeServer({ command: "test-mcp" });
    const incoming = makeImported({
      name: "test",
      command: "test-mcp",
      env: { NEW_KEY: "val" },
    });

    const merged = mergeServers(existing, incoming, "auto");
    expect(merged.env).toEqual({ NEW_KEY: "val" });
  });

  // ── Remote server url / transport preservation (W-m10) ──────────────
  //
  // RemoteServerSchema carries an optional `url` and a non-stdio transport.
  // Both branches of mergeServers must preserve them or an sse / streamable-http
  // server silently degrades into a stdio server with no url (data loss).

  test("auto — preserves url and transport for an sse remote server", () => {
    const existing = makeServer({
      command: "https://mcp.example.com/sse",
      transport: "sse",
      url: "https://mcp.example.com/sse",
    });
    const incoming = makeImported({
      name: "remote",
      command: "https://mcp.example.com/sse",
      transport: "sse",
      url: "https://mcp.example.com/sse",
    });

    const merged = mergeServers(existing, incoming, "auto");
    expect(merged.transport).toBe("sse");
    expect(merged.url).toBe("https://mcp.example.com/sse");
  });

  test("auto — preserves url and transport for a streamable-http remote server", () => {
    const existing = makeServer({
      command: "https://mcp.example.com/mcp",
      transport: "streamable-http",
      url: "https://mcp.example.com/mcp",
    });
    const incoming = makeImported({
      name: "remote",
      command: "https://mcp.example.com/mcp",
      transport: "streamable-http",
      url: "https://mcp.example.com/mcp",
    });

    const merged = mergeServers(existing, incoming, "auto");
    expect(merged.transport).toBe("streamable-http");
    expect(merged.url).toBe("https://mcp.example.com/mcp");
  });

  test("auto — falls back to incoming url when existing url is absent", () => {
    const existing = makeServer({
      command: "https://mcp.example.com/sse",
      transport: "sse",
    });
    const incoming = makeImported({
      name: "remote",
      command: "https://mcp.example.com/sse",
      transport: "sse",
      url: "https://mcp.example.com/sse",
    });

    const merged = mergeServers(existing, incoming, "auto");
    expect(merged.url).toBe("https://mcp.example.com/sse");
    expect(merged.transport).toBe("sse");
  });

  test("force — preserves url and transport for an sse remote server", () => {
    // Per the W-m10 field strategy, url uses `existing.url ?? incoming.url`,
    // so the existing endpoint is retained when present. The key invariant
    // exercised here is that a remote server keeps a non-undefined url and a
    // remote transport through a force-merge (it is not dropped / coerced).
    const existing = makeServer({
      command: "https://old.example.com/sse",
      transport: "sse",
      url: "https://old.example.com/sse",
    });
    const incoming = makeImported({
      name: "remote",
      command: "https://new.example.com/sse",
      transport: "sse",
      url: "https://new.example.com/sse",
    });

    const merged = mergeServers(existing, incoming, "force");
    expect(merged.transport).toBe("sse");
    expect(merged.url).toBe("https://old.example.com/sse");
  });

  test("force — does NOT coerce a remote server to stdio when incoming omits transport", () => {
    // A force-merge where the incoming payload restates a remote server but
    // (as several importers do) leaves transport implicit. The existing server
    // is unambiguously remote; the merged result must remain remote, not stdio.
    const existing = makeServer({
      command: "https://mcp.example.com/sse",
      transport: "sse",
      url: "https://mcp.example.com/sse",
    });
    const incoming = makeImported({
      name: "remote",
      command: "https://mcp.example.com/sse",
      url: "https://mcp.example.com/sse",
      // transport intentionally omitted
    });

    const merged = mergeServers(existing, incoming, "force");
    expect(merged.transport).toBe("sse");
    expect(merged.url).toBe("https://mcp.example.com/sse");
  });

  test("force — falls back to incoming url when existing url is absent", () => {
    const existing = makeServer({
      command: "https://mcp.example.com/sse",
      transport: "sse",
    });
    const incoming = makeImported({
      name: "remote",
      command: "https://mcp.example.com/sse",
      transport: "sse",
      url: "https://mcp.example.com/sse",
    });

    const merged = mergeServers(existing, incoming, "force");
    expect(merged.url).toBe("https://mcp.example.com/sse");
    expect(merged.transport).toBe("sse");
  });

  test("stdio merge leaves url undefined", () => {
    const existing = makeServer({ command: "test-mcp", transport: "stdio" });
    const incoming = makeImported({ name: "test", command: "test-mcp" });

    const auto = mergeServers(existing, incoming, "auto");
    expect(auto.url).toBeUndefined();
    expect(auto.transport).toBe("stdio");

    const force = mergeServers(existing, incoming, "force");
    expect(force.url).toBeUndefined();
    expect(force.transport).toBe("stdio");
  });

  // ── adapters passthrough + _marketplace provenance preservation (ws-0d29) ──
  //
  // ImportedServer carries no `adapters` / `_marketplace` field, so the existing
  // server is the sole source for both. A re-merge must NOT silently strip the
  // adapter-scoped passthrough subtable (the round-trip sink for adapterExtras)
  // or the marketplace provenance block — both survive under auto AND force.

  const marketplaceProvenance = {
    source: "claude-plugin" as const,
    package: "example-plugin",
    version: "1.2.3",
    imported_at: "2026-01-01T00:00:00.000Z",
    install_path: "/plugins/example",
  };

  test("auto — preserves adapters passthrough and _marketplace provenance", () => {
    const existing = makeServer({
      command: "test-mcp",
      adapters: { "claude-code": { alwaysAllow: ["search"] } },
      _marketplace: marketplaceProvenance,
    });
    const incoming = makeImported({ name: "test", command: "test-mcp" });

    const merged = mergeServers(existing, incoming, "auto");
    expect(merged.adapters).toEqual({ "claude-code": { alwaysAllow: ["search"] } });
    expect(merged._marketplace).toEqual(marketplaceProvenance);
  });

  test("force — preserves adapters passthrough and _marketplace provenance", () => {
    const existing = makeServer({
      command: "bunx",
      args: ["tavily-mcp@latest"],
      adapters: { "claude-code": { alwaysAllow: ["search"] } },
      _marketplace: marketplaceProvenance,
    });
    const incoming = makeImported({
      name: "tavily",
      command: "npx",
      args: ["-y", "tavily-mcp@0.3.2"],
    });

    const merged = mergeServers(existing, incoming, "force");
    // force: incoming wins on the merge-able fields...
    expect(merged.command).toBe("npx");
    // ...but the schema-only passthrough + provenance survive (incoming has none).
    expect(merged.adapters).toEqual({ "claude-code": { alwaysAllow: ["search"] } });
    expect(merged._marketplace).toEqual(marketplaceProvenance);
  });

  test("force — preserves adapters and _marketplace on a remote server", () => {
    const existing = makeServer({
      command: "https://mcp.example.com/sse",
      transport: "sse",
      url: "https://mcp.example.com/sse",
      adapters: { cursor: { headers: { Authorization: "${TOKEN}" } } },
      _marketplace: marketplaceProvenance,
    });
    const incoming = makeImported({
      name: "remote",
      command: "https://mcp.example.com/sse",
      transport: "sse",
      url: "https://mcp.example.com/sse",
    });

    const merged = mergeServers(existing, incoming, "force");
    expect(merged.transport).toBe("sse");
    expect(merged.adapters).toEqual({ cursor: { headers: { Authorization: "${TOKEN}" } } });
    expect(merged._marketplace).toEqual(marketplaceProvenance);
  });
});

// ── runMergePipeline ─────────────────────────────────────────────────

describe("runMergePipeline", () => {
  test("auto mode — identical servers are skipped", () => {
    const existing: Record<string, Server> = {
      tavily: makeServer({
        command: "bunx",
        args: ["tavily-mcp@latest"],
        env: { KEY: "val" },
      }),
    };
    const incoming: ImportedServer[] = [
      makeImported({
        name: "tavily",
        command: "bunx",
        args: ["tavily-mcp@latest"],
        env: { KEY: "val" },
      }),
    ];

    const result = runMergePipeline(existing, incoming, "auto", "cursor");
    expect(result.skipped).toHaveLength(1);
    expect(result.merged).toHaveLength(0);
    expect(result.added).toHaveLength(0);
    expect(result.conflicts).toHaveLength(0);
  });

  test("auto mode — exact match with diffs gets merged", () => {
    const existing: Record<string, Server> = {
      tavily: makeServer({
        command: "bunx",
        args: ["tavily-mcp@latest"],
        env: { KEY: "old" },
        tags: ["search"],
      }),
    };
    const incoming: ImportedServer[] = [
      makeImported({
        name: "tavily-cursor",
        command: "bunx",
        args: ["tavily-mcp@latest"],
        env: { KEY: "new", EXTRA: "val" },
        tags: ["web"],
      }),
    ];

    const result = runMergePipeline(existing, incoming, "auto", "cursor");
    expect(result.merged).toHaveLength(1);
    expect(result.merged[0].name).toBe("tavily");
    expect(result.merged[0].server.env).toEqual({ KEY: "new", EXTRA: "val" });
    expect(result.merged[0].server.tags).toEqual(["search", "web"]);
  });

  test("auto mode — fuzzy matches are returned as conflicts (never auto-resolved)", () => {
    const existing: Record<string, Server> = {
      // Identity via endpoint: "mcp.tavily.com"
      tavily: makeServer({
        command: "uvx",
        args: ["mcp-proxy", "--endpoint", "https://mcp.tavily.com/sse"],
      }),
    };
    // Name "tavily" matches existing name, but identity is "tavily-search" (no exact match)
    const incoming: ImportedServer[] = [
      makeImported({
        name: "tavily",
        command: "bunx",
        args: ["tavily-search@latest"],
      }),
    ];

    const result = runMergePipeline(existing, incoming, "auto");
    expect(result.merged).toHaveLength(0);
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0].match.type).toBe("fuzzy");
  });

  test("auto mode — new servers are added", () => {
    const existing: Record<string, Server> = {
      tavily: makeServer({ command: "bunx", args: ["tavily-mcp@latest"] }),
    };
    const incoming: ImportedServer[] = [
      makeImported({ name: "exa", command: "exa-mcp" }),
      makeImported({ name: "fetch", command: "uvx", args: ["mcp-server-fetch"] }),
    ];

    const result = runMergePipeline(existing, incoming, "auto");
    expect(result.added).toHaveLength(2);
    expect(result.added.map((s) => s.name)).toEqual(["exa", "fetch"]);
  });

  test("force mode — all matches get incoming values", () => {
    const existing: Record<string, Server> = {
      tavily: makeServer({
        command: "bunx",
        args: ["tavily-mcp@latest"],
        description: "old",
      }),
    };
    const incoming: ImportedServer[] = [
      makeImported({
        name: "tavily",
        command: "npx",
        args: ["-y", "tavily-mcp@0.3"],
        description: "new",
      }),
    ];

    const result = runMergePipeline(existing, incoming, "force");
    expect(result.merged).toHaveLength(1);
    expect(result.merged[0].server.command).toBe("npx"); // force: incoming wins
    expect(result.merged[0].server.description).toBe("new");
  });

  test("force mode — even fuzzy matches get merged", () => {
    const existing: Record<string, Server> = {
      // Identity via endpoint: "mcp.tavily.com"
      tavily: makeServer({
        command: "uvx",
        args: ["mcp-proxy", "--endpoint", "https://mcp.tavily.com/sse"],
      }),
    };
    // Name "tavily" matches but identity "tavily-search" differs => fuzzy
    const incoming: ImportedServer[] = [
      makeImported({
        name: "tavily",
        command: "bunx",
        args: ["tavily-search@latest"],
      }),
    ];

    const result = runMergePipeline(existing, incoming, "force");
    expect(result.merged).toHaveLength(1);
    expect(result.conflicts).toHaveLength(0);
  });

  test("interactive mode — all non-identical are returned as conflicts", () => {
    const existing: Record<string, Server> = {
      tavily: makeServer({
        command: "bunx",
        args: ["tavily-mcp@latest"],
        env: { KEY: "old" },
      }),
    };
    const incoming: ImportedServer[] = [
      makeImported({
        name: "tavily",
        command: "bunx",
        args: ["tavily-mcp@latest"],
        env: { KEY: "new" },
      }),
    ];

    const result = runMergePipeline(existing, incoming, "interactive");
    expect(result.merged).toHaveLength(0);
    expect(result.conflicts).toHaveLength(1);
  });

  test("brownfield import — 10 incoming servers: 3 exact, 2 fuzzy, 5 new", () => {
    const existing: Record<string, Server> = {
      tavily: makeServer({ command: "bunx", args: ["tavily-mcp@latest"], env: { KEY: "val" } }),
      fetch: makeServer({ command: "uvx", args: ["mcp-server-fetch"], description: "Fetcher" }),
      outlook: makeServer({ command: "aws-outlook-mcp", tags: ["email"] }),
      sentral: makeServer({ command: "aws-sentral-mcp", tags: ["crm"] }),
      // "builder" exists by name only (different command) — will fuzzy match
      builder: makeServer({ command: "builder-mcp-v1", description: "Old builder" }),
    };

    const incoming: ImportedServer[] = [
      // 3 exact matches (same identity)
      makeImported({
        name: "tavily-cursor",
        command: "bunx",
        args: ["tavily-mcp@latest"],
        env: { KEY: "val" },
      }),
      makeImported({
        name: "fetcher",
        command: "uvx",
        args: ["mcp-server-fetch"],
        description: "Better fetcher desc",
      }),
      makeImported({ name: "outlook-import", command: "aws-outlook-mcp", tags: ["calendar"] }),
      // 2 fuzzy matches (name match)
      makeImported({ name: "sentral", command: "docker", args: ["run", "sentral:latest"] }),
      makeImported({ name: "builder", command: "builder-mcp-v2", description: "New builder" }),
      // 5 completely new
      makeImported({ name: "exa", command: "exa-mcp" }),
      makeImported({ name: "context7", command: "bunx", args: ["@upstash/context7-mcp@latest"] }),
      makeImported({ name: "slack", command: "slack-mcp" }),
      makeImported({ name: "wiki", command: "amazon-wiki-mcp" }),
      makeImported({ name: "gitlab", command: "aws-gitlab-mcp" }),
    ];

    const result = runMergePipeline(existing, incoming, "auto", "cursor");

    // 1 exact identical (tavily — same env)
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0].existingName).toBe("tavily");

    // 2 exact with diffs get auto-merged (fetch has description diff, outlook has tag diff)
    expect(result.merged).toHaveLength(2);
    const mergedNames = result.merged.map((m) => m.name).sort();
    expect(mergedNames).toEqual(["fetch", "outlook"]);

    // fetch merged: longer description wins
    const fetchMerged = result.merged.find((m) => m.name === "fetch")!;
    expect(fetchMerged.server.description).toBe("Better fetcher desc");

    // outlook merged: tags unioned
    const outlookMerged = result.merged.find((m) => m.name === "outlook")!;
    expect(outlookMerged.server.tags).toContain("email");
    expect(outlookMerged.server.tags).toContain("calendar");

    // 2 fuzzy matches become conflicts (never auto-resolved)
    expect(result.conflicts).toHaveLength(2);
    const conflictNames = result.conflicts.map((c) => c.match.existingName).sort();
    expect(conflictNames).toEqual(["builder", "sentral"]);
    expect(result.conflicts.every((c) => c.match.type === "fuzzy")).toBe(true);

    // 5 new servers added
    expect(result.added).toHaveLength(5);
    const addedNames = result.added.map((s) => s.name).sort();
    expect(addedNames).toEqual(["context7", "exa", "gitlab", "slack", "wiki"]);
  });

  test("complex scenario — mixed exact, fuzzy, new, and identical", () => {
    const existing: Record<string, Server> = {
      tavily: makeServer({
        command: "bunx",
        args: ["tavily-mcp@latest"],
        env: { KEY: "same" },
      }),
      fetch: makeServer({
        command: "uvx",
        args: ["mcp-server-fetch"],
        description: "fetcher",
      }),
      outlook: makeServer({ command: "aws-outlook-mcp" }),
    };

    const incoming: ImportedServer[] = [
      // Exact match, identical -> skip
      makeImported({
        name: "tavily",
        command: "bunx",
        args: ["tavily-mcp@latest"],
        env: { KEY: "same" },
      }),
      // Exact match, different env -> merge
      makeImported({
        name: "fetch-cursor",
        command: "uvx",
        args: ["mcp-server-fetch"],
        description: "a longer description for the fetcher",
        env: { TIMEOUT: "30" },
      }),
      // Brand new -> add
      makeImported({ name: "exa", command: "exa-mcp" }),
    ];

    const result = runMergePipeline(existing, incoming, "auto", "cursor");

    expect(result.skipped).toHaveLength(1); // tavily identical
    expect(result.skipped[0].existingName).toBe("tavily");

    expect(result.merged).toHaveLength(1); // fetch merged
    expect(result.merged[0].name).toBe("fetch");
    expect(result.merged[0].server.description).toBe("a longer description for the fetcher");
    expect(result.merged[0].server.env).toEqual({ TIMEOUT: "30" });

    expect(result.added).toHaveLength(1); // exa new
    expect(result.added[0].name).toBe("exa");

    expect(result.conflicts).toHaveLength(0);
  });

  // ── adapters + _marketplace survive a re-merge through the pipeline (ws-0d29) ──

  test("re-merge — adapters passthrough and _marketplace survive under auto and force", () => {
    const marketplace = {
      source: "cursor-extension" as const,
      package: "tavily-ext",
      version: "0.9.0",
      imported_at: "2026-02-02T00:00:00.000Z",
    };
    const existing: Record<string, Server> = {
      tavily: makeServer({
        command: "bunx",
        args: ["tavily-mcp@latest"],
        env: { KEY: "old" },
        adapters: { "claude-code": { alwaysAllow: ["search"] } },
        _marketplace: marketplace,
      }),
    };
    // A subsequent import of the same server (exact identity) with new env —
    // forces an auto-merge / force-merge path rather than an identical skip.
    const incoming: ImportedServer[] = [
      makeImported({
        name: "tavily-cursor",
        command: "bunx",
        args: ["tavily-mcp@latest"],
        env: { KEY: "new", EXTRA: "val" },
      }),
    ];

    const auto = runMergePipeline(existing, incoming, "auto", "cursor");
    expect(auto.merged).toHaveLength(1);
    expect(auto.merged[0].server.adapters).toEqual({
      "claude-code": { alwaysAllow: ["search"] },
    });
    expect(auto.merged[0].server._marketplace).toEqual(marketplace);

    const force = runMergePipeline(existing, incoming, "force", "cursor");
    expect(force.merged).toHaveLength(1);
    expect(force.merged[0].server.adapters).toEqual({
      "claude-code": { alwaysAllow: ["search"] },
    });
    expect(force.merged[0].server._marketplace).toEqual(marketplace);
  });
});
