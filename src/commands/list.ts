import { defineCommand } from "citty";
import { loadResolvedConfig, resolveConfigDir, resolveProjectConfig } from "../core/config";
import type { Config } from "../core/schema";
import { AmError } from "../lib/errors";
import { amError, error, info, output } from "../lib/output";

const ENTITY_TYPES = ["servers", "instructions", "skills", "agents", "profiles"] as const;
type EntityType = (typeof ENTITY_TYPES)[number];

function parseEntityType(raw: string | undefined): EntityType {
  if (!raw) return "servers";
  // Accept singular or plural forms
  const normalized = raw.toLowerCase();
  const singular: Record<string, EntityType> = {
    server: "servers",
    servers: "servers",
    instruction: "instructions",
    instructions: "instructions",
    skill: "skills",
    skills: "skills",
    agent: "agents",
    agents: "agents",
    profile: "profiles",
    profiles: "profiles",
  };
  const result = singular[normalized];
  if (!result) {
    const valid = ENTITY_TYPES.join(", ");
    throw new Error(`Unknown entity type "${raw}". Valid types: ${valid}`);
  }
  return result;
}

export const listCommand = defineCommand({
  meta: {
    name: "list",
    description:
      "List entities in the config (servers, instructions, skills, agents, profiles). For the unified agent roster (config + ACP built-ins + A2A roster), use `am agent list`.",
  },
  args: {
    entity: {
      type: "positional",
      description: "Entity type: servers (default), instructions, skills, agents, profiles",
      required: false,
    },
    json: { type: "boolean", description: "JSON output", default: false },
    active: { type: "boolean", description: "Show only active-profile servers", default: false },
    global: { type: "boolean", description: "Show only global servers", default: false },
    project: { type: "boolean", description: "Show only project servers", default: false },
    quiet: { type: "boolean", alias: "q", default: false },
    verbose: { type: "boolean", alias: "v", default: false },
  },
  async run({ args }) {
    const opts = { json: args.json, quiet: args.quiet, verbose: args.verbose };
    try {
      const configDir = resolveConfigDir();
      const entityType = parseEntityType(args.entity as string | undefined);

      const projectFile = args.global ? null : resolveProjectConfig(process.cwd());

      let config;
      try {
        config = await loadResolvedConfig({
          configDir,
          projectFile,
        });
      } catch {
        throw new AmError(
          "Config not found",
          "Run `am init` to initialize agent-manager",
          "CONFIG_NOT_FOUND",
        );
      }

      switch (entityType) {
        case "servers":
          return listServers(config, opts);
        case "instructions":
          return listInstructions(config, opts);
        case "skills":
          return listSkills(config, opts);
        case "agents":
          return listAgents(config, opts);
        case "profiles":
          return listProfiles(config, opts);
      }
    } catch (err) {
      amError(err, opts);
      process.exitCode = 1;
    }
  },
});

function listServers(config: Config, opts: { json?: boolean; quiet?: boolean; verbose?: boolean }) {
  const servers = config.servers ?? {};
  const entries = Object.entries(servers).map(([name, srv]) => ({
    name,
    command: srv.command,
    args: srv.args,
    tags: srv.tags ?? [],
    enabled: srv.enabled ?? true,
    description: srv.description ?? "",
    transport: srv.transport ?? "stdio",
  }));

  if (opts.json) {
    output({ servers: entries }, opts);
    return;
  }

  if (entries.length === 0) {
    info("No servers configured. Run `am add <name> --command <cmd>` to add one.", opts);
    return;
  }

  info(`${"Name".padEnd(20)} ${"Command".padEnd(30)} ${"Tags".padEnd(20)} ${"Status"}`, opts);
  info(`${"─".repeat(20)} ${"─".repeat(30)} ${"─".repeat(20)} ${"─".repeat(8)}`, opts);
  for (const s of entries) {
    const status = s.enabled ? "active" : "disabled";
    info(
      `${s.name.padEnd(20)} ${s.command.padEnd(30)} ${s.tags.join(", ").padEnd(20)} ${status}`,
      opts,
    );
  }
  info(`\n${entries.length} server(s)`, opts);
}

function listInstructions(
  config: Config,
  opts: { json?: boolean; quiet?: boolean; verbose?: boolean },
) {
  const instructions = config.instructions ?? {};
  const entries = Object.entries(instructions).map(([name, instr]) => ({
    name,
    scope: instr.scope ?? "always",
    description: instr.description ?? "",
    hasContent: !!(instr.content || instr.content_file),
    targets: instr.targets ?? [],
  }));

  if (opts.json) {
    output({ instructions: entries }, opts);
    return;
  }

  if (entries.length === 0) {
    info(
      "No instructions configured. Run `am add instruction <name> --content <text> --scope always` to add one.",
      opts,
    );
    return;
  }

  info(`${"Name".padEnd(25)} ${"Scope".padEnd(18)} ${"Description"}`, opts);
  info(`${"─".repeat(25)} ${"─".repeat(18)} ${"─".repeat(30)}`, opts);
  for (const i of entries) {
    info(`${i.name.padEnd(25)} ${i.scope.padEnd(18)} ${i.description}`, opts);
  }
  info(`\n${entries.length} instruction(s)`, opts);
}

function listSkills(config: Config, opts: { json?: boolean; quiet?: boolean; verbose?: boolean }) {
  const skills = config.skills ?? {};
  const entries = Object.entries(skills).map(([name, skill]) => ({
    name,
    path: skill.path,
    description: skill.description ?? "",
    tags: skill.tags ?? [],
  }));

  if (opts.json) {
    output({ skills: entries }, opts);
    return;
  }

  if (entries.length === 0) {
    info("No skills configured.", opts);
    return;
  }

  info(`${"Name".padEnd(25)} ${"Path".padEnd(35)} ${"Tags"}`, opts);
  info(`${"─".repeat(25)} ${"─".repeat(35)} ${"─".repeat(20)}`, opts);
  for (const s of entries) {
    info(`${s.name.padEnd(25)} ${s.path.padEnd(35)} ${s.tags.join(", ")}`, opts);
  }
  info(`\n${entries.length} skill(s)`, opts);
}

function listAgents(config: Config, opts: { json?: boolean; quiet?: boolean; verbose?: boolean }) {
  const agents = config.agents ?? {};
  const entries = Object.entries(agents).map(([name, agent]) => ({
    name: agent.name ?? name,
    description: agent.description ?? "",
    model: agent.model ?? "",
    mcpServers: agent.mcp_servers ?? [],
  }));

  if (opts.json) {
    output({ agents: entries }, opts);
    return;
  }

  if (entries.length === 0) {
    info(
      "No agents in config. Run `am agent list` to see ACP built-ins + A2A roster agents.",
      opts,
    );
    return;
  }

  info(
    `${"Name".padEnd(25)} ${"Model".padEnd(20)} ${"MCP Servers".padEnd(25)} ${"Description"}`,
    opts,
  );
  info(`${"─".repeat(25)} ${"─".repeat(20)} ${"─".repeat(25)} ${"─".repeat(20)}`, opts);
  for (const a of entries) {
    info(
      `${a.name.padEnd(25)} ${a.model.padEnd(20)} ${a.mcpServers.join(", ").padEnd(25)} ${a.description}`,
      opts,
    );
  }
  info(`\n${entries.length} agent(s)`, opts);
}

function listProfiles(
  config: Config,
  opts: { json?: boolean; quiet?: boolean; verbose?: boolean },
) {
  const profiles = config.profiles ?? {};
  const entries = Object.entries(profiles).map(([name, profile]) => ({
    name,
    description: profile.description ?? "",
    inherits: profile.inherits ?? "",
    servers: profile.servers ?? [],
    serverTags: profile.server_tags ?? [],
  }));

  if (opts.json) {
    output({ profiles: entries }, opts);
    return;
  }

  if (entries.length === 0) {
    info("No profiles configured. Run `am profile create <name>` to add one.", opts);
    return;
  }

  info(
    `${"Name".padEnd(20)} ${"Inherits".padEnd(15)} ${"Servers".padEnd(25)} ${"Description"}`,
    opts,
  );
  info(`${"─".repeat(20)} ${"─".repeat(15)} ${"─".repeat(25)} ${"─".repeat(20)}`, opts);
  for (const p of entries) {
    const serverStr =
      p.servers.length > 0
        ? p.servers.join(", ")
        : p.serverTags.length > 0
          ? `tags: ${p.serverTags.join(", ")}`
          : "all";
    info(
      `${p.name.padEnd(20)} ${p.inherits.padEnd(15)} ${serverStr.padEnd(25)} ${p.description}`,
      opts,
    );
  }
  info(`\n${entries.length} profile(s)`, opts);
}
