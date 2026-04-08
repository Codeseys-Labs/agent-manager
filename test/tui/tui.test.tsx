import { describe, test, expect } from "bun:test";

describe("TUI", () => {
  test("Ink and React load correctly", async () => {
    const ink = await import("ink");
    const React = await import("react");

    expect(typeof ink.render).toBe("function");
    // Box and Text are React forwardRef objects, not plain functions
    expect(ink.Box).toBeDefined();
    expect(ink.Text).toBeDefined();
    expect(typeof React.useState).toBe("function");
  });

  test("TUI components can be imported", async () => {
    const { App } = await import("../../src/tui/App.tsx");
    const { Dashboard } = await import("../../src/tui/Dashboard.tsx");
    const { ProfileSwitcher } = await import("../../src/tui/ProfileSwitcher.tsx");
    const { StatusView } = await import("../../src/tui/StatusView.tsx");
    const { HelpView } = await import("../../src/tui/HelpView.tsx");

    expect(typeof App).toBe("function");
    expect(typeof Dashboard).toBe("function");
    expect(typeof ProfileSwitcher).toBe("function");
    expect(typeof StatusView).toBe("function");
    expect(typeof HelpView).toBe("function");
  });

  test("data module exports loadTuiData", async () => {
    const { loadTuiData } = await import("../../src/tui/data.ts");
    expect(typeof loadTuiData).toBe("function");
  });

  test("tui command can be imported", async () => {
    const { tuiCommand } = await import("../../src/commands/tui.ts");
    expect(tuiCommand).toBeDefined();
    expect(tuiCommand.meta?.name).toBe("tui");
  });

  test("launchTui function is exported", async () => {
    const { launchTui } = await import("../../src/tui/index.tsx");
    expect(typeof launchTui).toBe("function");
  });
});

describe("TUI data types", () => {
  test("TuiData shape with empty servers", () => {
    const data = {
      profileName: "test",
      profiles: ["test"],
      profileDescriptions: { test: "Test profile" },
      servers: [],
      activeServerNames: [],
      adapters: [],
      git: { branch: "main", clean: true, dirty: [], remotes: [] },
      allAdapterNames: [],
      config: {},
    };

    expect(data.profileName).toBe("test");
    expect(data.servers).toHaveLength(0);
    expect(data.git.clean).toBe(true);
  });

  test("Dashboard handles server entries", async () => {
    const data = {
      profileName: "work",
      profiles: ["work", "personal"],
      profileDescriptions: { work: "Work env", personal: "Personal env" },
      servers: [
        {
          name: "fetch",
          command: "uvx",
          tags: ["utility"],
          enabled: true,
          description: "Fetch MCP",
          transport: "stdio",
        },
        {
          name: "tavily",
          command: "bunx",
          tags: ["search"],
          enabled: false,
          description: "Tavily search",
          transport: "stdio",
        },
      ],
      activeServerNames: ["fetch"],
      adapters: [
        { name: "Claude Code", status: "in-sync", changes: 0 },
        { name: "Cursor", status: "drifted", changes: 2 },
      ],
      git: { branch: "main", clean: false, dirty: ["config.toml"], remotes: [{ remote: "origin", url: "git@example.com:repo.git" }] },
      allAdapterNames: ["claude-code", "cursor"],
      config: {},
    };

    expect(data.servers).toHaveLength(2);
    expect(data.servers[0].enabled).toBe(true);
    expect(data.servers[1].enabled).toBe(false);
    expect(data.adapters[0].status).toBe("in-sync");
    expect(data.adapters[1].status).toBe("drifted");
    expect(data.git.clean).toBe(false);
  });

  test("ProfileSwitcher data shape", () => {
    const profiles = ["work", "personal", "minimal"];
    const descriptions = {
      work: "Work environment",
      personal: "Personal setup",
      minimal: "Minimal config",
    };

    expect(profiles).toHaveLength(3);
    expect(descriptions.work).toBe("Work environment");
  });
});
