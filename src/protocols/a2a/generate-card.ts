/**
 * A2A Agent Card Generator — builds an A2A AgentCard from am's resolved config.
 *
 * Maps agent-manager entities (servers, agents, profiles) to A2A AgentCard
 * skills and capabilities. This is used by both the local web server
 * (/.well-known/agent.json) and the `am agents` CLI.
 */

import type { ResolvedConfig } from "../../adapters/types";
import type { AgentCapabilities, AgentCard, AgentProvider, AgentSkill } from "./types";

/** Options for generating the Agent Card. */
export interface GenerateCardOptions {
  /** Base URL where the agent is hosted (e.g., http://localhost:8080). */
  baseUrl: string;
  /** Provider metadata from settings.a2a.publish */
  provider?: {
    name?: string;
    description?: string;
    organization?: string;
    url?: string;
  };
}

/** Built-in skills that agent-manager always exposes via A2A. */
const BUILTIN_SKILLS: AgentSkill[] = [
  {
    id: "config.read",
    name: "Read Configuration",
    description:
      "Read the agent-manager configuration including servers, profiles, instructions, and skills.",
    inputModes: ["text"],
    outputModes: ["text", "data"],
    tags: ["config", "read"],
  },
  {
    id: "config.write",
    name: "Write Configuration",
    description:
      "Add, remove, or modify MCP servers, instructions, and profiles in the agent-manager config.",
    inputModes: ["text", "data"],
    outputModes: ["text", "data"],
    tags: ["config", "write"],
  },
  {
    id: "registry.search",
    name: "Search Registry",
    description: "Search for MCP servers by name, tag, or description.",
    inputModes: ["text"],
    outputModes: ["data"],
    tags: ["registry", "search"],
  },
  {
    id: "registry.install",
    name: "Install from Registry",
    description: "Add an MCP server from the registry to the agent-manager config.",
    inputModes: ["text", "data"],
    outputModes: ["text", "data"],
    tags: ["registry", "install"],
  },
  {
    id: "adapter.apply",
    name: "Apply Configuration",
    description:
      "Generate native IDE configs from the agent-manager catalog for all detected tools.",
    inputModes: ["text"],
    outputModes: ["text", "data"],
    tags: ["adapter", "apply"],
  },
  {
    id: "adapter.status",
    name: "Check Status",
    description: "Check drift detection and sync state across all managed tools and adapters.",
    inputModes: ["text"],
    outputModes: ["text", "data"],
    tags: ["adapter", "status"],
  },
];

/**
 * Generate agent-specific skills from resolved config's agent profiles
 * that have A2A metadata in their adapters passthrough.
 */
function generateAgentSkills(config: ResolvedConfig): AgentSkill[] {
  const skills: AgentSkill[] = [];

  for (const [name, agent] of Object.entries(config.agents)) {
    const a2aMeta = agent.adapters?.a2a as Record<string, unknown> | undefined;
    if (!a2aMeta) continue;

    // Check for per-skill definitions in adapters.a2a.skills
    const skillDefs = a2aMeta.skills as Record<string, Record<string, unknown>> | undefined;
    if (skillDefs) {
      for (const [skillId, skillMeta] of Object.entries(skillDefs)) {
        skills.push({
          id: `agent.${name}.${skillId}`,
          name: `${agent.name}: ${skillId}`,
          description: (skillMeta.description as string) ?? agent.description ?? "",
          inputModes: (skillMeta.input_modes as string[]) ?? (a2aMeta.input_modes as string[]),
          outputModes: (skillMeta.output_modes as string[]) ?? (a2aMeta.output_modes as string[]),
          tags: ["agent", name, ...((skillMeta.tags as string[]) ?? [])],
        });
      }
    } else {
      // Agent has A2A metadata but no sub-skills — expose the whole agent as one skill
      skills.push({
        id: `agent.${name}`,
        name: agent.name,
        description: agent.description ?? "",
        inputModes: a2aMeta.input_modes as string[] | undefined,
        outputModes: a2aMeta.output_modes as string[] | undefined,
        tags: ["agent", name],
      });
    }
  }

  return skills;
}

/**
 * Generate a valid A2A Agent Card from agent-manager's resolved config.
 */
export function generateAgentCard(config: ResolvedConfig, options: GenerateCardOptions): AgentCard {
  const agentSkills = generateAgentSkills(config);
  const allSkills = [...BUILTIN_SKILLS, ...agentSkills];

  const capabilities: AgentCapabilities = {
    streaming: false,
    pushNotifications: false,
    stateTransitionHistory: true,
  };

  const provider: AgentProvider | undefined = options.provider?.organization
    ? {
        organization: options.provider.organization,
        url: options.provider.url,
      }
    : undefined;

  return {
    name: options.provider?.name ?? "agent-manager",
    description:
      options.provider?.description ??
      "Agent configuration manager — define once in TOML, sync via git, generate native configs for every AI coding tool.",
    version: process.env.BUILD_VERSION ?? "0.1.0",
    url: options.baseUrl,
    provider,
    capabilities,
    skills: allSkills,
    authentication: [{ type: "bearer", description: "Bearer token from config directory" }],
    defaultInputModes: ["text", "data"],
    defaultOutputModes: ["text", "data"],
  };
}
