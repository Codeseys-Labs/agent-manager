/**
 * M9 — interpolation warnings must be surfaced at apply, not discarded.
 *
 * `interpolateEnvAsync` is non-strict by default: on an unresolved `${VAR}` it
 * pushes a warning and returns the LITERAL `${VAR}` text rather than throwing
 * (see `src/core/secrets.ts` `interpolateEnv`). `applyResolved` previously did
 * `const { config: interpolated } = await interpolateEnvAsync(...)` — discarding
 * `result.warnings` entirely. The consequence: an apply with a missing env var
 * (or an undecryptable catalog value left as a placeholder) wrote a literal
 * `${VAR}` into the native config with ZERO surfaced signal — a silent broken
 * server reported as a clean apply.
 *
 * Fix: capture the warnings and surface them via the EXISTING
 * `ApplyResolvedResult.notices: string[]` channel (the same advisory precedent
 * the default-passthrough signpost uses), prefixed with `interpolation:`. This
 * does NOT change strictness/default-fail behaviour — the value is still left
 * as the literal `${VAR}`; we just no longer swallow the warning.
 *
 * Security/data-loss regression: the assertions below prove (1) the unresolved
 * variable produces a surfaced notice, and (2) the literal `${VAR}` is still
 * present in the resolved output — i.e. the warning is surfaced, the value is
 * not silently mutated. The controller is I/O-free (ADR-0040): it RETURNS
 * notices; each surface renders them.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { writeConfig } from "../../src/core/config";
import { applyResolved } from "../../src/core/controller";
import { initRepo } from "../../src/core/git";
import { interpolateEnvAsync } from "../../src/core/secrets";
import { type TestDir, createTestDir } from "../helpers/tmp";

describe("applyResolved — interpolation warnings (M9)", () => {
  let dir: TestDir | undefined;
  const originalConfigDir = process.env.AM_CONFIG_DIR;
  const originalMissingVar = process.env.AM_M9_MISSING_VAR;

  beforeEach(async () => {
    dir = await createTestDir("am-apply-interp-warn-");
    process.env.AM_CONFIG_DIR = dir.path;
    // Make sure the referenced variable is genuinely UNresolvable so the
    // non-strict interpolator pushes a warning. Remove rather than set so a
    // stray value from another test/run can't accidentally resolve it.
    Reflect.deleteProperty(process.env, "AM_M9_MISSING_VAR");
    await initRepo(dir.path);
  });

  afterEach(async () => {
    // Restore (or delete) env vars — assigning `undefined` would coerce to the
    // string "undefined", so remove the key when there was no original.
    if (originalConfigDir === undefined) Reflect.deleteProperty(process.env, "AM_CONFIG_DIR");
    else process.env.AM_CONFIG_DIR = originalConfigDir;
    if (originalMissingVar === undefined) Reflect.deleteProperty(process.env, "AM_M9_MISSING_VAR");
    else process.env.AM_M9_MISSING_VAR = originalMissingVar;
    if (dir) await dir.cleanup();
    dir = undefined;
  });

  test("an unresolved ${VAR} in a server env surfaces a notice (not silently written)", async () => {
    if (!dir) throw new Error("test setup failed");
    // A server with a real `[profiles.work]` scope so the default-passthrough
    // notice does NOT fire — this isolates the interpolation notice.
    await writeConfig(join(dir.path, "config.toml"), {
      settings: { default_profile: "work" },
      servers: {
        fetch: {
          command: "uvx",
          args: ["mcp-server-fetch"],
          transport: "stdio",
          enabled: true,
          env: { API_KEY: "${AM_M9_MISSING_VAR}" },
        },
      },
      profiles: {
        work: { servers: ["fetch"] },
      },
    });

    const result = await applyResolved(dir.path, { dryRun: true, target: "claude-code" });

    // (1) The unresolved-variable warning is surfaced via notices.
    const interpNotices = result.notices.filter((n) => n.startsWith("interpolation:"));
    expect(interpNotices).toHaveLength(1);
    expect(interpNotices[0]).toContain("AM_M9_MISSING_VAR");
    expect(interpNotices[0]).toContain("Unresolved variable");

    // (2) Advisory only — must not flip apply status.
    expect(result.failed).toHaveLength(0);
  });

  test("a fully-resolved config produces no interpolation notice", async () => {
    if (!dir) throw new Error("test setup failed");
    process.env.AM_M9_MISSING_VAR = "resolved-value";
    await writeConfig(join(dir.path, "config.toml"), {
      settings: { default_profile: "work" },
      servers: {
        fetch: {
          command: "uvx",
          args: ["mcp-server-fetch"],
          transport: "stdio",
          enabled: true,
          env: { API_KEY: "${AM_M9_MISSING_VAR}" },
        },
      },
      profiles: {
        work: { servers: ["fetch"] },
      },
    });

    const result = await applyResolved(dir.path, { dryRun: true, target: "claude-code" });

    expect(result.notices.filter((n) => n.startsWith("interpolation:"))).toHaveLength(0);
  });

  test("the literal ${VAR} survives interpolation — warning is surfaced, value is NOT mutated", async () => {
    // This is the underlying invariant `applyResolved` relies on: non-strict
    // interpolation must (a) emit a warning for an unresolved variable and
    // (b) leave the LITERAL `${VAR}` in place. Proving the value is unchanged
    // closes the data-loss hazard: surfacing the warning must not be coupled to
    // silently rewriting (or dropping) the placeholder. `applyResolved` only
    // re-exposes `warnings` (via notices); the value path is untouched.
    const { config: out, warnings } = await interpolateEnvAsync({
      servers: {
        fetch: {
          command: "uvx",
          args: ["mcp-server-fetch"],
          transport: "stdio",
          enabled: true,
          env: { API_KEY: "${AM_M9_MISSING_VAR}" },
        },
      },
    });

    expect(warnings.some((w) => w.includes("AM_M9_MISSING_VAR"))).toBe(true);
    // The literal placeholder is preserved verbatim — not blanked, not dropped.
    expect(out.servers?.fetch?.env?.API_KEY).toBe("${AM_M9_MISSING_VAR}");
  });
});
