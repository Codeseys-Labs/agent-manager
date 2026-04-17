import { join } from "node:path";
import { defineCommand } from "citty";
import { resolveConfigDir, tryReadConfig, writeConfig } from "../core/config";
import { commitAll } from "../core/git";
import type { Instruction, Server } from "../core/schema";
import { scanServerForSecrets, substituteSecret } from "../core/secret-detection";
import {
  encryptValue,
  generateKey,
  importKey,
  loadKey,
  resolveKeyPath,
  saveKey,
} from "../core/secrets";
import { requireConfig } from "../lib/errors";
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
          return addStub("skill", name, opts);
        case "agent":
          return addStub("agent", name, opts);
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
  const configPath = join(configDir, "config.toml");

  if (!args.command) {
    error("Missing --command. Usage: am add server <name> --command <cmd>", opts);
    process.exitCode = 1;
    return;
  }

  const config = await tryReadConfig(configPath);
  requireConfig(config);

  // Check for duplicate
  if (config.servers?.[name]) {
    error(`Server "${name}" already exists. Remove it first or use a different name.`, opts);
    process.exitCode = 1;
    return;
  }

  // Build server entry
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

  // Add to config
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
      substituteSecret(server, secret, secret.suggestedEnvVar);
      if (!config.settings) config.settings = {};
      if (!config.settings.env) config.settings.env = {};
      config.settings.env[secret.suggestedEnvVar] = await encryptValue(secret.value, key);
      secretsEncrypted++;
    }
  }

  await writeConfig(configPath, config);

  // Auto-commit
  const tagStr = server.tags?.length ? ` (${server.tags.join(", ")})` : "";
  try {
    await commitAll(configDir, `add server: ${name}${tagStr}`);
  } catch {
    // Nothing to commit is fine
  }

  info(`Added server "${name}"`, opts);
  if (secretsEncrypted > 0 && !args.json) {
    info(`  Encrypted ${secretsEncrypted} secret(s) — values use \${VAR} references now.`, opts);
  }

  if (args.json) {
    output(
      {
        action: "add",
        entity: "server",
        name,
        config: server,
        secretsEncrypted: secretsEncrypted > 0 ? secretsEncrypted : undefined,
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
  const configPath = join(configDir, "config.toml");

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

  const config = await tryReadConfig(configPath);
  requireConfig(config);

  if (config.instructions?.[name]) {
    error(`Instruction "${name}" already exists. Remove it first or use a different name.`, opts);
    process.exitCode = 1;
    return;
  }

  const instruction: Instruction = {
    scope: scope as Instruction["scope"],
    ...(content ? { content } : {}),
    ...(contentFile ? { content_file: contentFile } : {}),
  };
  if (args.description) instruction.description = args.description as string;
  if (args.globs) instruction.globs = (args.globs as string).split(",").map((s) => s.trim());
  if (args.targets) instruction.targets = (args.targets as string).split(",").map((s) => s.trim());

  if (!config.instructions) config.instructions = {};
  config.instructions[name] = instruction;

  await writeConfig(configPath, config);

  try {
    await commitAll(configDir, `add instruction: ${name}`);
  } catch {
    // Nothing to commit is fine
  }

  info(`Added instruction "${name}" (scope: ${scope})`, opts);

  if (args.json) {
    output({ action: "add", entity: "instruction", name, config: instruction }, opts);
  }
}

function addStub(
  entity: string,
  name: string,
  opts: { json?: boolean; quiet?: boolean; verbose?: boolean },
) {
  info(`Adding ${entity}s is coming soon. Use config.toml to add "${name}" manually.`, opts);
  if (opts.json) {
    output({ action: "add", entity, name, status: "not_implemented" }, opts);
  }
}
