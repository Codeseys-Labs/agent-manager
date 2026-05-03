/**
 * B3-full (2026-05-03): `am marketplace validate <path>` validates a
 * marketplace repo's plugin manifests offline, before pushing. This
 * test file locks the CLI-surface contract: given a fixture repo,
 * the validator surfaces real problems and passes clean ones.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { formatValidateSummary, validateMarketplace } from "../../src/marketplace/validate";
import { type TestDir, createTestDir } from "../helpers/tmp";

async function writeManifest(
  marketplaceDir: string,
  pluginDir: string,
  manifest: Record<string, unknown>,
): Promise<string> {
  const fullPluginDir = join(marketplaceDir, pluginDir);
  const manifestDir = join(fullPluginDir, ".am-plugin");
  await mkdir(manifestDir, { recursive: true });
  const manifestPath = join(manifestDir, "plugin.json");
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2));
  return fullPluginDir;
}

describe("validateMarketplace", () => {
  let dir: TestDir | undefined;

  beforeEach(async () => {
    dir = await createTestDir("am-marketplace-validate-");
  });

  afterEach(async () => {
    if (dir) await dir.cleanup();
    dir = undefined;
  });

  test("nonexistent path returns a hard error", async () => {
    const result = await validateMarketplace("/definitely/does/not/exist");
    expect(result.valid).toBe(false);
    expect(result.pluginsFound).toBe(0);
    expect(result.issues[0].severity).toBe("error");
    expect(result.issues[0].message).toContain("does not exist");
  });

  test("empty marketplace (no plugins) is an error", async () => {
    if (!dir) throw new Error("setup");
    const result = await validateMarketplace(dir.path);
    expect(result.valid).toBe(false);
    expect(result.pluginsFound).toBe(0);
    const msgs = result.issues.map((i) => i.message).join(" ");
    expect(msgs).toContain("No plugins found");
  });

  test("minimal valid manifest passes", async () => {
    if (!dir) throw new Error("setup");
    await writeManifest(dir.path, "utils", {
      name: "utils",
      description: "Utilities plugin",
    });
    const result = await validateMarketplace(dir.path);
    expect(result.valid).toBe(true);
    expect(result.pluginsFound).toBe(1);
    expect(result.issues.filter((i) => i.severity === "error")).toHaveLength(0);
  });

  test("missing description is a schema error", async () => {
    if (!dir) throw new Error("setup");
    await writeManifest(dir.path, "utils", {
      name: "utils",
      // description missing
    });
    const result = await validateMarketplace(dir.path);
    // Scanner short-circuits and returns null when description is missing
    // (see scanner.ts:29), so this manifests as "no plugins found".
    expect(result.valid).toBe(false);
    expect(result.pluginsFound).toBe(0);
  });

  test("duplicate plugin names are flagged as errors", async () => {
    if (!dir) throw new Error("setup");
    await writeManifest(dir.path, "plugins/a", { name: "utils", description: "v1" });
    await writeManifest(dir.path, "plugins/b", { name: "utils", description: "v2" });
    const result = await validateMarketplace(dir.path);
    expect(result.valid).toBe(false);
    const dupIssue = result.issues.find((i) => i.message.includes("declared in"));
    expect(dupIssue).toBeDefined();
    expect(dupIssue?.severity).toBe("error");
    expect(dupIssue?.plugin).toBe("utils");
  });

  test("invalid plugin name (uppercase) is a schema error", async () => {
    if (!dir) throw new Error("setup");
    await writeManifest(dir.path, "utils", {
      name: "MyPlugin",
      description: "Bad name",
    });
    const result = await validateMarketplace(dir.path);
    expect(result.valid).toBe(false);
    const issue = result.issues.find((i) => (i.field ?? "").includes("name"));
    expect(issue).toBeDefined();
    expect(issue?.severity).toBe("error");
  });

  test("unreachable prompt_file is an error", async () => {
    if (!dir) throw new Error("setup");
    await writeManifest(dir.path, "reviewer", {
      name: "reviewer",
      description: "Code reviewer plugin",
      agents: {
        "code-reviewer": {
          name: "code-reviewer",
          prompt_file: "prompts/missing.md",
        },
      },
    });
    const result = await validateMarketplace(dir.path);
    expect(result.valid).toBe(false);
    const issue = result.issues.find((i) => i.message.includes("Prompt file not found"));
    expect(issue).toBeDefined();
    expect(issue?.field).toBe("agents.code-reviewer.prompt_file");
  });

  test("resolved prompt_file passes", async () => {
    if (!dir) throw new Error("setup");
    const pluginDir = await writeManifest(dir.path, "reviewer", {
      name: "reviewer",
      description: "Code reviewer",
      agents: {
        "code-reviewer": {
          name: "code-reviewer",
          prompt_file: "prompts/review.md",
        },
      },
    });
    await mkdir(join(pluginDir, "prompts"), { recursive: true });
    await writeFile(join(pluginDir, "prompts", "review.md"), "You are a reviewer.");
    const result = await validateMarketplace(dir.path);
    expect(result.valid).toBe(true);
    expect(result.pluginsFound).toBe(1);
  });

  test("unreachable skills file is an error", async () => {
    if (!dir) throw new Error("setup");
    await writeManifest(dir.path, "utils", {
      name: "utils",
      description: "Utils with missing skill",
      skills: ["skills/missing.md"],
    });
    const result = await validateMarketplace(dir.path);
    expect(result.valid).toBe(false);
    const issue = result.issues.find((i) => i.message.includes("Skill file not found"));
    expect(issue).toBeDefined();
  });

  test("@latest pin warns but does not fail", async () => {
    if (!dir) throw new Error("setup");
    await writeManifest(dir.path, "fetch", {
      name: "fetch",
      description: "Fetch with @latest pin",
      servers: {
        fetch: {
          command: "uvx",
          args: ["mcp-server-fetch@latest"],
        },
      },
    });
    const result = await validateMarketplace(dir.path);
    expect(result.valid).toBe(true); // warnings don't fail
    const warn = result.issues.find((i) => i.message.includes("@latest"));
    expect(warn).toBeDefined();
    expect(warn?.severity).toBe("warning");
  });

  test("agent with neither prompt nor prompt_file warns", async () => {
    if (!dir) throw new Error("setup");
    await writeManifest(dir.path, "reviewer", {
      name: "reviewer",
      description: "Missing prompt",
      agents: {
        x: { name: "x" },
      },
    });
    const result = await validateMarketplace(dir.path);
    expect(result.valid).toBe(true);
    const warn = result.issues.find((i) => i.message.includes("neither prompt nor prompt_file"));
    expect(warn).toBeDefined();
    expect(warn?.severity).toBe("warning");
  });

  test("bundled adapter emits a warning", async () => {
    if (!dir) throw new Error("setup");
    await writeManifest(dir.path, "zed-support", {
      name: "zed-support",
      description: "Zed adapter bundled",
      adapter: {
        command: "npx -y am-adapter-zed@1.0.0",
        source: "npm:am-adapter-zed@1.0.0",
      },
    });
    const result = await validateMarketplace(dir.path);
    expect(result.valid).toBe(true);
    const warn = result.issues.find((i) => i.field === "adapter");
    expect(warn).toBeDefined();
    expect(warn?.severity).toBe("warning");
  });

  test("formatValidateSummary produces readable output", async () => {
    if (!dir) throw new Error("setup");
    await writeManifest(dir.path, "utils", {
      name: "utils",
      description: "Good plugin",
    });
    const result = await validateMarketplace(dir.path);
    const summary = formatValidateSummary(result);
    expect(summary).toContain("Plugins found: 1");
    expect(summary).toContain("VALID");
  });

  test("formatValidateSummary shows INVALID on errors", async () => {
    const result = await validateMarketplace("/definitely/does/not/exist");
    const summary = formatValidateSummary(result);
    expect(summary).toContain("INVALID");
  });
});
