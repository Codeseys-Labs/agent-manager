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
  writeConfig,
} from "../../src/core/config";
import type { Config } from "../../src/core/schema";

const FIXTURES = join(import.meta.dir, "..", "fixtures");

describe("resolveConfigDir", () => {
  const origEnv = process.env.AM_CONFIG_DIR;

  afterEach(() => {
    if (origEnv === undefined) {
      process.env.AM_CONFIG_DIR = undefined;
    } else {
      process.env.AM_CONFIG_DIR = origEnv;
    }
  });

  test("returns AM_CONFIG_DIR when set", () => {
    process.env.AM_CONFIG_DIR = "/tmp/custom-am";
    expect(resolveConfigDir()).toBe("/tmp/custom-am");
  });

  test("returns default path when AM_CONFIG_DIR is not set", () => {
    process.env.AM_CONFIG_DIR = undefined;
    const result = resolveConfigDir();
    expect(result).toEndWith("/.config/agent-manager");
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

  test("settings shallow merge — higher precedence key wins", () => {
    const a: Config = {
      settings: { default_profile: "base", mcp_serve: { allow_apply: true } },
    };
    const b: Config = {
      settings: { default_profile: "work" },
    };
    const merged = mergeConfigs(a, b);
    expect(merged.settings?.default_profile).toBe("work");
    expect(merged.settings?.mcp_serve).toEqual({ allow_apply: true });
  });

  test("merges agents as union", () => {
    const a: Config = {
      agents: { reviewer: { description: "Code reviewer" } },
    };
    const b: Config = {
      agents: { deployer: { description: "Deploy agent" } },
    };
    const merged = mergeConfigs(a, b);
    expect(merged.agents?.reviewer).toBeDefined();
    expect(merged.agents?.deployer).toBeDefined();
  });

  test("higher precedence agent overrides same-name agent", () => {
    const a: Config = {
      agents: { reviewer: { description: "Old reviewer" } },
    };
    const b: Config = {
      agents: { reviewer: { description: "New reviewer", model: "o3" } },
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

describe("projectToConfig", () => {
  test("projectToConfig preserves agents", () => {
    const proj = { agents: { reviewer: { description: "Code reviewer" } } };
    const config = projectToConfig(proj as any);
    expect(config.agents?.reviewer).toBeDefined();
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
});
