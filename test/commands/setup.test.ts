/**
 * Command-level tests for the `am setup` first-run wizard (ADR-0053,
 * docs/design/am-setup-wizard.md).
 *
 * These drive the exported `setupCommand.run()` directly with:
 *   - `AM_CONFIG_DIR` pointed at a per-test temp dir (full isolation),
 *   - the adapter-detection seam (`__setDetectedAdaptersForTests`) AND the
 *     controller's apply seam (`__setAdapterResolverForTests`) both forced to
 *     a controlled list so we never detect — or apply to — the real machine's
 *     tools,
 *   - console captured so we can assert on output without a TTY.
 *
 * The test process has no interactive stdin (not a TTY), so the wizard's
 * `interactive` guard is false unless we explicitly mock clack + TTY. That
 * means the non-interactive paths can be exercised with zero clack mocking and
 * a regression that reintroduced a hanging prompt would time out the test.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import { join } from "node:path";
import git from "isomorphic-git";
import {
  __setDetectedAdaptersForTests,
  guessRepoUrl,
  secretsBackendOptions,
  setupCommand,
} from "../../src/commands/setup";
import { readConfig } from "../../src/core/config";
import { __setAdapterResolverForTests } from "../../src/core/controller";
import { type TestDir, createTestDir } from "../helpers/tmp";

let consoleOutput: string[] = [];
let consoleErrors: string[] = [];
const origLog = console.log;
const origError = console.error;
const origConfigDir = process.env.AM_CONFIG_DIR;

function captureConsole(): void {
  consoleOutput = [];
  consoleErrors = [];
  console.log = (...args: unknown[]) => {
    consoleOutput.push(args.map(String).join(" "));
  };
  console.error = (...args: unknown[]) => {
    consoleErrors.push(args.map(String).join(" "));
  };
}

function restoreConsole(): void {
  console.log = origLog;
  console.error = origError;
}

const handler = setupCommand as unknown as {
  run: (ctx: { args: Record<string, unknown> }) => Promise<void>;
};

function makeArgs(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    from: undefined,
    ssh: false,
    tools: undefined,
    profile: undefined,
    "no-apply": false,
    force: false,
    "generate-key": false,
    yes: false,
    "non-interactive": false,
    json: false,
    quiet: false,
    verbose: false,
    ...overrides,
  };
}

/**
 * Build a local bare repo at `barePath` containing a valid agent-manager
 * config.toml on `main`, returning the path. Used as the `--from` remote.
 */
async function seedBareCatalog(root: string, barePath: string): Promise<void> {
  const work = join(root, "seed-work");
  fs.mkdirSync(work, { recursive: true });
  await git.init({ fs, dir: work, defaultBranch: "main" });
  fs.writeFileSync(
    join(work, "config.toml"),
    [
      "[settings]",
      'default_profile = "cloned"',
      "",
      "[profiles.cloned]",
      'description = "Profile from the cloned catalog"',
      "",
    ].join("\n"),
  );
  await git.add({ fs, dir: work, filepath: "config.toml" });
  await git.commit({
    fs,
    dir: work,
    message: "seed catalog",
    author: { name: "t", email: "t@t" },
  });
  // A "bare" repo = a copy of the work repo's .git database.
  fs.mkdirSync(barePath, { recursive: true });
  fs.cpSync(join(work, ".git"), barePath, { recursive: true });
}

describe("am setup", () => {
  let dir: TestDir;

  beforeEach(async () => {
    dir = await createTestDir("am-setup-");
    process.env.AM_CONFIG_DIR = join(dir.path, "cfg");
    // Force a hermetic, empty tool set everywhere the wizard or the apply
    // pipeline asks: no real configs are detected or written.
    __setDetectedAdaptersForTests(async () => []);
    __setAdapterResolverForTests(async () => []);
    captureConsole();
    process.exitCode = 0;
  });

  afterEach(async () => {
    restoreConsole();
    __setDetectedAdaptersForTests(null);
    __setAdapterResolverForTests(null);
    process.exitCode = 0;
    if (origConfigDir === undefined) {
      // biome-ignore lint/performance/noDelete: env var cleanup
      delete process.env.AM_CONFIG_DIR;
    } else {
      process.env.AM_CONFIG_DIR = origConfigDir;
    }
    if (dir) await dir.cleanup();
  });

  test("--yes non-interactive happy path initializes config + profile and applies", async () => {
    await handler.run({ args: makeArgs({ yes: true }) });

    const configDir = process.env.AM_CONFIG_DIR!;
    // Git repo + config.toml created.
    expect(fs.existsSync(join(configDir, ".git"))).toBe(true);
    const config = await readConfig(join(configDir, "config.toml"));
    expect(config.settings?.default_profile).toBe("default");
    expect(config.profiles?.default).toBeDefined();
    // Health check passed (no failures) → exit code stays 0.
    expect(process.exitCode).toBe(0);
  });

  test("--json emits the doctor Check[] and a healthy flag", async () => {
    await handler.run({ args: makeArgs({ yes: true, json: true }) });

    const payload = JSON.parse(consoleOutput.join("\n"));
    expect(payload.action).toBe("setup");
    expect(payload.healthy).toBe(true);
    expect(Array.isArray(payload.checks)).toBe(true);
    // The doctor Check[] shape is preserved.
    expect(
      payload.checks.every((c: unknown) => typeof (c as { name: string }).name === "string"),
    ).toBe(true);
    // Config-directory and git-repository checks are present and ok.
    const byName = new Map(
      payload.checks.map((c: { name: string; status: string }) => [c.name, c.status]),
    );
    expect(byName.get("Config directory")).toBe("ok");
    expect(byName.get("Git repository")).toBe("ok");
    expect(process.exitCode).toBe(0);
  });

  test("--from clones a local bare repo into the config dir and applies", async () => {
    const barePath = join(dir.path, "remote.git");
    await seedBareCatalog(dir.path, barePath);

    await handler.run({
      args: makeArgs({ yes: true, json: true, from: barePath }),
    });

    const configDir = process.env.AM_CONFIG_DIR!;
    // The cloned config.toml landed verbatim (its profile is "cloned").
    const config = await readConfig(join(configDir, "config.toml"));
    expect(config.settings?.default_profile).toBe("cloned");
    expect(config.profiles?.cloned).toBeDefined();

    const payload = JSON.parse(consoleOutput.join("\n"));
    expect(payload.cloned).toBe(true);
    expect(payload.profile).toBe("cloned");
    expect(payload.healthy).toBe(true);
  });

  test("re-run on a configured dir is non-destructive and does not bail", async () => {
    // First run creates the config. --no-apply keeps the focus on config
    // idempotency (and keeps the double-run fast — apply is exercised by the
    // happy-path/json/from tests above).
    await handler.run({ args: makeArgs({ yes: true, "no-apply": true }) });
    const configDir = process.env.AM_CONFIG_DIR!;
    const configPath = join(configDir, "config.toml");
    const first = fs.readFileSync(configPath, "utf-8");

    // Second run must NOT error with "Already initialized" and must not clobber.
    captureConsole();
    process.exitCode = 0;
    await handler.run({ args: makeArgs({ yes: true, "no-apply": true }) });

    expect(consoleErrors.join("\n")).not.toContain("Already initialized");
    expect(process.exitCode).toBe(0);
    // Config still valid and default profile intact.
    const config = await readConfig(configPath);
    expect(config.profiles?.default).toBeDefined();
    expect(config.settings?.default_profile).toBe("default");
    // The committed config.toml content is unchanged by a no-op re-run.
    expect(fs.readFileSync(configPath, "utf-8")).toBe(first);
  }, 20000);

  test("secrets default is AES — the interactive prompt never offers the age path", () => {
    // The wizard's step 3 builds its select() options from this pure function.
    // ADR-0053 step 3 / ADR-0042 fence: ONLY legacy AES is offered; age is
    // fenced for v1. Asserting the contract directly (rather than through a
    // globally-mocked prompt library) keeps the test hermetic and proves the
    // wizard cannot surface an age choice.
    const options = secretsBackendOptions();
    const values = options.map((o) => o.value);
    const labels = options.map((o) => o.label.toLowerCase()).join(" ");

    expect(values).toContain("generate");
    expect(values).toContain("skip");
    expect(values).not.toContain("age");
    expect(labels).not.toContain("age");
    // The recommended choice explicitly names the AES backend.
    expect(labels).toContain("aes");
  });
});

describe("guessRepoUrl", () => {
  test("expands user/repo shorthand to a GitHub https URL", () => {
    expect(guessRepoUrl("alice/dotfiles")).toBe("https://github.com/alice/dotfiles.git");
  });

  test("expands user/repo shorthand to SSH when --ssh", () => {
    expect(guessRepoUrl("alice/dotfiles", { ssh: true })).toBe("git@github.com:alice/dotfiles.git");
  });

  test("expands host/user/repo shorthand", () => {
    expect(guessRepoUrl("gitlab.com/alice/dotfiles")).toBe("https://gitlab.com/alice/dotfiles.git");
  });

  test("passes through a full https URL untouched", () => {
    const url = "https://github.com/alice/dotfiles.git";
    expect(guessRepoUrl(url)).toBe(url);
  });

  test("passes through a local absolute path untouched", () => {
    expect(guessRepoUrl("/tmp/remote.git")).toBe("/tmp/remote.git");
  });

  test("passes through scp-style git@ URL untouched", () => {
    const url = "git@github.com:alice/dotfiles.git";
    expect(guessRepoUrl(url)).toBe(url);
  });
});
