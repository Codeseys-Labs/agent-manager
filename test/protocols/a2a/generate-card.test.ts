import { describe, expect, test } from "bun:test";
import type { ResolvedAgent, ResolvedConfig } from "../../../src/adapters/types";
import {
  type GenerateCardOptions,
  generateAgentCard,
} from "../../../src/protocols/a2a/generate-card";

// ── Helpers ─────────────────────────────────────────────────────

function makeResolvedConfig(overrides: Partial<ResolvedConfig> = {}): ResolvedConfig {
  return {
    servers: {},
    instructions: {},
    skills: {},
    agents: {},
    profile: "default",
    adapters: {},
    ...overrides,
  };
}

function makeResolvedAgent(overrides: Partial<ResolvedAgent> = {}): ResolvedAgent {
  return {
    name: "test-agent",
    description: "A test agent",
    subagent_type: "general",
    prompt: "You are a test agent.",
    prompt_file: "",
    model: "opus",
    tools: [],
    disallowed_tools: [],
    mcp_servers: [],
    max_turns: undefined,
    adapters: {},
    ...overrides,
  };
}

const DEFAULT_OPTIONS: GenerateCardOptions = {
  baseUrl: "http://localhost:8080",
};

// ── Tests ───────────────────────────────────────────────────────

describe("generateAgentCard", () => {
  // ── Basic structure ─────────────────────────────────────────

  describe("basic structure", () => {
    test("returns a valid AgentCard with required fields", () => {
      const config = makeResolvedConfig();
      const card = generateAgentCard(config, DEFAULT_OPTIONS);

      expect(card.name).toBe("agent-manager");
      expect(card.description).toBeTruthy();
      expect(card.version).toBeTruthy();
      expect(card.url).toBe("http://localhost:8080");
      expect(card.capabilities).toBeDefined();
      expect(card.skills).toBeDefined();
      expect(Array.isArray(card.skills)).toBe(true);
    });

    test("card has correct capabilities", () => {
      const config = makeResolvedConfig();
      const card = generateAgentCard(config, DEFAULT_OPTIONS);

      expect(card.capabilities.streaming).toBe(true);
      expect(card.capabilities.pushNotifications).toBe(false);
      expect(card.capabilities.stateTransitionHistory).toBe(true);
    });

    test("card has authentication schemes", () => {
      const config = makeResolvedConfig();
      const card = generateAgentCard(config, DEFAULT_OPTIONS);

      expect(card.authentication).toBeDefined();
      expect(card.authentication).toHaveLength(1);
      expect(card.authentication![0].type).toBe("bearer");
    });

    test("card has default input/output modes", () => {
      const config = makeResolvedConfig();
      const card = generateAgentCard(config, DEFAULT_OPTIONS);

      expect(card.defaultInputModes).toContain("text");
      expect(card.defaultInputModes).toContain("data");
      expect(card.defaultOutputModes).toContain("text");
      expect(card.defaultOutputModes).toContain("data");
    });
  });

  // ── Built-in skills ─────────────────────────────────────────

  describe("built-in skills", () => {
    test("includes all 6 built-in skills", () => {
      const config = makeResolvedConfig();
      const card = generateAgentCard(config, DEFAULT_OPTIONS);

      const skillIds = card.skills.map((s) => s.id);
      expect(skillIds).toContain("config.read");
      expect(skillIds).toContain("config.write");
      expect(skillIds).toContain("registry.search");
      expect(skillIds).toContain("registry.install");
      expect(skillIds).toContain("adapter.apply");
      expect(skillIds).toContain("adapter.status");
    });

    test("built-in skills have proper metadata", () => {
      const config = makeResolvedConfig();
      const card = generateAgentCard(config, DEFAULT_OPTIONS);

      const readSkill = card.skills.find((s) => s.id === "config.read");
      expect(readSkill).toBeDefined();
      expect(readSkill!.name).toBe("Read Configuration");
      expect(readSkill!.description).toBeTruthy();
      expect(readSkill!.inputModes).toContain("text");
      expect(readSkill!.tags).toContain("config");
    });
  });

  // ── Agent-derived skills ────────────────────────────────────

  describe("agent-derived skills", () => {
    test("agent with A2A metadata becomes a skill", () => {
      const config = makeResolvedConfig({
        agents: {
          researcher: makeResolvedAgent({
            name: "researcher",
            description: "Research agent",
            adapters: {
              a2a: {
                input_modes: ["text"],
                output_modes: ["text", "data"],
              },
            },
          }),
        },
      });

      const card = generateAgentCard(config, DEFAULT_OPTIONS);
      const agentSkill = card.skills.find((s) => s.id === "agent.researcher");

      expect(agentSkill).toBeDefined();
      expect(agentSkill!.name).toBe("researcher");
      expect(agentSkill!.description).toBe("Research agent");
      expect(agentSkill!.tags).toContain("agent");
      expect(agentSkill!.tags).toContain("researcher");
    });

    test("agent without A2A metadata is NOT exposed as a skill", () => {
      const config = makeResolvedConfig({
        agents: {
          internal: makeResolvedAgent({
            name: "internal",
            adapters: {}, // no a2a key
          }),
        },
      });

      const card = generateAgentCard(config, DEFAULT_OPTIONS);
      const agentSkill = card.skills.find((s) => s.id === "agent.internal");

      expect(agentSkill).toBeUndefined();
    });

    test("agent with A2A sub-skills generates per-skill entries", () => {
      const config = makeResolvedConfig({
        agents: {
          analyzer: makeResolvedAgent({
            name: "analyzer",
            description: "Code analyzer",
            adapters: {
              a2a: {
                input_modes: ["text"],
                output_modes: ["text"],
                skills: {
                  lint: {
                    description: "Lint code files",
                    tags: ["lint", "quality"],
                  },
                  format: {
                    description: "Format code files",
                    input_modes: ["text", "data"],
                    tags: ["format"],
                  },
                },
              },
            },
          }),
        },
      });

      const card = generateAgentCard(config, DEFAULT_OPTIONS);

      const lintSkill = card.skills.find((s) => s.id === "agent.analyzer.lint");
      const formatSkill = card.skills.find((s) => s.id === "agent.analyzer.format");

      expect(lintSkill).toBeDefined();
      expect(lintSkill!.description).toBe("Lint code files");
      expect(lintSkill!.tags).toContain("lint");
      expect(lintSkill!.tags).toContain("quality");
      expect(lintSkill!.tags).toContain("agent");
      expect(lintSkill!.tags).toContain("analyzer");

      expect(formatSkill).toBeDefined();
      expect(formatSkill!.description).toBe("Format code files");
      expect(formatSkill!.inputModes).toContain("text");
      expect(formatSkill!.inputModes).toContain("data");
    });

    test("multiple agents with A2A metadata all become skills", () => {
      const config = makeResolvedConfig({
        agents: {
          agent1: makeResolvedAgent({
            name: "agent1",
            adapters: { a2a: {} },
          }),
          agent2: makeResolvedAgent({
            name: "agent2",
            adapters: { a2a: {} },
          }),
        },
      });

      const card = generateAgentCard(config, DEFAULT_OPTIONS);
      const agentSkills = card.skills.filter((s) => s.id.startsWith("agent."));

      expect(agentSkills).toHaveLength(2);
    });
  });

  // ── Provider metadata ───────────────────────────────────────

  describe("provider metadata", () => {
    test("uses custom name from provider options", () => {
      const config = makeResolvedConfig();
      const card = generateAgentCard(config, {
        baseUrl: "http://localhost:8080",
        provider: { name: "My Custom Agent" },
      });

      expect(card.name).toBe("My Custom Agent");
    });

    test("uses custom description from provider options", () => {
      const config = makeResolvedConfig();
      const card = generateAgentCard(config, {
        baseUrl: "http://localhost:8080",
        provider: { description: "My custom description." },
      });

      expect(card.description).toBe("My custom description.");
    });

    test("includes provider when organization is specified", () => {
      const config = makeResolvedConfig();
      const card = generateAgentCard(config, {
        baseUrl: "http://localhost:8080",
        provider: {
          organization: "Acme Corp",
          url: "https://acme.example.com",
        },
      });

      expect(card.provider).toBeDefined();
      expect(card.provider!.organization).toBe("Acme Corp");
      expect(card.provider!.url).toBe("https://acme.example.com");
    });

    test("provider is undefined when no organization", () => {
      const config = makeResolvedConfig();
      const card = generateAgentCard(config, {
        baseUrl: "http://localhost:8080",
        provider: { name: "test" }, // no organization
      });

      expect(card.provider).toBeUndefined();
    });
  });

  // ── URL handling ────────────────────────────────────────────

  describe("URL handling", () => {
    test("uses baseUrl as card url", () => {
      const config = makeResolvedConfig();
      const card = generateAgentCard(config, {
        baseUrl: "https://my-agent.example.com",
      });

      expect(card.url).toBe("https://my-agent.example.com");
    });
  });

  // ── Version ─────────────────────────────────────────────────

  describe("version", () => {
    test("uses BUILD_VERSION env or falls back to 0.1.0", () => {
      const config = makeResolvedConfig();
      const card = generateAgentCard(config, DEFAULT_OPTIONS);

      // Either the BUILD_VERSION env var or the fallback
      expect(card.version).toMatch(/^\d+\.\d+\.\d+/);
    });
  });

  // ── Total skill count ───────────────────────────────────────

  describe("total skills", () => {
    test("has at least 6 skills (built-in) even with empty config", () => {
      const config = makeResolvedConfig();
      const card = generateAgentCard(config, DEFAULT_OPTIONS);

      expect(card.skills.length).toBeGreaterThanOrEqual(6);
    });

    test("total skills = built-in + agent-derived", () => {
      const config = makeResolvedConfig({
        agents: {
          a1: makeResolvedAgent({ name: "a1", adapters: { a2a: {} } }),
          a2: makeResolvedAgent({ name: "a2", adapters: { a2a: {} } }),
        },
      });

      const card = generateAgentCard(config, DEFAULT_OPTIONS);
      // 6 built-in + 2 agent-derived
      expect(card.skills).toHaveLength(8);
    });
  });
});
