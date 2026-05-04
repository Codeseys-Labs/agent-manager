/**
 * migrateLegacyKey conflict-branch coverage (Pillar 1 audit gap, 2026-05-03).
 *
 * The conflict branch in src/core/secrets.ts migrateLegacyKey fires when both
 * the legacy path (configDir/.agent-manager/key.txt) and the new OS-data-dir
 * path exist. The function keeps the new one and returns
 * `{ kind: "conflict", legacy, current }` so the caller can warn the user.
 * Prior to this test there was no coverage for that branch — a regression
 * could silently overwrite the new key with the legacy one without anyone
 * noticing.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { legacyKeyPath, migrateLegacyKey, resolveKeyPath } from "../../src/core/secrets";

let cfgDir: string;
let keyDir: string;

beforeEach(async () => {
  cfgDir = await mkdtemp(join(tmpdir(), "am-secrets-cfg-"));
  keyDir = await mkdtemp(join(tmpdir(), "am-secrets-key-"));
  process.env.AM_KEY_PATH = join(keyDir, "key");
});

afterEach(async () => {
  process.env.AM_KEY_PATH = undefined;
  await rm(cfgDir, { recursive: true, force: true });
  await rm(keyDir, { recursive: true, force: true });
});

describe("migrateLegacyKey — conflict branch (Pillar 1 coverage gap)", () => {
  test("both paths exist → returns { kind: 'conflict', legacy, current }", async () => {
    // Seed both: legacy key in configDir + current key at AM_KEY_PATH.
    const legacy = legacyKeyPath(cfgDir);
    const current = resolveKeyPath();
    await mkdir(join(cfgDir, ".agent-manager"), { recursive: true });
    await writeFile(legacy, "LEGACY_KEY_CONTENT");
    await writeFile(current, "NEW_KEY_CONTENT");

    const result = await migrateLegacyKey(cfgDir);
    expect(result.kind).toBe("conflict");
    if (result.kind === "conflict") {
      expect(result.legacy).toBe(legacy);
      expect(result.current).toBe(current);
    }

    // Verify the contract: new key content unchanged, legacy file still on
    // disk (caller emits warning; we DO NOT silently delete).
    expect(await Bun.file(current).text()).toBe("NEW_KEY_CONTENT");
    expect(await Bun.file(legacy).text()).toBe("LEGACY_KEY_CONTENT");
  });

  test("only legacy exists → migrated (control — makes sure conflict isn't a side-effect of our setup)", async () => {
    const legacy = legacyKeyPath(cfgDir);
    await mkdir(join(cfgDir, ".agent-manager"), { recursive: true });
    await writeFile(legacy, "LEGACY_ONLY");

    const result = await migrateLegacyKey(cfgDir);
    expect(result.kind).toBe("migrated");
    // New key now holds the legacy content.
    expect(await Bun.file(resolveKeyPath()).text()).toBe("LEGACY_ONLY");
  });

  test("neither exists → none", async () => {
    const result = await migrateLegacyKey(cfgDir);
    expect(result.kind).toBe("none");
  });
});
