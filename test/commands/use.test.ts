import { afterEach, describe, expect, test } from "bun:test";
import { readActiveProfile, writeActiveProfile } from "../../src/commands/use";
import { initRepo } from "../../src/core/git";
import { type TestDir, createTestDir } from "../helpers/tmp";

describe("am use", () => {
  let dir: TestDir;

  afterEach(async () => {
    if (dir) await dir.cleanup();
  });

  test("writes and reads active profile from state.toml", async () => {
    dir = await createTestDir("am-use-");
    const configDir = dir.path;
    await initRepo(configDir);

    await writeActiveProfile(configDir, "work");
    const profile = await readActiveProfile(configDir);
    expect(profile).toBe("work");
  });

  test("overwrites existing profile", async () => {
    dir = await createTestDir("am-use-");
    const configDir = dir.path;
    await initRepo(configDir);

    await writeActiveProfile(configDir, "work");
    await writeActiveProfile(configDir, "personal");
    const profile = await readActiveProfile(configDir);
    expect(profile).toBe("personal");
  });

  test("returns null when no state file exists", async () => {
    dir = await createTestDir("am-use-");
    const profile = await readActiveProfile(dir.path);
    expect(profile).toBeNull();
  });
});
