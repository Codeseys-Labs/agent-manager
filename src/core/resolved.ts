// ── Resolved Config (produced by core, consumed by adapters) ─────
//
// These types are the output of `buildResolvedConfig` (the only producer) and
// are consumed by the IDE adapters' export/diff paths. They live in core so the
// dependency direction is strictly `adapters → core` (see ADR P2-A: break the
// core↔adapters type cycle).

export interface ResolvedServer {
  name: string;
  command: string;
  url?: string;
  args: string[];
  env: Record<string, string>;
  transport: "stdio" | "streamable-http" | "sse";
  description: string;
  tags: string[];
  enabled: boolean;
  adapters: Record<string, Record<string, unknown>>;
}

export interface ResolvedInstruction {
  name: string;
  content: string;
  scope: "always" | "glob" | "agent-decision" | "manual";
  globs: string[];
  description: string;
  targets: string[];
  adapters: Record<string, Record<string, unknown>>;
}

export interface ResolvedSkill {
  name: string;
  path: string;
  description: string;
  tags: string[];
  adapters: Record<string, Record<string, unknown>>;
}

export interface ResolvedAgent {
  name: string;
  description: string;
  subagent_type: string;
  prompt: string;
  prompt_file: string;
  model: string;
  tools: string[];
  disallowed_tools: string[];
  mcp_servers: string[];
  max_turns: number | undefined;
  adapters: Record<string, Record<string, unknown>>;
}

export interface ResolvedConfig {
  servers: Record<string, ResolvedServer>;
  instructions: Record<string, ResolvedInstruction>;
  skills: Record<string, ResolvedSkill>;
  agents: Record<string, ResolvedAgent>;
  profile: string;
  adapters: Record<string, Record<string, unknown>>;
  settings?: Record<string, unknown>;
}
