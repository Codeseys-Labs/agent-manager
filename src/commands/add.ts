import { access, readFile, stat } from "node:fs/promises";
import { isAbsolute, join, resolve as resolvePath } from "node:path";
import { defineCommand } from "citty";
import { resolveConfigDir } from "../core/config";
import { withConfig } from "../core/controller";
import { type HostPathFinding, scanBodyForHostPaths } from "../core/portability";
import type { AgentProfile, Command, Instruction, Server, Skill } from "../core/schema";
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
import { amError, error, info, output, warn } from "../lib/output";

const ENTITY_TYPES = ["server", "instruction", "skill", "agent", "command"] as const;
type EntityType = (typeof ENTITY_TYPES)[number];

const SERVER_TRANSPORTS = ["stdio", "sse", "streamable-http"] as const;
type ServerTransport = (typeof SERVER_TRANSPORTS)[number];

/**
 * Normalize a citty `--args` value into a flat string[]. The value may arrive
 * as a single string (`--args "-y,@scope/pkg"`), a repeated-flag array
 * (`--args -y --args @scope/pkg` → `["-y", "@scope/pkg"]`), or a mix where an
 * array element is itself comma-separated. Each string element is split on
 * commas, trimmed, and empty results dropped so every form yields the same
 * args[].
 */
function normalizeArgsList(raw: unknown): string[] {
  if (raw === undefined || raw === null) return [];
  const elements = Array.isArray(raw) ? raw : [raw];
  const out: string[] = [];
  for (const el of elements) {
    if (typeof el !== "string") continue;
    for (const part of el.split(",")) {
      const trimmed = part.trim();
      if (trimmed) out.push(trimmed);
    }
  }
  return out;
}

// Flags accepted by `am add server`. We scan the intact rawArgs token stream and
// reject any `--<longflag>` outside this set (plus the global flags below) to
// surface typos rather than silently swallowing them.
const SERVER_FLAGS = new Set(["command", "args", "transport", "url", "tags", "description", "env"]);
// Flags shared across every entity / supplied by the global CLI surface.
const GLOBAL_FLAGS = new Set(["project", "json", "quiet", "verbose"]);

/**
 * Collect every raw `--args` value from the intact citty `rawArgs` token stream.
 *
 * We cannot trust the post-mri `args` object for `--args`: a leading-dash value
 * (`--args "-y,pkg"` or `--args -y --args pkg`) is parsed by mri as a cluster of
 * short flags, so the real value is lost (mri stores `args=""`) and bogus
 * short-flag keys (`y`, `,`, `t`, ...) leak into the args object. The intact
 * rawArgs preserve the original tokens, so we reconstruct the values here:
 *   - `--args <value>`  → the next token (even if it begins with `-`)
 *   - `--args=<value>`  → the equals-form value
 * Order is preserved. The collected raw values are fed through
 * normalizeArgsList (comma-split + trim) by the caller.
 */
function collectRawArgsValues(rawArgs: string[]): string[] {
  const values: string[] = [];
  for (let i = 0; i < rawArgs.length; i++) {
    const token = rawArgs[i];
    if (token === "--args") {
      const next = rawArgs[i + 1];
      if (next !== undefined) {
        values.push(next);
        i++; // consume the value so it isn't re-scanned as a flag
      }
    } else if (token.startsWith("--args=")) {
      values.push(token.slice("--args=".length));
    }
  }
  return values;
}

/**
 * Scan the intact rawArgs token stream for unknown long flags. We must gate the
 * unknown-flag check off rawArgs rather than the post-mri args object because
 * mri explodes leading-dash `--args` values into bogus short-flag keys (`y`,
 * `,`, `t`, ...) that would otherwise be reported as unknown flags. Only
 * `--<longflag>` tokens not in the allowed/global sets count as unknown; the
 * value following `--args` (and any short-flag tokens) are ignored.
 */
function findUnknownRawFlags(rawArgs: string[], allowed: Set<string>): string[] {
  const unknown: string[] = [];
  for (let i = 0; i < rawArgs.length; i++) {
    const token = rawArgs[i];
    // Skip the value token immediately after `--args` so a leading-dash value
    // (e.g. `--args -y`) is never mistaken for a flag.
    if (token === "--args") {
      i++;
      continue;
    }
    if (!token.startsWith("--")) continue;
    // Strip `--` prefix and any `=value` suffix to get the bare flag name.
    const name = token.slice(2).split("=")[0];
    if (!name) continue; // bare `--` separator
    if (allowed.has(name) || GLOBAL_FLAGS.has(name)) continue;
    unknown.push(name);
  }
  return unknown;
}

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
    description: "Add an entity to the config (server, instruction, skill, agent, command)",
  },
  args: {
    _args: {
      type: "positional",
      description: "Entity type and name: `am add [server|instruction|skill|agent|command] <name>`",
      required: false,
    },
    command: { type: "string", description: "Command to run (stdio servers)" },
    args: {
      type: "string",
      description: "Server args — comma-separated and/or repeatable (servers)",
    },
    transport: {
      type: "string",
      description: "Server transport: stdio (default), sse, streamable-http (servers)",
      default: "stdio",
    },
    url: { type: "string", description: "Remote server URL (servers with transport != stdio)" },
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
    path: {
      type: "string",
      description:
        "Path to skill directory containing SKILL.md (skills); path to the command markdown file (commands)",
    },
    source: {
      type: "string",
      description: "Skill source: local:<path> (git+/marketplace sources not yet supported in v1)",
    },
    // Command flags (ADR-0058)
    from: {
      type: "string",
      description:
        "Path to a command markdown file with `kind: command` frontmatter — classifies deterministically (commands)",
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
  async run({ args, rawArgs }) {
    const opts = { json: args.json, quiet: args.quiet, verbose: args.verbose };

    // citty puts all positional args in args._ as an array
    const rawPositionals = ((args._ ?? []) as string[]).filter((s) => typeof s === "string");

    const { entity, name } = parseEntityAndName(rawPositionals);

    if (!name) {
      error(`Missing name. Usage: am add ${entity} <name>`, opts);
      process.exitCode = 1;
      return;
    }

    // citty's run context always supplies rawArgs; default to [] for the
    // synthetic-args call sites (tests) that invoke run() directly.
    const rawArgList = Array.isArray(rawArgs) ? rawArgs : [];

    try {
      switch (entity) {
        case "server":
          return await addServer(name, args, rawArgList, opts);
        case "instruction":
          return await addInstruction(name, args, opts);
        case "skill":
          return await addSkill(name, args, opts);
        case "agent":
          return await addAgent(name, args, opts);
        case "command":
          return await addCommandEntity(name, args, opts);
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
  rawArgs: string[],
  opts: { json?: boolean; quiet?: boolean; verbose?: boolean },
) {
  const configDir = resolveConfigDir();

  // Reject unknown flags rather than letting citty swallow them silently. We
  // scan the intact rawArgs token stream because mri explodes leading-dash
  // `--args` values into bogus short-flag keys on the parsed args object.
  const unknown = findUnknownRawFlags(rawArgs, SERVER_FLAGS);
  if (unknown.length > 0) {
    error(`Unknown flag: --${unknown[0]}`, opts);
    process.exitCode = 1;
    return;
  }

  // Validate transport against the discriminated-union enum.
  const transport = ((args.transport as string | undefined) ?? "stdio") as ServerTransport;
  if (!(SERVER_TRANSPORTS as readonly string[]).includes(transport)) {
    error(
      `Invalid --transport "${transport}". Must be one of: ${SERVER_TRANSPORTS.join(", ")}`,
      opts,
    );
    process.exitCode = 1;
    return;
  }

  const url = args.url as string | undefined;
  const isRemote = transport !== "stdio";

  if (isRemote) {
    if (!url) {
      error(
        `Missing --url. Usage: am add server <name> --transport ${transport} --url <url>`,
        opts,
      );
      process.exitCode = 1;
      return;
    }
  } else {
    // stdio (default): a command is required, and --url is meaningless.
    if (url) {
      error("--url is only valid with --transport sse or streamable-http.", opts);
      process.exitCode = 1;
      return;
    }
    if (!args.command) {
      error("Missing --command. Usage: am add server <name> --command <cmd>", opts);
      process.exitCode = 1;
      return;
    }
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

    // ServerBase.command is required on both variants; for remote transports
    // `am` stores the URL in `command` (export-utils reads it there) and also
    // sets the informational `url` field.
    const server: Server = isRemote
      ? ({
          command: url as string,
          transport,
          url: url as string,
          enabled: true,
        } as Server)
      : {
          command: args.command as string,
          transport: "stdio",
          enabled: true,
        };
    // Reconstruct `--args` from the intact rawArgs token stream so leading-dash
    // values (e.g. `--args "-y,pkg"`) survive mri's short-flag explosion. When
    // rawArgs carries no `--args` token (the synthetic-args call path used by
    // some tests), fall back to the mri-parsed `args.args` value.
    const rawArgsValues = collectRawArgsValues(rawArgs);
    const parsedArgs =
      rawArgsValues.length > 0 ? normalizeArgsList(rawArgsValues) : normalizeArgsList(args.args);
    if (parsedArgs.length > 0) server.args = parsedArgs;
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

/**
 * Read the YAML frontmatter of a command markdown file (ADR-0058). Reuses the
 * same frontmatter regex as readSkillDescription. Returns the declared `kind:`
 * and `description:` so the caller can REFUSE to guess: `am add command --from`
 * requires an explicit `kind: command` declaration rather than inferring the
 * artifact type. Returns undefined values (not throws) when a line is absent;
 * the file itself being unreadable surfaces as a null return.
 */
async function readCommandFrontmatter(
  mdPath: string,
): Promise<{ kind?: string; description?: string } | null> {
  let content: string;
  try {
    content = await readFile(mdPath, "utf-8");
  } catch {
    return null;
  }
  const result: { kind?: string; description?: string } = {};
  const fm = content.match(/^---\n([\s\S]*?)\n---/);
  if (fm) {
    for (const line of fm[1].split("\n")) {
      if (result.kind === undefined && /^kind\s*:/i.test(line)) {
        const val = line.split(":").slice(1).join(":").trim();
        const cleaned = val.replace(/^["']|["']$/g, "").trim();
        if (cleaned) result.kind = cleaned;
      }
      if (result.description === undefined && /^description\s*:/i.test(line)) {
        const val = line.split(":").slice(1).join(":").trim();
        const cleaned = val.replace(/^["']|["']$/g, "").trim();
        if (cleaned) result.description = cleaned;
      }
    }
  }
  return result;
}

/**
 * Read a file body and run the portability lint (R1/297e), emitting a warning
 * for each host-absolute path found. Best-effort: an unreadable file scans as
 * clean (the caller has already validated existence where it matters).
 *
 * Returns the findings so callers can include them in the JSON envelope.
 */
async function scanArtifactBodyForHostPaths(
  filePath: string,
  label: string,
  opts: { json?: boolean; quiet?: boolean; verbose?: boolean },
): Promise<HostPathFinding[]> {
  let findings: HostPathFinding[] = [];
  try {
    const content = await readFile(filePath, "utf-8");
    findings = scanBodyForHostPaths(content);
  } catch {
    return [];
  }
  for (const f of findings) {
    warn(
      `${label} contains a host-absolute path "${f.match}" (${f.kind}, line ${f.line}) — not portable across hosts/users.`,
      opts,
    );
  }
  return findings;
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

  // Portability lint (R1/297e): warn on host-absolute paths in the SKILL.md body.
  const portability = await scanArtifactBodyForHostPaths(skillMd, "SKILL.md", opts);

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
    output(
      {
        action: "add",
        entity: "skill",
        name,
        config: outcome.skill,
        ...(portability.length > 0 && { portability }),
      },
      opts,
    );
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

  // Validate prompt-file exists if supplied, then run the portability lint
  // (R1/297e) over its body so host-absolute paths surface at add time.
  let promptPortability: HostPathFinding[] = [];
  if (promptFile) {
    const resolved = isAbsolute(promptFile) ? promptFile : resolvePath(promptFile);
    if (!(await fileExists(resolved))) {
      error(`Prompt file does not exist: ${resolved}`, opts);
      process.exitCode = 1;
      return;
    }
    promptPortability = await scanArtifactBodyForHostPaths(resolved, "Prompt file", opts);
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
    output(
      {
        action: "add",
        entity: "agent",
        name,
        config: outcome.agent,
        ...(promptPortability.length > 0 && { portability: promptPortability }),
      },
      opts,
    );
  }
}

/**
 * `am add command <name> --path <file.md>` (or `--from <file.md>`).
 *
 * ADR-0058: `command` is the 6th catalog entity, modeled with an explicit
 * `type: "command"` literal discriminant. v1 scope is round-trip PERSISTENCE
 * ONLY — no resolver / profile-selection / adapter-export wiring (deferred).
 *
 * The `--from` path classifies DETERMINISTICALLY: the markdown file MUST carry
 * `kind: command` frontmatter. If `kind:` is absent or names a different kind,
 * we REFUSE rather than guess (the seed's bright line). `--path` records the
 * file location verbatim without reading it (parity with `am add skill`).
 */
async function addCommandEntity(
  name: string,
  args: Record<string, unknown>,
  opts: { json?: boolean; quiet?: boolean; verbose?: boolean },
) {
  const configDir = resolveConfigDir();

  const pathArg = args.path as string | undefined;
  const fromArg = args.from as string | undefined;

  if (!pathArg && !fromArg) {
    error(
      "Missing --path or --from. Usage: am add command <name> --path <file.md> (or --from <file.md>)",
      opts,
    );
    process.exitCode = 1;
    return;
  }

  if (pathArg && fromArg) {
    error("Provide --path or --from, not both.", opts);
    process.exitCode = 1;
    return;
  }

  // The recorded path: `--path` verbatim, `--from` is the source markdown file.
  let commandPath: string;
  let description = args.description as string | undefined;

  if (fromArg) {
    // `--from` requires a declared `kind: command` frontmatter so classification
    // is deterministic; we refuse to guess the artifact type from the body.
    const fm = await readCommandFrontmatter(fromArg);
    if (!fm) {
      error(`Command file does not exist or could not be read: ${fromArg}`, opts);
      process.exitCode = 1;
      return;
    }
    if (fm.kind !== "command") {
      error(
        fm.kind === undefined
          ? `--from file "${fromArg}" has no \`kind:\` frontmatter. Declare \`kind: command\` so the artifact type is explicit (am refuses to guess).`
          : `--from file "${fromArg}" declares \`kind: ${fm.kind}\`, not \`kind: command\`. am refuses to guess the artifact type.`,
        opts,
      );
      process.exitCode = 1;
      return;
    }
    commandPath = fromArg;
    if (!description) description = fm.description;
  } else {
    commandPath = pathArg as string;
  }

  if (!description) description = `Command: ${name}`;

  type Outcome =
    | { status: "ok"; command: Command }
    | { status: "duplicate" }
    | { status: "missing-config" };

  const outcome = await withConfig<Outcome>(configDir, async (config) => {
    if (!config) {
      return { result: { status: "missing-config" }, changed: false };
    }
    if (config.commands?.[name]) {
      return { result: { status: "duplicate" }, changed: false };
    }

    const command: Command = {
      type: "command",
      path: commandPath,
      description: description as string,
    };
    if (args.tags) command.tags = (args.tags as string).split(",").map((s) => s.trim());

    if (!config.commands) config.commands = {};
    config.commands[name] = command;

    return {
      result: { status: "ok", command },
      commitMessage: `add command: ${name}`,
      changed: true,
    };
  });

  if (outcome.status === "missing-config") {
    requireConfig(null);
    return;
  }
  if (outcome.status === "duplicate") {
    error(`Command "${name}" already exists. Remove it first or use a different name.`, opts);
    process.exitCode = 1;
    return;
  }

  info(`Added command "${name}"`, opts);

  if (args.json) {
    output({ action: "add", entity: "command", name, config: outcome.command }, opts);
  }
}
