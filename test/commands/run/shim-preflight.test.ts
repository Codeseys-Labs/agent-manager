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
import {
  __setDryRunWhichFnForTests,
  checkNativeAgentPreflight,
  checkShimPreflight,
} from "../../../src/commands/run";

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

describe("checkNativeAgentPreflight (2026-05-03-E novice hints)", () => {
  afterEach(() => {
    __setDryRunWhichFnForTests(null);
  });

  test("returns ok with resolved when binary is on PATH", () => {
    __setDryRunWhichFnForTests((name) =>
      name === "claude-agent-acp" ? "/usr/local/bin/claude-agent-acp" : null,
    );
    const res = checkNativeAgentPreflight("claude-agent-acp --acp", "claude");
    expect(res.ok).toBe(true);
    expect(res.resolved).toBe("/usr/local/bin/claude-agent-acp");
  });

  test("refuses with actionable error when binary missing (no more opaque EPERM)", () => {
    __setDryRunWhichFnForTests(() => null);
    const res = checkNativeAgentPreflight("claude-agent-acp --acp", "claude");
    expect(res.ok).toBe(false);
    expect(res.error).toContain("claude"); // agent name
    expect(res.error).toContain("claude-agent-acp"); // executable
    expect(res.error).toContain("PATH");
    expect(res.hint).toContain("am agent list --runnable");
  });

  test("passes through am-acp-shell — that's checkShimPreflight's job", () => {
    __setDryRunWhichFnForTests(() => {
      throw new Error("must not probe for shim — distinct check");
    });
    const res = checkNativeAgentPreflight("am-acp-shell aider", "aider");
    expect(res.ok).toBe(true);
  });

  test("skips absolute paths — user has explicit control", () => {
    __setDryRunWhichFnForTests(() => {
      throw new Error("must not probe absolute-path commands");
    });
    const res = checkNativeAgentPreflight("/opt/special/claude --acp", "claude");
    expect(res.ok).toBe(true);
  });

  test("skips relative paths", () => {
    __setDryRunWhichFnForTests(() => {
      throw new Error("must not probe relative-path commands");
    });
    const res = checkNativeAgentPreflight("./bin/local-claude --acp", "claude");
    expect(res.ok).toBe(true);
  });

  test("FINAL-REV-W2: skips ../ parent-relative paths", () => {
    __setDryRunWhichFnForTests(() => {
      throw new Error("must not probe ../ commands");
    });
    const res = checkNativeAgentPreflight("../shared/bin/claude --acp", "claude");
    expect(res.ok).toBe(true);
  });

  test("FINAL-REV-W2: skips Windows backslash relative paths (.\\, ..\\)", () => {
    __setDryRunWhichFnForTests(() => {
      throw new Error("must not probe Windows-relative commands");
    });
    expect(checkNativeAgentPreflight(".\\bin\\claude.exe --acp", "claude").ok).toBe(true);
    expect(checkNativeAgentPreflight("..\\shared\\claude.exe --acp", "claude").ok).toBe(true);
  });

  test("FINAL-REV-W2: skips Windows drive-letter absolute paths", () => {
    __setDryRunWhichFnForTests(() => {
      throw new Error("must not probe Windows absolute commands");
    });
    expect(checkNativeAgentPreflight("C:\\Program Files\\claude.exe --acp", "claude").ok).toBe(
      true,
    );
    expect(checkNativeAgentPreflight("D:/tools/claude --acp", "claude").ok).toBe(true);
  });

  test("probes npx/bunx wrappers but only to check the runner is installed", () => {
    __setDryRunWhichFnForTests((name) => (name === "npx" ? "/usr/bin/npx" : null));
    const res = checkNativeAgentPreflight("npx -y @vendor/claude-agent-acp", "claude");
    expect(res.ok).toBe(true);
    expect(res.resolved).toBe("/usr/bin/npx");
  });

  test("missing npx wrapper → error names the runner (not the inner package)", () => {
    __setDryRunWhichFnForTests(() => null);
    const res = checkNativeAgentPreflight("npx -y @vendor/claude-agent-acp", "claude");
    expect(res.ok).toBe(false);
    expect(res.error).toContain("npx");
    expect(res.hint).toContain("Node.js");
  });
});
