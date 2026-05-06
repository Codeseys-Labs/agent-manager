/**
 * Unit tests for the Argon2id parameter contract introduced in commit 36df874
 * (L-C1: expose Argon2id parameters in config + raise default to 128 MiB).
 *
 * Reviewer-flagged MED gap (Phase 8 cross-family review): the new ~120 LOC
 * around DEFAULT_ARGON2ID_PARAMS / resolveArgon2idParams / schema floor were
 * shipped without dedicated tests. This file closes that gap.
 */

import { describe, expect, test } from "bun:test";
import { SettingsSchema } from "../../src/core/schema";
import {
  ARGON2ID_MIN_MEMORY_KIB,
  type Argon2idParams,
  DEFAULT_ARGON2ID_PARAMS,
  resolveArgon2idParams,
} from "../../src/core/secrets-age";

describe("Argon2id defaults (L-C1)", () => {
  test("DEFAULT_ARGON2ID_PARAMS matches OWASP 2025 floor for credential stores", () => {
    expect(DEFAULT_ARGON2ID_PARAMS.memoryKiB).toBe(131072); // 128 MiB
    expect(DEFAULT_ARGON2ID_PARAMS.time).toBe(3);
    expect(DEFAULT_ARGON2ID_PARAMS.parallelism).toBe(4);
  });

  test("DEFAULT_ARGON2ID_PARAMS is frozen (defensive immutability)", () => {
    expect(Object.isFrozen(DEFAULT_ARGON2ID_PARAMS)).toBe(true);
  });

  test("ARGON2ID_MIN_MEMORY_KIB is the documented runtime floor (8 MiB)", () => {
    expect(ARGON2ID_MIN_MEMORY_KIB).toBe(8192);
  });
});

describe("resolveArgon2idParams (runtime defense in depth)", () => {
  test("returns defaults when override is undefined", () => {
    const params = resolveArgon2idParams();
    expect(params).toEqual({ ...DEFAULT_ARGON2ID_PARAMS });
  });

  test("returns defaults when override is empty object", () => {
    const params = resolveArgon2idParams({});
    expect(params).toEqual({ ...DEFAULT_ARGON2ID_PARAMS });
  });

  test("partial override merges with defaults", () => {
    const params = resolveArgon2idParams({ time: 7 });
    expect(params).toEqual({
      memoryKiB: DEFAULT_ARGON2ID_PARAMS.memoryKiB,
      time: 7,
      parallelism: DEFAULT_ARGON2ID_PARAMS.parallelism,
    });
  });

  test("full override replaces all params (still validated)", () => {
    const params = resolveArgon2idParams({ memoryKiB: 262144, time: 5, parallelism: 8 });
    expect(params).toEqual({ memoryKiB: 262144, time: 5, parallelism: 8 });
  });

  test("rejects memoryKiB below the runtime floor", () => {
    expect(() => resolveArgon2idParams({ memoryKiB: 1024 })).toThrow(
      /argon2.memoryKiB must be an integer/i,
    );
  });

  test("rejects non-integer memoryKiB", () => {
    expect(() => resolveArgon2idParams({ memoryKiB: 8192.5 })).toThrow(
      /argon2.memoryKiB must be an integer/i,
    );
  });

  test("rejects time < 1", () => {
    expect(() => resolveArgon2idParams({ time: 0 })).toThrow(/argon2.time must be an integer/i);
  });

  test("rejects parallelism > 16 (argon2-browser cap)", () => {
    expect(() => resolveArgon2idParams({ parallelism: 17 })).toThrow(
      /argon2.parallelism must be an integer/i,
    );
  });

  test("rejects parallelism < 1", () => {
    expect(() => resolveArgon2idParams({ parallelism: 0 })).toThrow(
      /argon2.parallelism must be an integer/i,
    );
  });

  test("rejects NaN values", () => {
    expect(() => resolveArgon2idParams({ memoryKiB: Number.NaN })).toThrow();
    expect(() => resolveArgon2idParams({ time: Number.NaN })).toThrow();
    expect(() => resolveArgon2idParams({ parallelism: Number.NaN })).toThrow();
  });
});

describe("SettingsSchema argon2 subschema (Zod-level enforcement)", () => {
  test("accepts the canonical default shape", () => {
    const result = SettingsSchema.safeParse({
      secrets: { argon2: { memoryKiB: 131072, time: 3, parallelism: 4 } },
    });
    expect(result.success).toBe(true);
  });

  test("accepts a stronger override (256 MiB, t=5)", () => {
    const result = SettingsSchema.safeParse({
      secrets: { argon2: { memoryKiB: 262144, time: 5, parallelism: 4 } },
    });
    expect(result.success).toBe(true);
  });

  test("rejects memoryKiB below schema floor", () => {
    const result = SettingsSchema.safeParse({
      secrets: { argon2: { memoryKiB: 1024 } },
    });
    expect(result.success).toBe(false);
  });

  test("rejects parallelism above 16", () => {
    const result = SettingsSchema.safeParse({
      secrets: { argon2: { parallelism: 32 } },
    });
    expect(result.success).toBe(false);
  });

  test("argon2 subkey is optional (omitting it is valid)", () => {
    const result = SettingsSchema.safeParse({ secrets: {} });
    expect(result.success).toBe(true);
  });
});
