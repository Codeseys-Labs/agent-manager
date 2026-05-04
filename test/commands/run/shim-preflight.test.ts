/**
 * Tier-2 shim pre-flight (2026-05-03).
 *
 * `am run <tier-2-shim>` spawns `am-acp-shell <name>`, which requires the
 * `am-acp-shell` second binary to be on PATH. Pre-rc6 installs shipped
 * only `am`, so users would hit an opaque ENOENT. checkShimPreflight
 * translates that case into a typed error the run command prints before
 * spawning.
 *
 * Pinned behaviors:
 *   - Non-shim commands (anything not starting with `am-acp-shell`)
 *     always return ok.
 *   - When whichFn returns a path, the result is ok with `resolved` set.
 *   - When whichFn returns null, the result is `{ ok: false, error, hint }`
 *     with install-path guidance.
 *   - The error mentions `am-acp-shell` by name so error search is easy.
 *   - Variant-resolved commands are parsed the same way as top-level
 *     acp.command (tests both branches: `am-acp-shell aider` and
 *     `claude-agent-acp --acp`).
 */

import { afterEach, describe, expect, test } from "bun:test";
import { __setDryRunWhichFnForTests, checkShimPreflight } from "../../../src/commands/run";

afterEach(() => {
  __setDryRunWhichFnForTests(null);
});

describe("checkShimPreflight", () => {
  test("non-shim command returns ok without probing PATH", () => {
    __setDryRunWhichFnForTests(() => {
      throw new Error("must not probe PATH for non-shim");
    });
    const res = checkShimPreflight("claude-agent-acp --acp");
    expect(res.ok).toBe(true);
  });

  test("shim command with am-acp-shell present → ok + resolved path", () => {
    __setDryRunWhichFnForTests((name) =>
      name === "am-acp-shell" ? "/Users/user/.local/bin/am-acp-shell" : null,
    );
    const res = checkShimPreflight("am-acp-shell aider");
    expect(res.ok).toBe(true);
    expect(res.resolved).toBe("/Users/user/.local/bin/am-acp-shell");
  });

  test("shim command without am-acp-shell on PATH → actionable error + hint", () => {
    __setDryRunWhichFnForTests(() => null);
    const res = checkShimPreflight("am-acp-shell aider");
    expect(res.ok).toBe(false);
    expect(res.error).toContain("am-acp-shell");
    expect(res.error).toContain("PATH");
    expect(res.hint).toContain("install.sh");
  });

  test("works with absolute-path `am-acp-shell` command (variant override)", () => {
    // parseCommand extracts the first token; an absolute path does NOT
    // parse as executable === 'am-acp-shell' because it's a full path.
    // So the check is a no-op for absolute-path commands — the user
    // has taken explicit control of where am-acp-shell lives.
    __setDryRunWhichFnForTests(() => {
      throw new Error("must not probe PATH for absolute-path commands");
    });
    const res = checkShimPreflight("/opt/special/am-acp-shell aider");
    expect(res.ok).toBe(true);
  });

  test("ignores non-tier-2 shims that happen to contain 'acp' in the name", () => {
    __setDryRunWhichFnForTests(() => {
      throw new Error("must not probe PATH");
    });
    // Real tier-1 command like `claude-agent-acp` — token is NOT
    // `am-acp-shell`, so check skips.
    const res = checkShimPreflight("claude-agent-acp --acp");
    expect(res.ok).toBe(true);
  });
});
