import { describe, expect, test } from "bun:test";
import {
  type AgentProfile,
  AgentProfileSchema,
  type Config,
  ConfigSchema,
  type Instruction,
  InstructionSchema,
  type Profile,
  ProfileSchema,
  type ProjectConfig,
  ProjectConfigSchema,
  type Server,
  ServerSchema,
  type Skill,
  SkillSchema,
} from "../../src/core/schema";

describe("ServerSchema", () => {
  test("parses minimal server", () => {
    const result = ServerSchema.parse({ command: "my-mcp-server" });
    expect(result.command).toBe("my-mcp-server");
    expect(result.transport).toBe("stdio");
    expect(result.enabled).toBe(true);
  });

  test("parses full server with adapters passthrough", () => {
    const result = ServerSchema.parse({
      command: "aws-outlook-mcp",
      args: ["--verbose"],
      env: { MIDWAY_AUTH: "true" },
      transport: "streamable-http",
      description: "Outlook email and calendar",
      tags: ["email", "calendar"],
      enabled: true,
      adapters: {
        "claude-code": { always_allow: ["email_search"] },
        cline: { always_allow: true },
      },
    });
    expect(result.command).toBe("aws-outlook-mcp");
    expect(result.args).toEqual(["--verbose"]);
    expect(result.env).toEqual({ MIDWAY_AUTH: "true" });
    expect(result.transport).toBe("streamable-http");
    expect(result.tags).toEqual(["email", "calendar"]);
    expect(result.adapters?.["claude-code"]).toEqual({ always_allow: ["email_search"] });
  });

  test("rejects without command", () => {
    expect(() => ServerSchema.parse({})).toThrow();
  });

  test("rejects invalid transport", () => {
    expect(() => ServerSchema.parse({ command: "my-mcp", transport: "grpc" })).toThrow();
  });
});

describe("InstructionSchema", () => {
  test("parses inline content", () => {
    const result = InstructionSchema.parse({
      content: "Use strict TypeScript.",
      scope: "always",
    });
    expect(result.content).toBe("Use strict TypeScript.");
    expect(result.scope).toBe("always");
  });

  test("parses content_file", () => {
    const result = InstructionSchema.parse({
      content_file: "instructions/code-review.md",
      scope: "glob",
      globs: ["**/*.ts"],
    });
    expect(result.content_file).toBe("instructions/code-review.md");
  });

  test("rejects both content and content_file", () => {
    expect(() =>
      InstructionSchema.parse({
        content: "inline",
        content_file: "file.md",
        scope: "always",
      }),
    ).toThrow();
  });

  test("rejects neither content nor content_file", () => {
    expect(() => InstructionSchema.parse({ scope: "always" })).toThrow();
  });
});

describe("SkillSchema", () => {
  test("parses minimal skill", () => {
    const result = SkillSchema.parse({
      path: "skills/research-rabbithole",
      description: "Multi-agent research",
    });
    expect(result.path).toBe("skills/research-rabbithole");
    expect(result.description).toBe("Multi-agent research");
  });

  test("parses with tags and adapters", () => {
    const result = SkillSchema.parse({
      path: "skills/research-rabbithole",
      description: "Multi-agent research",
      tags: ["research"],
      adapters: {
        "claude-code": { trigger: "/research-rabbithole" },
      },
    });
    expect(result.tags).toEqual(["research"]);
    expect(result.adapters?.["claude-code"]).toEqual({ trigger: "/research-rabbithole" });
  });
});

describe("AgentProfileSchema", () => {
  test("parses minimal agent profile", () => {
    const result = AgentProfileSchema.parse({ name: "code-reviewer" });
    expect(result.name).toBe("code-reviewer");
    expect(result.description).toBeUndefined();
    expect(result.prompt).toBeUndefined();
    expect(result.model).toBeUndefined();
    expect(result.tools).toBeUndefined();
  });

  test("parses full agent profile", () => {
    const result = AgentProfileSchema.parse({
      name: "security-auditor",
      description: "Reviews code for security vulnerabilities",
      prompt: "You are a security expert.",
      model: "opus",
      tools: ["Read", "Grep", "Glob"],
      disallowed_tools: ["Write", "Edit"],
      mcp_servers: ["secureguide", "loaf"],
      max_turns: 50,
      adapters: {
        "claude-code": { permissionMode: "default" },
      },
    });
    expect(result.name).toBe("security-auditor");
    expect(result.description).toBe("Reviews code for security vulnerabilities");
    expect(result.prompt).toBe("You are a security expert.");
    expect(result.model).toBe("opus");
    expect(result.tools).toEqual(["Read", "Grep", "Glob"]);
    expect(result.disallowed_tools).toEqual(["Write", "Edit"]);
    expect(result.mcp_servers).toEqual(["secureguide", "loaf"]);
    expect(result.max_turns).toBe(50);
    expect(result.adapters?.["claude-code"]).toEqual({ permissionMode: "default" });
  });

  test("parses agent profile with prompt_file", () => {
    const result = AgentProfileSchema.parse({
      name: "reviewer",
      prompt_file: "agents/reviewer.md",
    });
    expect(result.prompt_file).toBe("agents/reviewer.md");
    expect(result.prompt).toBeUndefined();
  });

  test("rejects both prompt and prompt_file", () => {
    expect(() =>
      AgentProfileSchema.parse({
        name: "bad-agent",
        prompt: "inline prompt",
        prompt_file: "agents/bad.md",
      }),
    ).toThrow();
  });
});

describe("ProfileSchema", () => {
  test("parses minimal profile", () => {
    const result = ProfileSchema.parse({});
    expect(result).toBeDefined();
  });

  test("parses full profile with inheritance", () => {
    const result = ProfileSchema.parse({
      description: "Work profile",
      inherits: "base",
      servers: ["tavily", "exa"],
      server_tags: ["work"],
      skills: ["research-rabbithole"],
      agents: ["code-reviewer", "security-auditor"],
      instructions: ["typescript-conventions"],
      env: { AWS_PROFILE: "work-sso" },
      adapters: {
        "claude-code": { output_style: "learning" },
      },
    });
    expect(result.inherits).toBe("base");
    expect(result.servers).toEqual(["tavily", "exa"]);
    expect(result.server_tags).toEqual(["work"]);
    expect(result.agents).toEqual(["code-reviewer", "security-auditor"]);
    expect(result.env).toEqual({ AWS_PROFILE: "work-sso" });
  });
});

describe("ConfigSchema", () => {
  test("parses empty config", () => {
    const result = ConfigSchema.parse({});
    expect(result).toBeDefined();
  });

  test("parses full config", () => {
    const result = ConfigSchema.parse({
      settings: {
        default_profile: "work",
        mcp_serve: { allow_push: false },
      },
      servers: {
        outlook: {
          command: "aws-outlook-mcp",
          tags: ["email"],
        },
      },
      skills: {
        "research-rabbithole": {
          path: "skills/research-rabbithole",
          description: "Multi-agent research",
        },
      },
      agents: {
        "code-reviewer": {
          name: "code-reviewer",
          description: "Reviews code",
          prompt: "You are a code reviewer.",
          model: "sonnet",
          tools: ["Read", "Grep"],
        },
      },
      instructions: {
        "ts-conventions": {
          content: "Use strict TypeScript.",
          scope: "always",
        },
      },
      profiles: {
        work: {
          description: "Work profile",
          inherits: "base",
          servers: ["outlook"],
          agents: ["code-reviewer"],
        },
      },
      adapters: {
        "claude-code": { permission_mode: "allowEdits" },
      },
    });
    expect(result.settings?.default_profile).toBe("work");
    expect(result.servers?.outlook.command).toBe("aws-outlook-mcp");
    expect(result.agents?.["code-reviewer"]?.model).toBe("sonnet");
    expect(result.profiles?.work.inherits).toBe("base");
    expect(result.profiles?.work.agents).toEqual(["code-reviewer"]);
  });
});

describe("ProjectConfigSchema", () => {
  test("parses minimal project config", () => {
    const result = ProjectConfigSchema.parse({});
    expect(result).toBeDefined();
  });

  test("parses full project config", () => {
    const result = ProjectConfigSchema.parse({
      profile: "work",
      project: {
        name: "ADMINISTRIVIA",
        description: "Personal productivity vault",
      },
      servers: {
        wiki: {
          command: "amazon-wiki-mcp",
          tags: ["wiki"],
        },
      },
      skills: {
        lint: {
          path: "skills/admin-lint",
          description: "Vault linter",
        },
      },
      instructions: {
        conventions: {
          content: "Follow vault conventions.",
          scope: "always",
        },
      },
      env: { AWS_PROFILE: "work" },
      adapters: {
        "claude-code": { hooks: { Stop: "scripts/board-sync-check.sh" } },
      },
    });
    expect(result.profile).toBe("work");
    expect(result.project?.name).toBe("ADMINISTRIVIA");
    expect(result.servers?.wiki.command).toBe("amazon-wiki-mcp");
    expect(result.env).toEqual({ AWS_PROFILE: "work" });
  });
});
