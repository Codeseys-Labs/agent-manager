import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildResolvedConfig,
  loadResolvedConfig,
  mergeConfigs,
  projectToConfig,
  readConfig,
  readProjectConfig,
  resolveConfigDir,
  tryReadConfig,
  writeConfig,
} from "../../src/core/config";
import { type Config, ServerSchema } from "../../src/core/schema";
import { AmError } from "../../src/lib/errors";
import { toPosix } from "../helpers/path";

const FIXTURES = join(import.meta.dir, "..", "fixtures");

describe("resolveConfigDir", () => {
  const origEnv = process.env.AM_CONFIG_DIR;

  afterEach(() => {
    if (origEnv === undefined) {
      // Windows portability: `process.env.X = undefined` coerces to the STRING
      // "undefined" on Windows (truthy), so `resolveConfigDir()`'s `?? join(...)`
      // never fires and returns "undefined". POSIX Bun deletes it instead.
      // `Reflect.deleteProperty` genuinely unsets on every platform.
      Reflect.deleteProperty(process.env, "AM_CONFIG_DIR");
    } else {
      process.env.AM_CONFIG_DIR = origEnv;
    }
  });

  test("returns AM_CONFIG_DIR when set", () => {
    process.env.AM_CONFIG_DIR = "/tmp/custom-am";
    expect(resolveConfigDir()).toBe("/tmp/custom-am");
  });

  test("returns default path when AM_CONFIG_DIR is not set", () => {
    Reflect.deleteProperty(process.env, "AM_CONFIG_DIR");
    const result = resolveConfigDir();
    // The default config dir is ~/.config/agent-manager on EVERY platform (it
    // is a git repo, ADR-0002). node:path.join emits the host separator, so
    // normalize to POSIX before the forward-slash suffix assert.
    expect(toPosix(result)).toEndWith("/.config/agent-manager");
  });
});

describe("readConfig", () => {
  test("reads and validates valid-config.toml", async () => {
    const config = await readConfig(join(FIXTURES, "valid-config.toml"));
    expect(config.settings?.default_profile).toBe("work");
    expect(config.servers?.fetch.command).toBe("uvx mcp-server-fetch");
    expect(config.servers?.outlook.command).toBe("aws-outlook-mcp");
    expect(config.servers?.outlook.tags).toEqual(["email", "calendar", "work"]);
    expect(config.skills?.["research-rabbithole"].path).toBe("skills/research-rabbithole");
    expect(config.instructions?.["typescript-conventions"].scope).toBe("glob");
    expect(config.profiles?.base.servers).toEqual(["fetch"]);
    expect(config.profiles?.work.inherits).toBe("base");
    expect(config.adapters?.["claude-code"]).toEqual({ permission_mode: "allowEdits" });
  });

  test("throws on nonexistent file", async () => {
    await expect(readConfig("/nonexistent/path.toml")).rejects.toThrow();
  });
});

describe("readProjectConfig", () => {
  test("reads and validates valid-project.toml", async () => {
    const config = await readProjectConfig(join(FIXTURES, "valid-project.toml"));
    expect(config.profile).toBe("work");
    expect(config.project?.name).toBe("ADMINISTRIVIA");
    expect(config.project?.description).toBe("Personal productivity vault");
    expect(config.servers?.wiki.command).toBe("amazon-wiki-mcp");
    expect(config.instructions?.["vault-conventions"].scope).toBe("always");
  });
});

// ws-config-load-errors (seed agent-manager-8cce): parse/schema failures must
// surface as TYPED AmErrors (CONFIG_PARSE_ERROR / CONFIG_SCHEMA_ERROR) rather
// than being collapsed to "not found". ENOENT still maps to null in
// tryReadConfig (unchanged contract) so callers can distinguish the three.
describe("tryReadConfig — error classification", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "am-cfg-err-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  test("(a) missing file returns null", async () => {
    const result = await tryReadConfig(join(tmpDir, "does-not-exist.toml"));
    expect(result).toBeNull();
  });

  test("(b) malformed TOML throws CONFIG_PARSE_ERROR (not null, not CONFIG_NOT_FOUND)", async () => {
    const { writeFile } = await import("node:fs/promises");
    const path = join(tmpDir, "config.toml");
    // Unterminated table header / stray tokens — a TOML syntax error.
    await writeFile(path, "this is = = not valid toml\n[unclosed\n");

    let caught: unknown;
    try {
      await tryReadConfig(path);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(AmError);
    expect((caught as AmError).code).toBe("CONFIG_PARSE_ERROR");
    expect((caught as AmError).code).not.toBe("CONFIG_NOT_FOUND");
    // The parser's row/col detail is carried through as the suggestion.
    expect((caught as AmError).message).toContain(path);
    expect((caught as AmError).suggestion).toMatch(/row|col/i);
  });

  test("(c) schema-invalid TOML throws CONFIG_SCHEMA_ERROR", async () => {
    const { writeFile } = await import("node:fs/promises");
    const path = join(tmpDir, "config.toml");
    // Valid TOML, but `scope` violates the InstructionSchema enum.
    await writeFile(
      path,
      ["[instructions.bad]", 'content = "x"', 'scope = "nonsense"', ""].join("\n"),
    );

    let caught: unknown;
    try {
      await tryReadConfig(path);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(AmError);
    expect((caught as AmError).code).toBe("CONFIG_SCHEMA_ERROR");
    expect((caught as AmError).code).not.toBe("CONFIG_NOT_FOUND");
    expect((caught as AmError).message).toContain(path);
    // First failing field path is surfaced as the suggestion.
    expect((caught as AmError).suggestion).toContain("scope");
  });

  test("valid TOML still parses through tryReadConfig", async () => {
    const config = await tryReadConfig(join(FIXTURES, "valid-config.toml"));
    expect(config).not.toBeNull();
    expect(config?.settings?.default_profile).toBe("work");
  });
});

describe("writeConfig", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "am-test-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  test("writes config that roundtrips through readConfig", async () => {
    const original = await readConfig(join(FIXTURES, "valid-config.toml"));
    const outPath = join(tmpDir, "roundtrip.toml");
    await writeConfig(outPath, original);
    const reread = await readConfig(outPath);

    expect(reread.settings?.default_profile).toBe(original.settings?.default_profile);
    expect(reread.servers?.fetch.command).toBe(original.servers?.fetch.command);
    expect(reread.servers?.outlook.command).toBe(original.servers?.outlook.command);
    expect(reread.skills?.["research-rabbithole"].path).toBe(
      original.skills?.["research-rabbithole"].path,
    );
    expect(reread.profiles?.work.inherits).toBe(original.profiles?.work.inherits);
  });

  // ADR-0058: commands is the 6th catalog entity. serializeConfig MUST carry
  // it through or the data is silently dropped on the first write. This guards
  // that bright line — write a commands record, re-read, assert it survives.
  test("round-trips a commands record (silent-data-loss guard)", async () => {
    const config: Config = {
      settings: { default_profile: "default" },
      commands: {
        deploy: {
          type: "command",
          path: "commands/deploy.md",
          description: "Deploy the project",
          tags: ["ops"],
        },
      },
    };
    const outPath = join(tmpDir, "commands-roundtrip.toml");
    await writeConfig(outPath, config);
    const reread = await readConfig(outPath);

    expect(reread.commands?.deploy).toBeDefined();
    expect(reread.commands?.deploy.type).toBe("command");
    expect(reread.commands?.deploy.path).toBe("commands/deploy.md");
    expect(reread.commands?.deploy.description).toBe("Deploy the project");
    expect(reread.commands?.deploy.tags).toEqual(["ops"]);
  });

  test("preserves section ordering in output", async () => {
    const config: Config = {
      adapters: { "claude-code": { foo: "bar" } },
      settings: { default_profile: "test" },
      servers: { s: { command: "test", transport: "stdio", enabled: true } },
      profiles: { p: { servers: ["s"] } },
      instructions: { i: { content: "do it", scope: "always" } },
      skills: { k: { path: "sk", description: "skill" } },
    };
    const outPath = join(tmpDir, "ordered.toml");
    await writeConfig(outPath, config);

    const raw = await readFile(outPath, "utf-8");
    const settingsPos = raw.indexOf("[settings]");
    const serversPos = raw.indexOf("[servers");
    const skillsPos = raw.indexOf("[skills");
    const instructionsPos = raw.indexOf("[instructions");
    const profilesPos = raw.indexOf("[profiles");
    const adaptersPos = raw.indexOf("[adapters");

    // settings → servers → skills → instructions → profiles → adapters
    expect(settingsPos).toBeLessThan(serversPos);
    expect(serversPos).toBeLessThan(skillsPos);
    expect(skillsPos).toBeLessThan(instructionsPos);
    expect(instructionsPos).toBeLessThan(profilesPos);
    expect(profilesPos).toBeLessThan(adaptersPos);
  });
});

describe("mergeConfigs", () => {
  test("merges servers as union", () => {
    const a: Config = {
      servers: { fetch: { command: "fetch", transport: "stdio", enabled: true } },
    };
    const b: Config = {
      servers: { outlook: { command: "outlook", transport: "stdio", enabled: true } },
    };
    const merged = mergeConfigs(a, b);
    expect(merged.servers?.fetch).toBeDefined();
    expect(merged.servers?.outlook).toBeDefined();
  });

  test("higher precedence server overrides same-name server", () => {
    const a: Config = {
      servers: { s: { command: "old", transport: "stdio", enabled: true } },
    };
    const b: Config = {
      servers: { s: { command: "new", transport: "stdio", enabled: true } },
    };
    const merged = mergeConfigs(a, b);
    expect(merged.servers?.s.command).toBe("new");
  });

  test("merges skills as union", () => {
    const a: Config = {
      skills: { sk1: { path: "sk1", description: "Skill 1" } },
    };
    const b: Config = {
      skills: { sk2: { path: "sk2", description: "Skill 2" } },
    };
    const merged = mergeConfigs(a, b);
    expect(merged.skills?.sk1).toBeDefined();
    expect(merged.skills?.sk2).toBeDefined();
  });

  test("merges instructions as union", () => {
    const a: Config = {
      instructions: { i1: { content: "Rule 1", scope: "always" } },
    };
    const b: Config = {
      instructions: { i2: { content: "Rule 2", scope: "always" } },
    };
    const merged = mergeConfigs(a, b);
    expect(merged.instructions?.i1).toBeDefined();
    expect(merged.instructions?.i2).toBeDefined();
  });

  test("merges commands as union (ADR-0058)", () => {
    const a: Config = {
      commands: { deploy: { type: "command", path: "commands/deploy.md", description: "Deploy" } },
    };
    const b: Config = {
      commands: { lint: { type: "command", path: "commands/lint.md", description: "Lint" } },
    };
    const merged = mergeConfigs(a, b);
    expect(merged.commands?.deploy).toBeDefined();
    expect(merged.commands?.lint).toBeDefined();
  });

  test("settings shallow merge — higher precedence key wins", () => {
    const a: Config = {
      settings: { default_profile: "base", mcp_serve: { allow_push: false } },
    };
    const b: Config = {
      settings: { default_profile: "work" },
    };
    const merged = mergeConfigs(a, b);
    expect(merged.settings?.default_profile).toBe("work");
    expect(merged.settings?.mcp_serve).toEqual({ allow_push: false });
  });

  test("merges agents as union", () => {
    const a: Config = {
      agents: { reviewer: { name: "reviewer", description: "Code reviewer" } },
    };
    const b: Config = {
      agents: { deployer: { name: "deployer", description: "Deploy agent" } },
    };
    const merged = mergeConfigs(a, b);
    expect(merged.agents?.reviewer).toBeDefined();
    expect(merged.agents?.deployer).toBeDefined();
  });

  test("higher precedence agent overrides same-name agent", () => {
    const a: Config = {
      agents: { reviewer: { name: "reviewer", description: "Old reviewer" } },
    };
    const b: Config = {
      agents: { reviewer: { name: "reviewer", description: "New reviewer", model: "o3" } },
    };
    const merged = mergeConfigs(a, b);
    expect(merged.agents?.reviewer.description).toBe("New reviewer");
    expect(merged.agents?.reviewer.model).toBe("o3");
  });

  test("adapters shallow merge", () => {
    const a: Config = {
      adapters: { "claude-code": { permission_mode: "allowEdits" } },
    };
    const b: Config = {
      adapters: { cursor: { always_allow_read: true } },
    };
    const merged = mergeConfigs(a, b);
    expect(merged.adapters?.["claude-code"]).toEqual({ permission_mode: "allowEdits" });
    expect(merged.adapters?.cursor).toEqual({ always_allow_read: true });
  });

  // M12 (data-loss): a higher layer that restates only ONE field of a
  // same-named entry MUST NOT drop the sibling fields the lower layer set.
  // The old shallow-spread `{ ...a.servers, ...b.servers }` replaced the whole
  // entry wholesale, silently nuking command/args/env/transport. Same-named
  // entries deep-merge at the field grain: `{ ...a[key], ...b[key] }`.
  test("partial server override preserves sibling fields from lower layer", () => {
    const a: Config = {
      servers: {
        foo: {
          command: "foo-mcp",
          args: ["--port", "8080"],
          env: { TOKEN: "${TOKEN}" },
          transport: "stdio",
          enabled: true,
          tags: ["work"],
        },
      },
    };
    // Higher layer flips ONLY enabled. Everything else must survive.
    const b: Config = {
      servers: { foo: { command: "foo-mcp", transport: "stdio", enabled: false } },
    };
    const merged = mergeConfigs(a, b);
    expect(merged.servers?.foo.enabled).toBe(false);
    expect(merged.servers?.foo.command).toBe("foo-mcp");
    expect(merged.servers?.foo.args).toEqual(["--port", "8080"]);
    expect(merged.servers?.foo.env).toEqual({ TOKEN: "${TOKEN}" });
    expect(merged.servers?.foo.tags).toEqual(["work"]);
  });

  test("higher-layer set field still wins on a same-named entry", () => {
    const a: Config = {
      servers: { foo: { command: "old-cmd", transport: "stdio", enabled: true } },
    };
    const b: Config = {
      servers: { foo: { command: "new-cmd", transport: "stdio", enabled: true } },
    };
    const merged = mergeConfigs(a, b);
    expect(merged.servers?.foo.command).toBe("new-cmd");
  });

  test("partial agent override preserves sibling fields from lower layer", () => {
    const a: Config = {
      agents: {
        reviewer: {
          name: "reviewer",
          description: "Code reviewer",
          model: "sonnet",
          tools: ["Read", "Grep"],
        },
      },
    };
    // Higher layer changes ONLY the model.
    const b: Config = {
      agents: { reviewer: { name: "reviewer", model: "o3" } },
    };
    const merged = mergeConfigs(a, b);
    expect(merged.agents?.reviewer.model).toBe("o3");
    expect(merged.agents?.reviewer.description).toBe("Code reviewer");
    expect(merged.agents?.reviewer.tools).toEqual(["Read", "Grep"]);
  });

  test("partial instruction override preserves sibling fields", () => {
    const a: Config = {
      instructions: {
        rule: { content: "Do the thing", scope: "glob", globs: ["*.ts"], description: "tsrule" },
      },
    };
    const b: Config = {
      instructions: { rule: { content: "Do the thing", scope: "always" } },
    };
    const merged = mergeConfigs(a, b);
    expect(merged.instructions?.rule.scope).toBe("always");
    expect(merged.instructions?.rule.globs).toEqual(["*.ts"]);
    expect(merged.instructions?.rule.description).toBe("tsrule");
  });

  test("partial skill override preserves sibling fields", () => {
    const a: Config = {
      skills: {
        research: { path: "skills/research", description: "Deep research", tags: ["web"] },
      },
    };
    const b: Config = {
      skills: { research: { path: "skills/research", description: "Updated description" } },
    };
    const merged = mergeConfigs(a, b);
    expect(merged.skills?.research.description).toBe("Updated description");
    expect(merged.skills?.research.path).toBe("skills/research");
    expect(merged.skills?.research.tags).toEqual(["web"]);
  });

  test("union of distinct same-map entries is unaffected by deep-merge", () => {
    const a: Config = {
      servers: { fetch: { command: "fetch", transport: "stdio", enabled: true } },
    };
    const b: Config = {
      servers: { outlook: { command: "outlook", transport: "stdio", enabled: true } },
    };
    const merged = mergeConfigs(a, b);
    expect(merged.servers?.fetch.command).toBe("fetch");
    expect(merged.servers?.outlook.command).toBe("outlook");
  });

  // seed 1fcc (data-loss): the field-grain deep-merge is transport-blind, so a
  // remote lower layer ({ transport: "sse", url }) restated as stdio by a higher
  // layer ({ command, transport: "stdio" }) leaves a stale `url` on the merged
  // stdio entry. StdioServerSchema forbids `url` (z.undefined()), so the merged
  // server is schema-INVALID and loadResolvedConfig does NOT re-validate — the
  // dead remote endpoint flows downstream silently. mergeConfigs must shed the
  // url once the merged entry resolves to stdio (mirroring merge.ts/mergeServers).
  test("remote->stdio transport change drops the stale url (seed 1fcc)", () => {
    const a: Config = {
      servers: {
        x: {
          command: "https://host.example/sse",
          transport: "sse",
          url: "https://host.example/sse",
          enabled: true,
        },
      },
    };
    // Higher layer restates the same server as stdio (command, no url).
    const b: Config = {
      servers: { x: { command: "stdio-mcp", transport: "stdio", enabled: true } },
    };
    const merged = mergeConfigs(a, b);

    // The merged entry must NOT carry the inherited remote url.
    expect(merged.servers?.x.transport).toBe("stdio");
    expect("url" in (merged.servers?.x ?? {})).toBe(false);
    expect(merged.servers?.x.command).toBe("stdio-mcp");

    // And it must round-trip through the schema cleanly (the symptom of the bug).
    const parsed = ServerSchema.safeParse(merged.servers?.x);
    expect(parsed.success).toBe(true);
  });

  // Companion guard: a remote->remote restatement (or a higher layer that omits
  // transport but keeps it remote) must KEEP its url — the reconciliation only
  // fires for stdio results, never strips a legitimate remote endpoint.
  test("remote server keeps its url across a same-transport merge", () => {
    const a: Config = {
      servers: {
        x: {
          command: "https://host.example/sse",
          transport: "sse",
          url: "https://host.example/sse",
          enabled: true,
        },
      },
    };
    // Higher layer flips only `enabled`, leaving transport/url implicit.
    const b: Config = {
      servers: { x: { command: "https://host.example/sse", transport: "sse", enabled: false } },
    };
    const merged = mergeConfigs(a, b);

    expect(merged.servers?.x.transport).toBe("sse");
    expect(merged.servers?.x.url).toBe("https://host.example/sse");
    expect(merged.servers?.x.enabled).toBe(false);
    expect(ServerSchema.safeParse(merged.servers?.x).success).toBe(true);
  });
});

describe("loadResolvedConfig", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "am-resolved-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  test("merges global + project configs", async () => {
    const config = await loadResolvedConfig({
      configDir: FIXTURES,
      configFile: "valid-config.toml",
      projectFile: join(FIXTURES, "valid-project.toml"),
    });

    // Global servers present
    expect(config.servers?.fetch).toBeDefined();
    expect(config.servers?.outlook).toBeDefined();
    // Project server added
    expect(config.servers?.wiki).toBeDefined();
    // Global instructions present
    expect(config.instructions?.["typescript-conventions"]).toBeDefined();
    // Project instructions added
    expect(config.instructions?.["vault-conventions"]).toBeDefined();
  });

  test("works with global config only (no project)", async () => {
    const config = await loadResolvedConfig({
      configDir: FIXTURES,
      configFile: "valid-config.toml",
    });
    expect(config.servers?.fetch).toBeDefined();
    expect(config.servers?.outlook).toBeDefined();
    expect(config.servers?.wiki).toBeUndefined();
  });

  test("merges local overrides", async () => {
    // Write a config.local.toml that overrides default_profile
    const { writeFile } = await import("node:fs/promises");
    const TOML = await import("@iarna/toml");

    await writeFile(
      join(tmpDir, "config.toml"),
      TOML.stringify({
        settings: { default_profile: "base" },
        servers: {
          fetch: { command: "uvx mcp-server-fetch" },
        },
      } as any),
    );
    await writeFile(
      join(tmpDir, "config.local.toml"),
      TOML.stringify({
        settings: { default_profile: "local-override" },
      } as any),
    );

    const config = await loadResolvedConfig({
      configDir: tmpDir,
      configFile: "config.toml",
    });
    expect(config.settings?.default_profile).toBe("local-override");
    // Original server still there
    expect(config.servers?.fetch).toBeDefined();
  });
});

describe("loadResolvedConfig — full 4-layer hierarchy", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "am-hierarchy-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  test("global -> global.local -> project -> project.local, highest layer wins", async () => {
    const { writeFile: wf } = await import("node:fs/promises");
    const TOML = await import("@iarna/toml");

    // Layer 1: global config.toml
    await wf(
      join(tmpDir, "config.toml"),
      TOML.stringify({
        settings: { default_profile: "base" },
        servers: {
          fetch: { command: "uvx mcp-server-fetch" },
          tavily: { command: "tavily-mcp", enabled: true },
        },
        instructions: {
          "rule-a": { content: "Global rule A", scope: "always" },
        },
      } as any),
    );

    // Layer 2: global config.local.toml (overrides settings + adds server)
    await wf(
      join(tmpDir, "config.local.toml"),
      TOML.stringify({
        settings: { default_profile: "local-override" },
        servers: {
          "local-server": { command: "local-mcp" },
        },
      } as any),
    );

    // Layer 3: project .agent-manager.toml
    const projPath = join(tmpDir, ".agent-manager.toml");
    await wf(
      projPath,
      TOML.stringify({
        profile: "work",
        servers: {
          wiki: { command: "amazon-wiki-mcp" },
          tavily: { command: "tavily-mcp-v2", enabled: false }, // overrides global tavily
        },
        instructions: {
          "rule-b": { content: "Project rule B", scope: "always" },
        },
      } as any),
    );

    // Layer 4: project .agent-manager.local.toml
    const projLocalPath = join(tmpDir, ".agent-manager.local.toml");
    await wf(
      projLocalPath,
      TOML.stringify({
        servers: {
          "local-project-server": { command: "secret-mcp" },
        },
        instructions: {
          "rule-b": { content: "Project-local overrides rule B", scope: "always" },
        },
      } as any),
    );

    const config = await loadResolvedConfig({
      configDir: tmpDir,
      configFile: "config.toml",
      projectFile: projPath,
    });

    // Settings: global.local overrides global
    expect(config.settings?.default_profile).toBe("local-override");

    // Servers: union of all 4 layers, higher layers win on same-name
    expect(config.servers?.fetch).toBeDefined(); // from global
    expect(config.servers?.["local-server"]).toBeDefined(); // from global.local
    expect(config.servers?.wiki).toBeDefined(); // from project
    expect(config.servers?.["local-project-server"]).toBeDefined(); // from project.local
    // tavily: project overrides global
    expect(config.servers?.tavily.command).toBe("tavily-mcp-v2");
    expect(config.servers?.tavily.enabled).toBe(false);

    // Instructions: project.local overrides project for rule-b
    expect(config.instructions?.["rule-a"]?.content).toBe("Global rule A");
    expect(config.instructions?.["rule-b"]?.content).toBe("Project-local overrides rule B");
  });

  // M12 (data-loss): a project.local layer that toggles a single field of a
  // globally-defined server must keep the global command/args/env, not nuke
  // them. This is the real-world shape of the partial-override bug across the
  // 4-layer hierarchy.
  test("project-local partial override keeps globally-defined sibling fields", async () => {
    const { writeFile: wf } = await import("node:fs/promises");
    const TOML = await import("@iarna/toml");

    // Layer 1: global config.toml defines a fully-specified server.
    await wf(
      join(tmpDir, "config.toml"),
      TOML.stringify({
        servers: {
          gateway: {
            command: "gateway-mcp",
            args: ["--region", "us-east-1"],
            env: { API_KEY: "${API_KEY}" },
            enabled: true,
            tags: ["infra"],
          },
        },
      } as any),
    );

    // Layer 4: project .agent-manager.local.toml flips ONLY enabled.
    const projPath = join(tmpDir, ".agent-manager.toml");
    await wf(projPath, TOML.stringify({ profile: "work" } as any));
    const projLocalPath = join(tmpDir, ".agent-manager.local.toml");
    await wf(
      projLocalPath,
      TOML.stringify({
        servers: { gateway: { command: "gateway-mcp", enabled: false } },
      } as any),
    );

    const config = await loadResolvedConfig({
      configDir: tmpDir,
      configFile: "config.toml",
      projectFile: projPath,
    });

    expect(config.servers?.gateway.enabled).toBe(false);
    // Sibling fields from the global layer survive the partial override.
    expect(config.servers?.gateway.command).toBe("gateway-mcp");
    expect(config.servers?.gateway.args).toEqual(["--region", "us-east-1"]);
    expect(config.servers?.gateway.env).toEqual({ API_KEY: "${API_KEY}" });
    expect(config.servers?.gateway.tags).toEqual(["infra"]);
  });
});

describe("projectToConfig", () => {
  test("projectToConfig preserves agents", () => {
    const proj = { agents: { reviewer: { name: "reviewer", description: "Code reviewer" } } };
    const config = projectToConfig(proj as any);
    expect(config.agents?.reviewer).toBeDefined();
  });

  test("projectToConfig preserves commands (ADR-0058)", () => {
    const proj = {
      commands: { deploy: { type: "command", path: "commands/deploy.md", description: "Deploy" } },
    };
    const config = projectToConfig(proj as any);
    expect(config.commands?.deploy).toBeDefined();
    expect(config.commands?.deploy.type).toBe("command");
  });
});

describe("buildResolvedConfig", () => {
  test("maps instructions with all fields", () => {
    const config: Config = {
      instructions: {
        "ts-rules": {
          content: "Use strict mode",
          scope: "glob",
          description: "TypeScript rules",
          globs: ["*.ts"],
          targets: ["claude-code", "cursor"],
        },
      },
    };
    const resolved = buildResolvedConfig(config, "default");
    const instr = resolved.instructions["ts-rules"];
    expect(instr.name).toBe("ts-rules");
    expect(instr.content).toBe("Use strict mode");
    expect(instr.scope).toBe("glob");
    expect(instr.description).toBe("TypeScript rules");
    expect(instr.globs).toEqual(["*.ts"]);
    expect(instr.targets).toEqual(["claude-code", "cursor"]);
  });

  test("maps skills with all fields", () => {
    const config: Config = {
      skills: {
        research: {
          path: "skills/research",
          description: "Deep research skill",
          tags: ["research", "web"],
        },
      },
    };
    const resolved = buildResolvedConfig(config, "default");
    const skill = resolved.skills.research;
    expect(skill.name).toBe("research");
    expect(skill.path).toBe("skills/research");
    expect(skill.description).toBe("Deep research skill");
    expect(skill.tags).toEqual(["research", "web"]);
  });

  test("maps agents with all fields", () => {
    const config: Config = {
      agents: {
        reviewer: {
          name: "reviewer",
          description: "Code reviewer",
          model: "o3",
          tools: ["Read", "Grep"],
          disallowed_tools: ["Write"],
          mcp_servers: ["fetch"],
          max_turns: 5,
        },
      },
    };
    const resolved = buildResolvedConfig(config, "work");
    const agent = resolved.agents.reviewer;
    expect(agent.name).toBe("reviewer");
    expect(agent.description).toBe("Code reviewer");
    expect(agent.model).toBe("o3");
    expect(agent.tools).toEqual(["Read", "Grep"]);
    expect(agent.disallowed_tools).toEqual(["Write"]);
    expect(agent.mcp_servers).toEqual(["fetch"]);
    expect(agent.max_turns).toBe(5);
  });

  test("empty config returns empty records", () => {
    const resolved = buildResolvedConfig({}, "empty");
    expect(Object.keys(resolved.servers)).toHaveLength(0);
    expect(Object.keys(resolved.instructions)).toHaveLength(0);
    expect(Object.keys(resolved.skills)).toHaveLength(0);
    expect(Object.keys(resolved.agents)).toHaveLength(0);
    expect(resolved.profile).toBe("empty");
  });

  test("resolves content_file to file contents when configDir is provided", async () => {
    const { writeFileSync, mkdtempSync, rmSync } = await import("node:fs");
    const tmpDir = mkdtempSync(join(tmpdir(), "am-content-file-"));
    try {
      writeFileSync(join(tmpDir, "rules.md"), "Always use semicolons", "utf-8");
      const config: Config = {
        instructions: {
          "style-guide": {
            content_file: "rules.md",
            scope: "always",
          },
        },
      };
      const resolved = buildResolvedConfig(config, "default", tmpDir);
      expect(resolved.instructions["style-guide"].content).toBe("Always use semicolons");
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("content_file is ignored when content is already set", async () => {
    const config: Config = {
      instructions: {
        "inline-rule": {
          content: "Inline content wins",
          scope: "always",
        },
      },
    };
    const resolved = buildResolvedConfig(config, "default", "/nonexistent");
    expect(resolved.instructions["inline-rule"].content).toBe("Inline content wins");
  });

  test("content_file returns empty when configDir is not provided", () => {
    const config: Config = {
      instructions: {
        "no-dir": {
          content_file: "rules.md",
          scope: "always",
        },
      },
    };
    const resolved = buildResolvedConfig(config, "default");
    expect(resolved.instructions["no-dir"].content).toBe("");
  });

  test("filters servers by active profile", () => {
    const config: Config = {
      servers: {
        tavily: { command: "tavily-mcp", transport: "stdio", enabled: true, tags: ["search"] },
        outlook: { command: "outlook-mcp", transport: "stdio", enabled: true, tags: ["work"] },
        fetch: { command: "fetch-mcp", transport: "stdio", enabled: true },
      },
      profiles: {
        work: { servers: ["tavily"] },
      },
    };
    const resolved = buildResolvedConfig(config, "work");
    expect(Object.keys(resolved.servers)).toEqual(["tavily"]);
  });

  test("returns all servers when profile does not exist", () => {
    const config: Config = {
      servers: {
        tavily: { command: "tavily-mcp", transport: "stdio", enabled: true },
        outlook: { command: "outlook-mcp", transport: "stdio", enabled: true },
      },
      profiles: {
        work: { servers: ["tavily"] },
      },
    };
    const resolved = buildResolvedConfig(config, "nonexistent");
    expect(Object.keys(resolved.servers)).toHaveLength(2);
    expect(resolved.servers.tavily).toBeDefined();
    expect(resolved.servers.outlook).toBeDefined();
  });

  test("returns all servers when profile lists no servers", () => {
    const config: Config = {
      servers: {
        tavily: { command: "tavily-mcp", transport: "stdio", enabled: true },
        outlook: { command: "outlook-mcp", transport: "stdio", enabled: true },
      },
      profiles: {
        minimal: {},
      },
    };
    const resolved = buildResolvedConfig(config, "minimal");
    expect(Object.keys(resolved.servers)).toHaveLength(2);
  });

  test("filters instructions, skills, and agents by active profile", () => {
    const config: Config = {
      servers: {
        tavily: { command: "tavily-mcp", transport: "stdio", enabled: true },
      },
      instructions: {
        "ts-rules": { content: "Use strict mode", scope: "always" },
        "py-rules": { content: "Use black", scope: "always" },
      },
      skills: {
        research: { path: "skills/research", description: "Research" },
        deploy: { path: "skills/deploy", description: "Deploy" },
      },
      agents: {
        reviewer: { name: "reviewer", description: "Reviewer" },
        deployer: { name: "deployer", description: "Deployer" },
      },
      profiles: {
        focused: {
          servers: ["tavily"],
          instructions: ["ts-rules"],
          skills: ["research"],
          agents: ["reviewer"],
        },
      },
    };
    const resolved = buildResolvedConfig(config, "focused");
    expect(Object.keys(resolved.servers)).toEqual(["tavily"]);
    expect(Object.keys(resolved.instructions)).toEqual(["ts-rules"]);
    expect(Object.keys(resolved.skills)).toEqual(["research"]);
    expect(Object.keys(resolved.agents)).toEqual(["reviewer"]);
  });

  test("profile with server_tags includes tag-matched servers", () => {
    const config: Config = {
      servers: {
        tavily: { command: "tavily-mcp", transport: "stdio", enabled: true, tags: ["search"] },
        outlook: { command: "outlook-mcp", transport: "stdio", enabled: true, tags: ["work"] },
        fetch: { command: "fetch-mcp", transport: "stdio", enabled: true },
      },
      profiles: {
        work: { server_tags: ["search"] },
      },
    };
    const resolved = buildResolvedConfig(config, "work");
    expect(Object.keys(resolved.servers)).toEqual(["tavily"]);
  });
});
