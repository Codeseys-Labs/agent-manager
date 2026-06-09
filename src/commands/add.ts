import { access, readFile, stat } from "node:fs/promises";
import { isAbsolute, join, resolve as resolvePath } from "node:path";
import { defineCommand } from "citty";
import { resolveConfigDir } from "../core/config";
import { withConfig } from "../core/controller";
import type { AgentProfile, Instruction, Server, Skill } from "../core/schema";
import { pickEnvVarName, scanServerForSecrets, substituteSecret } from "../core/secret-detection";
import {
  encryptValue,
  generateKey,
  importKey,
  loadKey,
  resolveKeyPath,
  saveKey,
} from "../core/secrets";
import { AmError, requireConfig } from "../lib/errors";
import { amError, error, info, output } from "../lib/output";

const ENTITY_TYPES = ["server", "instruction", "skill", "agent"] as const;
type EntityType = (typeof ENTITY_TYPES)[number];

/**
 * Parse entity type from first positional arg.
 * Returns { entity, name } — if the first arg is a known entity type,
 * consume it; otherwise treat the first arg as the server name (backwards compat).
 */
function parseEntityAndName(rawArgs: string[]): { entity: EntityType; name: string | undefined } {
  if (rawArgs.length === 0) return { entity: "server", name: undefined };
  const first = rawArgs[0].toLowerCase();
  if ((ENTITY_TYPES as readonly string[]).includes(first)) {
    return { entity: first as EntityType, name: rawArgs[1] };
  }
  // Backwards compat: `am add my-server` → entity=server, name=my-server
  return { entity: "server", name: rawArgs[0] };
}

export const addCommand = defineCommand({
  meta: {
    name: "add",
    description: "Add an entity to the config (server, instruction, skill, agent)",
  },
  args: {
    _args: {
      type: "positional",
      description: "Entity type and name: `am add [server|instruction|skill|agent] <name>`",
      required: false,
    },
    command: { type: "string", description: "Command to run (servers)" },
    args: { type: "string", description: "Comma-separated args (servers)" },
    tags: { type: "string", description: "Comma-separated tags" },
    description: { type: "string", description: "Entity description" },
    env: { type: "string", description: "Comma-separated KEY=VALUE pairs (servers)" },
    content: { type: "string", description: "Instruction content (instructions)" },
    "content-file": {
      type: "string",
      description: "Path to instruction content file (instructions)",
    },
    scope: {
      type: "string",
      description: "Instruction scope: always, glob, agent-decision, manual (instructions)",
    },
    globs: { type: "string", description: "Comma-separated globs (instructions with scope=glob)" },
    targets: { type: "string", description: "Comma-separated target adapters (instructions)" },
    // Skill flags
    path: { type: "string", description: "Path to skill directory containing SKILL.md (skills)" },
    source: {
      type: "string",
      description: "Skill source: git+<url>, local:<path>, or marketplace-ref (skills)",
    },
    // Agent flags
    "prompt-file": {
      type: "string",
      description: "Path to system prompt markdown (agents)",
    },
    model: { type: "string", description: "Model identifier (agents)" },
    acp: {
      type: "string",
      description: "ACP local runtime command (agents — sets adapters.acp passthrough)",
    },
    a2a: {
      type: "string",
      description: "A2A remote agent URL (agents — sets adapters.a2a passthrough)",
    },
    project: {
      type: "boolean",
      description: "Add to project config instead of global",
      default: false,
    },
    json: { type: "boolean", description: "JSON output", default: false },
    quiet: { type: "boolean", alias: "q", default: false },
    verbose: { type: "boolean", alias: "v", default: false },
  },
  async run({ args }) {
    const opts = { json: args.json, quiet: args.quiet, verbose: args.verbose };

    // citty puts all positional args in args._ as an array
    const rawPositionals = ((args._ ?? []) as string[]).filter((s) => typeof s === "string");

    const { entity, name } = parseEntityAndName(rawPositionals);

    if (!name) {
      error(`Missing name. Usage: am add ${entity} <name>`, opts);
      process.exitCode = 1;
      return;
    }

    try {
      switch (entity) {
        case "server":
          return await addServer(name, args, opts);
        case "instruction":
          return await addInstruction(name, args, opts);
        case "skill":
          return await addSkill(name, args, opts);
        case "agent":
          return await addAgent(name, args, opts);
      }
    } catch (err) {
      amError(err, opts);
      process.exitCode = 1;
    }
  },
});

async function addServer(
  name: string,
  args: Record<string, unknown>,
  opts: { json?: boolean; quiet?: boolean; verbose?: boolean },
) {
  const configDir = resolveConfigDir();

  if (!args.command) {
    error("Missing --command. Usage: am add server <name> --command <cmd>", opts);
    process.exitCode = 1;
    return;
  }

  type Outcome =
    | { status: "ok"; server: Server; secretsEncrypted: number; tagStr: string }
    | { status: "duplicate" }
    | { status: "missing-config" };

  const outcome = await withConfig<Outcome>(configDir, async (config) => {
    // requireConfig would throw if the config was empty (no file at all).
    // Preserve that behavior by bailing out explicitly.
    if (!config) {
      return { result: { status: "missing-config" }, changed: false };
    }

    if (config.servers?.[name]) {
      return { result: { status: "duplicate" }, changed: false };
    }

    const server: Server = {
      command: args.command as string,
      transport: "stdio",
      enabled: true,
    };
    if (args.args) server.args = (args.args as string).split(",").map((s) => s.trim());
    if (args.tags) server.tags = (args.tags as string).split(",").map((s) => s.trim());
    if (args.description) server.description = args.description as string;
    if (args.env) {
      server.env = {};
      for (const pair of (args.env as string).split(",")) {
        const [k, ...rest] = pair.split("=");
        if (k && rest.length > 0) server.env[k.trim()] = rest.join("=").trim();
      }
    }

    if (!config.servers) config.servers = {};
    config.servers[name] = server;

    // Scan for secrets and auto-encrypt before writing
    const scanResult = await scanServerForSecrets(name, server);
    let secretsEncrypted = 0;
    const actionableSecrets = scanResult.secrets;

    if (actionableSecrets.length > 0) {
      let key = await loadKey(configDir);
      if (!key) {
        const base64Key = await generateKey();
        await saveKey(configDir, base64Key);
        key = await importKey(base64Key);
        info(`Generated encryption key (stored at ${resolveKeyPath()})`, opts);
      }

      for (const secret of actionableSecrets) {
        if (!config.settings) config.settings = {};
        if (!config.settings.env) config.settings.env = {};
        // URL creds derive a generic name (api_key→API_KEY) that can collide
        // across servers; pick a collision-safe key so we never clobber a
        // different secret. Env-var secrets reuse their original key name.
        const envVarName =
          secret.source === "url-credential"
            ? pickEnvVarName(config.settings.env, secret.suggestedEnvVar, name)
            : secret.suggestedEnvVar;
        // INVARIANT: only encrypt+count once the plaintext is provably removed.
        // If substitution could not rewrite the value (unknown location), refuse
        // rather than store an encrypted copy beside surviving plaintext.
        if (!substituteSecret(server, secret, envVarName)) {
          throw new AmError(
            `Could not obfuscate a detected secret in server "${name}".`,
            "Remove the credential from the server definition manually, or report this as a bug.",
            "SECRET_SUBSTITUTION_FAILED",
          );
        }
        config.settings.env[envVarName] = await encryptValue(secret.value, key);
        secretsEncrypted++;
      }
    }

    const tagStr = server.tags?.length ? ` (${server.tags.join(", ")})` : "";
    return {
      result: { status: "ok", server, secretsEncrypted, tagStr },
      commitMessage: `add server: ${name}${tagStr}`,
      changed: true,
    };
  });

  if (outcome.status === "missing-config") {
    // Re-run requireConfig to surface the canonical "config not found" error.
    requireConfig(null);
    return;
  }
  if (outcome.status === "duplicate") {
    error(`Server "${name}" already exists. Remove it first or use a different name.`, opts);
    process.exitCode = 1;
    return;
  }

  info(`Added server "${name}"`, opts);
  if (outcome.secretsEncrypted > 0 && !args.json) {
    info(
      `  Encrypted ${outcome.secretsEncrypted} secret(s) — values use \${VAR} references now.`,
      opts,
    );
  }

  if (args.json) {
    output(
      {
        action: "add",
        entity: "server",
        name,
        config: outcome.server,
        secretsEncrypted: outcome.secretsEncrypted > 0 ? outcome.secretsEncrypted : undefined,
      },
      opts,
    );
  }
}

async function addInstruction(
  name: string,
  args: Record<string, unknown>,
  opts: { json?: boolean; quiet?: boolean; verbose?: boolean },
) {
  const configDir = resolveConfigDir();

  const content = args.content as string | undefined;
  const contentFile = args["content-file"] as string | undefined;

  if (!content && !contentFile) {
    error(
      "Missing --content or --content-file. Usage: am add instruction <name> --content <text> --scope always",
      opts,
    );
    process.exitCode = 1;
    return;
  }

  if (content && contentFile) {
    error("Provide --content or --content-file, not both.", opts);
    process.exitCode = 1;
    return;
  }

  const scope = (args.scope as string | undefined) ?? "always";
  const validScopes = ["always", "glob", "agent-decision", "manual"];
  if (!validScopes.includes(scope)) {
    error(`Invalid scope "${scope}". Must be one of: ${validScopes.join(", ")}`, opts);
    process.exitCode = 1;
    return;
  }

  type Outcome =
    | { status: "ok"; instruction: Instruction }
    | { status: "duplicate" }
    | { status: "missing-config" };

  const outcome = await withConfig<Outcome>(configDir, async (config) => {
    if (!config) {
      return { result: { status: "missing-config" }, changed: false };
    }
    if (config.instructions?.[name]) {
      return { result: { status: "duplicate" }, changed: false };
    }

    const instruction: Instruction = {
      scope: scope as Instruction["scope"],
      ...(content ? { content } : {}),
      ...(contentFile ? { content_file: contentFile } : {}),
    };
    if (args.description) instruction.description = args.description as string;
    if (args.globs) instruction.globs = (args.globs as string).split(",").map((s) => s.trim());
    if (args.targets)
      instruction.targets = (args.targets as string).split(",").map((s) => s.trim());

    if (!config.instructions) config.instructions = {};
    config.instructions[name] = instruction;

    return {
      result: { status: "ok", instruction },
      commitMessage: `add instruction: ${name}`,
      changed: true,
    };
  });

  if (outcome.status === "missing-config") {
    requireConfig(null);
    return;
  }
  if (outcome.status === "duplicate") {
    error(`Instruction "${name}" already exists. Remove it first or use a different name.`, opts);
    process.exitCode = 1;
    return;
  }

  info(`Added instruction "${name}" (scope: ${scope})`, opts);

  if (args.json) {
    output({ action: "add", entity: "instruction", name, config: outcome.instruction }, opts);
  }
}

/**
 * Resolve a skill --source reference to a local path.
 *
 * Supported forms:
 *   - `local:<path>` — absolute or relative filesystem path
 *   - `git+<url>`    — not yet supported; returns an error string (stubbed)
 *   - `<anything>`   — treated as a marketplace ref; not supported yet
 *
 * For local refs we return the resolved absolute path. For anything else we
 * return an object with the kind so the caller can render a clear error.
 * The "pull it in" semantics are intentionally narrow — M3 ships local path
 * handling; git/marketplace fetching happens in later iterations.
 */
function parseSkillSource(
  source: string,
): { kind: "local"; path: string } | { kind: "unsupported"; reason: string } {
  if (source.startsWith("local:")) {
    const raw = source.slice("local:".length);
    return { kind: "local", path: isAbsolute(raw) ? raw : resolvePath(raw) };
  }
  if (source.startsWith("git+")) {
    return {
      kind: "unsupported",
      reason: "git+ sources are not yet supported. Clone the skill locally and use --path.",
    };
  }
  return {
    kind: "unsupported",
    reason: `Unsupported source "${source}". Use local:<path> or --path <path>.`,
  };
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Extract a description from a SKILL.md file — YAML frontmatter `description:`
 * takes priority, then falls back to the first non-empty line (stripping a
 * leading `# `). Returns undefined if the file can't be read or is empty.
 */
async function readSkillDescription(skillMdPath: string): Promise<string | undefined> {
  try {
    const content = await readFile(skillMdPath, "utf-8");
    // Check for YAML frontmatter
    const fm = content.match(/^---\n([\s\S]*?)\n---/);
    if (fm) {
      const descLine = fm[1].split("\n").find((l) => /^description\s*:/i.test(l));
      if (descLine) {
        const val = descLine.split(":").slice(1).join(":").trim();
        // Strip surrounding quotes
        const cleaned = val.replace(/^["']|["']$/g, "").trim();
        if (cleaned) return cleaned;
      }
    }
    const firstLine = content.split("\n").find((l) => l.trim().length > 0);
    if (firstLine) return firstLine.replace(/^#\s+/, "").trim();
  } catch {
    // fall through
  }
  return undefined;
}

async function addSkill(
  name: string,
  args: Record<string, unknown>,
  opts: { json?: boolean; quiet?: boolean; verbose?: boolean },
) {
  const configDir = resolveConfigDir();

  const pathArg = args.path as string | undefined;
  const sourceArg = args.source as string | undefined;

  if (!pathArg && !sourceArg) {
    error(
      "Missing --path or --source. Usage: am add skill <name> --path <dir> (or --source local:<path>)",
      opts,
    );
    process.exitCode = 1;
    return;
  }

  if (pathArg && sourceArg) {
    error("Provide --path or --source, not both.", opts);
    process.exitCode = 1;
    return;
  }

  // Resolve the skill path
  let skillPath: string;
  if (pathArg) {
    skillPath = isAbsolute(pathArg) ? pathArg : resolvePath(pathArg);
  } else {
    const parsed = parseSkillSource(sourceArg as string);
    if (parsed.kind !== "local") {
      error(parsed.reason, opts);
      process.exitCode = 1;
      return;
    }
    skillPath = parsed.path;
  }

  // Validate the path: must be a directory containing SKILL.md (Anthropic convention)
  let isDir = false;
  try {
    const st = await stat(skillPath);
    isDir = st.isDirectory();
  } catch {
    error(`Skill path does not exist: ${skillPath}`, opts);
    process.exitCode = 1;
    return;
  }
  if (!isDir) {
    error(`Skill path must be a directory: ${skillPath}`, opts);
    process.exitCode = 1;
    return;
  }
  const skillMd = join(skillPath, "SKILL.md");
  if (!(await fileExists(skillMd))) {
    error(`No SKILL.md found in ${skillPath} (Anthropic skills convention).`, opts);
    process.exitCode = 1;
    return;
  }

  // Derive description: explicit --description > SKILL.md frontmatter/first line > placeholder
  let description = args.description as string | undefined;
  if (!description) description = await readSkillDescription(skillMd);
  if (!description) description = `Skill: ${name}`;

  type Outcome =
    | { status: "ok"; skill: Skill }
    | { status: "duplicate" }
    | { status: "missing-config" };

  const outcome = await withConfig<Outcome>(configDir, async (config) => {
    if (!config) {
      return { result: { status: "missing-config" }, changed: false };
    }
    if (config.skills?.[name]) {
      return { result: { status: "duplicate" }, changed: false };
    }

    const skill: Skill = {
      path: skillPath,
      description,
    };
    if (args.tags) skill.tags = (args.tags as string).split(",").map((s) => s.trim());

    if (!config.skills) config.skills = {};
    config.skills[name] = skill;

    return {
      result: { status: "ok", skill },
      commitMessage: `add skill: ${name}`,
      changed: true,
    };
  });

  if (outcome.status === "missing-config") {
    requireConfig(null);
    return;
  }
  if (outcome.status === "duplicate") {
    error(`Skill "${name}" already exists. Remove it first or use a different name.`, opts);
    process.exitCode = 1;
    return;
  }

  info(`Added skill "${name}"`, opts);
  info(`Skill '${name}' added. Run \`am apply\` to generate native configs.`, opts);

  if (args.json) {
    output({ action: "add", entity: "skill", name, config: outcome.skill }, opts);
  }
}

async function addAgent(
  name: string,
  args: Record<string, unknown>,
  opts: { json?: boolean; quiet?: boolean; verbose?: boolean },
) {
  const configDir = resolveConfigDir();

  const promptFile = args["prompt-file"] as string | undefined;
  const acpCommand = args.acp as string | undefined;
  const a2aUrl = args.a2a as string | undefined;
  const description = args.description as string | undefined;
  const model = args.model as string | undefined;

  // Agent must have at least one of: prompt-file, acp, a2a
  if (!promptFile && !acpCommand && !a2aUrl) {
    error(
      "Missing --prompt-file, --acp, or --a2a. Provide at least one so the agent has something to run.",
      opts,
    );
    process.exitCode = 1;
    return;
  }

  // Validate prompt-file exists if supplied
  if (promptFile) {
    const resolved = isAbsolute(promptFile) ? promptFile : resolvePath(promptFile);
    if (!(await fileExists(resolved))) {
      error(`Prompt file does not exist: ${resolved}`, opts);
      process.exitCode = 1;
      return;
    }
  }

  type Outcome =
    | { status: "ok"; agent: AgentProfile }
    | { status: "duplicate" }
    | { status: "missing-config" };

  const outcome = await withConfig<Outcome>(configDir, async (config) => {
    if (!config) {
      return { result: { status: "missing-config" }, changed: false };
    }
    if (config.agents?.[name]) {
      return { result: { status: "duplicate" }, changed: false };
    }

    const agent: AgentProfile = { name };
    if (description) agent.description = description;
    if (promptFile) {
      const resolved = isAbsolute(promptFile) ? promptFile : resolvePath(promptFile);
      agent.prompt_file = resolved;
    }
    if (model) agent.model = model;
    if (acpCommand) agent.acp = { command: acpCommand };
    if (a2aUrl) agent.a2a = { url: a2aUrl };

    if (!config.agents) config.agents = {};
    config.agents[name] = agent;

    return {
      result: { status: "ok", agent },
      commitMessage: `add agent: ${name}`,
      changed: true,
    };
  });

  if (outcome.status === "missing-config") {
    requireConfig(null);
    return;
  }
  if (outcome.status === "duplicate") {
    error(`Agent "${name}" already exists. Remove it first or use a different name.`, opts);
    process.exitCode = 1;
    return;
  }

  info(`Added agent "${name}"`, opts);
  info(`Agent '${name}' added. Run \`am apply\` to generate native configs.`, opts);

  if (args.json) {
    output({ action: "add", entity: "agent", name, config: outcome.agent }, opts);
  }
}
