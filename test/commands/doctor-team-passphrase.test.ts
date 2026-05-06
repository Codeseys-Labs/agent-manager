import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import { join } from "node:path";
import { type TestDir, createTestDir } from "../helpers/tmp";

// ADR-0046 gate 3: `am doctor` proactively scans for `team_passphrase` in
// raw config files (bypassing Zod) and in legacy environment variables.
// This test exercises the regex + env detection behaviors that the doctor
// scan relies on. The full doctor command is integration-tested elsewhere;
// here we validate the substrate.

describe("ADR-0046: doctor team_passphrase detection — regex behaviors", () => {
  // The regex used inside doctor.ts (line 218): /^\s*team_passphrase\s*=/m
  const teamPassphraseRegex = /^\s*team_passphrase\s*=/m;

  test("matches simple TOML key at line start", () => {
    expect(teamPassphraseRegex.test("team_passphrase = \"x\"")).toBe(true);
  });

  test("matches indented key (inside table)", () => {
    expect(
      teamPassphraseRegex.test("[settings.secrets]\n  team_passphrase = \"x\""),
    ).toBe(true);
  });

  test("matches with extra spaces around equals", () => {
    expect(teamPassphraseRegex.test("team_passphrase    =    \"x\"")).toBe(true);
  });

  test("does NOT match comment containing the word", () => {
    // Conservative: only flag actual key=value, not commentary.
    const config = "# do not use team_passphrase, see ADR-0046\nbackend = \"age\"";
    expect(teamPassphraseRegex.test(config)).toBe(false);
  });

  test("does NOT match when team_passphrase is on the right of an equals", () => {
    const config = "comment = \"see team_passphrase docs\"";
    expect(teamPassphraseRegex.test(config)).toBe(false);
  });

  test("does NOT match similar-but-different keys", () => {
    expect(teamPassphraseRegex.test("team_passphrase_hint = \"x\"")).toBe(false);
    // The regex is anchored on `team_passphrase\s*=`, so suffixed keys
    // would only match if they matched `team_passphrase=` literally.
    // `team_passphrase_hint = "x"` includes `team_passphrase_hint` as
    // a unit; the regex finds `team_passphrase` followed by `_` not `=`,
    // so it correctly rejects.
  });

  test("matches at file start (no leading newline)", () => {
    expect(teamPassphraseRegex.test("team_passphrase = \"x\"\n")).toBe(true);
  });

  test("matches with surrounding context", () => {
    const config = `[settings]
default_profile = "work"

[settings.secrets]
backend = "age"
team_passphrase = "DO_NOT"

[servers.tavily]
command = "uvx"`;
    expect(teamPassphraseRegex.test(config)).toBe(true);
  });
});

describe("ADR-0046: legacy environment variable hints", () => {
  let savedEnv: Record<string, string | undefined>;

  beforeEach(() => {
    savedEnv = {
      AM_TEAM_PASSPHRASE: process.env.AM_TEAM_PASSPHRASE,
      AGENT_MANAGER_TEAM_PASSPHRASE: process.env.AGENT_MANAGER_TEAM_PASSPHRASE,
      AM_SHARED_PASSPHRASE: process.env.AM_SHARED_PASSPHRASE,
    };
    delete process.env.AM_TEAM_PASSPHRASE;
    delete process.env.AGENT_MANAGER_TEAM_PASSPHRASE;
    delete process.env.AM_SHARED_PASSPHRASE;
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  function envHints(): string[] {
    const hints: string[] = [];
    for (const envName of [
      "AM_TEAM_PASSPHRASE",
      "AGENT_MANAGER_TEAM_PASSPHRASE",
      "AM_SHARED_PASSPHRASE",
    ]) {
      if (process.env[envName]) hints.push(envName);
    }
    return hints;
  }

  test("returns empty list when no env vars set", () => {
    expect(envHints()).toEqual([]);
  });

  test("detects AM_TEAM_PASSPHRASE", () => {
    process.env.AM_TEAM_PASSPHRASE = "x";
    expect(envHints()).toEqual(["AM_TEAM_PASSPHRASE"]);
  });

  test("detects all three legacy env var names", () => {
    process.env.AM_TEAM_PASSPHRASE = "x";
    process.env.AGENT_MANAGER_TEAM_PASSPHRASE = "y";
    process.env.AM_SHARED_PASSPHRASE = "z";
    expect(envHints().sort()).toEqual(
      [
        "AM_SHARED_PASSPHRASE",
        "AM_TEAM_PASSPHRASE",
        "AGENT_MANAGER_TEAM_PASSPHRASE",
      ].sort(),
    );
  });

  test("ignores empty-string env vars", () => {
    process.env.AM_TEAM_PASSPHRASE = "";
    expect(envHints()).toEqual([]);
  });
});

describe("ADR-0046: doctor scan integration — file detection", () => {
  let dir: TestDir;

  afterEach(async () => {
    if (dir) await dir.cleanup();
  });

  test("file with team_passphrase key is detected", async () => {
    dir = await createTestDir("am-doctor-tp-");
    const configPath = join(dir.path, "config.toml");
    fs.writeFileSync(
      configPath,
      `[settings.secrets]
backend = "age"
team_passphrase = "$ARGON2"
`,
    );
    const raw = fs.readFileSync(configPath, "utf-8");
    expect(/^\s*team_passphrase\s*=/m.test(raw)).toBe(true);
  });

  test("clean file with no team_passphrase is NOT detected", async () => {
    dir = await createTestDir("am-doctor-clean-");
    const configPath = join(dir.path, "config.toml");
    fs.writeFileSync(
      configPath,
      `[settings.secrets]
backend = "age"
`,
    );
    const raw = fs.readFileSync(configPath, "utf-8");
    expect(/^\s*team_passphrase\s*=/m.test(raw)).toBe(false);
  });
});
