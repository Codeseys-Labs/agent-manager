import { describe, expect, test } from "bun:test";
import { catalogEntityNames, extractEntities, generateWikilinks } from "../../src/wiki/ner";

// ADR-0054 R3: NER derives its tool vocabulary from the resolved catalog
// (server/agent/skill/instruction names) plus a small static fallback, rather
// than the old frozen KNOWN_TOOLS literal. The wiki auto-links real catalog
// entities.

describe("wiki/ner catalog-derived entities (ADR-0054 R3)", () => {
  describe("catalogEntityNames", () => {
    test("collects names from servers/agents/skills/instructions", () => {
      const names = catalogEntityNames({
        servers: { "my-mcp": {}, "filesystem-server": {} },
        agents: { "code-reviewer": {} },
        skills: { "deep-research": {} },
        instructions: { "house-style": {} },
      });
      expect(names).toContain("my-mcp");
      expect(names).toContain("filesystem-server");
      expect(names).toContain("code-reviewer");
      expect(names).toContain("deep-research");
      expect(names).toContain("house-style");
    });

    test("returns [] for undefined / empty config", () => {
      expect(catalogEntityNames()).toEqual([]);
      expect(catalogEntityNames({})).toEqual([]);
    });

    test("dedupes names that appear under multiple groups", () => {
      const names = catalogEntityNames({
        servers: { shared: {} },
        skills: { shared: {} },
      });
      expect(names.filter((n) => n === "shared")).toHaveLength(1);
    });
  });

  describe("extractEntities with catalogEntities", () => {
    test("matches a catalog server name not in the static fallback", () => {
      const text = "We added the acme-internal-mcp server to the gateway.";
      // Without the catalog, the bespoke name is not recognised as a tool.
      const baseline = extractEntities(text).filter((e) => e.type === "tool_name");
      expect(baseline.some((e) => e.text === "acme-internal-mcp")).toBe(false);

      // With the catalog, it is.
      const withCatalog = extractEntities(text, {
        catalogEntities: ["acme-internal-mcp"],
      }).filter((e) => e.type === "tool_name");
      expect(withCatalog.some((e) => e.text === "acme-internal-mcp")).toBe(true);
    });

    test("still matches the static fallback alongside catalog names", () => {
      const text = "We use Claude Code with our custom widget-builder skill.";
      const tools = extractEntities(text, {
        catalogEntities: ["widget-builder"],
      }).filter((e) => e.type === "tool_name");
      expect(tools.some((e) => e.text === "Claude Code")).toBe(true);
      expect(tools.some((e) => e.text === "widget-builder")).toBe(true);
    });

    test("includeFallback:false matches only catalog names", () => {
      const text = "Claude Code talks to our gizmo-server.";
      const tools = extractEntities(text, {
        catalogEntities: ["gizmo-server"],
        includeFallback: false,
      }).filter((e) => e.type === "tool_name");
      expect(tools.some((e) => e.text === "gizmo-server")).toBe(true);
      expect(tools.some((e) => e.text === "Claude Code")).toBe(false);
    });

    test("prefers the longest match when a catalog name contains another", () => {
      const text = "Configure the data pipeline server today.";
      const tools = extractEntities(text, {
        catalogEntities: ["data pipeline server", "data pipeline"],
      }).filter((e) => e.type === "tool_name");
      // Longest-first scan + dedup means the longer span wins, not the prefix.
      expect(tools.some((e) => e.text === "data pipeline server")).toBe(true);
      expect(tools.some((e) => e.text === "data pipeline")).toBe(false);
    });
  });

  describe("generateWikilinks with catalogEntities", () => {
    test("auto-links a catalog name that has a wiki page", () => {
      const text = "The acme-internal-mcp server handles auth.";
      const knownSlugs = new Set(["acme-internal-mcp"]);
      const result = generateWikilinks(text, knownSlugs, {
        catalogEntities: ["acme-internal-mcp"],
      });
      expect(result).toContain("[[acme-internal-mcp]]");
    });

    test("does not link a catalog name that has no page", () => {
      const text = "The acme-internal-mcp server handles auth.";
      const knownSlugs = new Set(["something-else"]);
      const result = generateWikilinks(text, knownSlugs, {
        catalogEntities: ["acme-internal-mcp"],
      });
      expect(result).not.toContain("[[acme-internal-mcp]]");
    });
  });
});
