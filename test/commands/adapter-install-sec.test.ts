/**
 * Security tests for `am adapter install`.
 *
 * Covers Wave 2.A HIGH findings:
 *   - HIGH-2: adapter name derivation must reject path traversal, bad chars,
 *     and oversized names before we touch the filesystem or spawn npm.
 *   - Implicitly, by exercising resolveSource for each source type, asserts
 *     the rule is applied uniformly (npm / git / local).
 */

import { describe, expect, test } from "bun:test";
import { resolveSource, validateAdapterName } from "../../src/commands/adapter.ts";

describe("validateAdapterName() - invalid names", () => {
  const invalid: Array<[label: string, name: string]> = [
    ["path traversal segments", "../etc-passwd"],
    ["forward slash (POSIX separator)", "foo/bar"],
    ["backslash (Windows separator)", "foo\\bar"],
    ["empty string", ""],
    ["over 64 characters", "a".repeat(65)],
    ["uppercase letters", "MyAdapter"],
    ["starts with dash", "-leading-dash"],
    ["starts with underscore", "_leading-underscore"],
    ["whitespace inside", "foo bar"],
    ["special char ($)", "foo$bar"],
  ];

  for (const [label, name] of invalid) {
    test(`rejects ${label}: ${JSON.stringify(name)}`, () => {
      expect(() => validateAdapterName(name)).toThrow(/Invalid adapter name/);
    });
  }
});

describe("validateAdapterName() - valid names", () => {
  const valid: string[] = [
    "zed",
    "am-adapter-void",
    "kilo_code",
    "tool9",
    "a".repeat(64), // boundary: exactly 64 chars
  ];

  for (const name of valid) {
    test(`accepts ${JSON.stringify(name)}`, () => {
      expect(() => validateAdapterName(name)).not.toThrow();
    });
  }
});

describe("resolveSource() - name derivation is validated", () => {
  test("rejects a git URL whose basename would traverse", () => {
    // A malicious repo URL where the last segment is ".." — derived name
    // would escape the adapters dir without validation.
    expect(() => resolveSource("https://evil.example.com/..")).toThrow(/Invalid adapter name/);
  });

  test("rejects a local path with uppercase basename", () => {
    expect(() => resolveSource("local:./MyAdapter")).toThrow(/Invalid adapter name/);
  });

  test("rejects an empty local basename (trailing slashes)", () => {
    // "local://" -> split('/') -> ['local:', '', ''] -> filter Boolean -> ['local:']
    // The first segment stays (since we keep 'local:' prefix as part of first segment);
    // this confirms we still catch bare/no-basename inputs.
    expect(() => resolveSource("local:/")).toThrow(/Invalid adapter name/);
  });

  test("accepts a well-formed npm source", () => {
    const result = resolveSource("am-adapter-zed@0.2.0");
    expect(result.name).toBe("zed");
    expect(result.sourceType).toBe("npm");
    // HIGH-5: --ignore-scripts must be present in the install command
    expect(result.installCmd).toContain("--ignore-scripts");
  });

  test("accepts a well-formed git URL", () => {
    const result = resolveSource("https://github.com/user/am-adapter-void.git");
    expect(result.name).toBe("void");
    expect(result.sourceType).toBe("git");
  });

  test("accepts a scoped npm package and strips the scope from the derived name", () => {
    const result = resolveSource("@myorg/am-adapter-zed@0.2.0");
    expect(result.name).toBe("zed");
    expect(result.sourceType).toBe("npm");
    expect(result.installCmd).toContain("--ignore-scripts");
  });
});
