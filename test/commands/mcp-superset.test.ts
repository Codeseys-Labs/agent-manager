/**
 * `am mcp-superset` tests (issue #3 problem 1, 2026-05-03).
 *
 * Pins the pure-function contract:
 *   - classifyServer assigns the four copy classes correctly:
 *     stdio → copy, http+env-bearer → copy, http+url-credential → refuse,
 *     disabled → skip
 *   - buildSupersetReport summary counts + entries + exit code
 *   - Exit codes: 0 satisfied / 1 drift / 2 refusal (per research
 *     report §2.1 "git-push-style rejection")
 *   - Redacted detected pattern NEVER echoes the raw credential
 */

import { describe, expect, test } from "bun:test";
import { buildSupersetReport, classifyServer } from "../../src/commands/mcp-superset";

describe("classifyServer", () => {
  test("stdio with command → copy", () => {
    const r = classifyServer("context7", {
      command: "bunx",
      args: ["-y", "@context7/mcp"],
    });
    expect(r.class).toBe("copy");
    expect(r.sourceShape).toBe("stdio");
  });

  test("HTTP URL with api_key in query → refuse", () => {
    const r = classifyServer("tavily", {
      type: "http",
      url: "https://mcp.tavily.com/mcp/?tavilyApiKey=tvly-FAKEFIXTURE1234567890",
    });
    expect(r.class).toBe("refuse");
    expect(r.sourceShape).toBe("http-url-credential");
    expect(r.remediation?.suggestedEnvVar).toBe("${TAVILYAPIKEY}");
    // Never echo the raw credential.
    expect(r.redactedDetectedPattern).not.toContain("tvly-FAKEFIXTURE1234567890");
  });

  test("HTTP URL with bearer-via-env-var in headers → copy (safe to mirror)", () => {
    const r = classifyServer("deepwiki", {
      type: "http",
      url: "https://api.deepwiki.com/mcp",
      headers: { Authorization: "Bearer ${DEEPWIKI_TOKEN}" },
    });
    expect(r.class).toBe("copy");
    expect(r.sourceShape).toBe("http-env-bearer");
  });

  test("disabled:true in global → skip", () => {
    const r = classifyServer("old", { command: "legacy", disabled: true });
    expect(r.class).toBe("skip");
    expect(r.sourceShape).toBe("disabled-in-global");
  });

  test("enabled:false in global → skip (alt spelling)", () => {
    const r = classifyServer("alt", { command: "legacy", enabled: false });
    expect(r.class).toBe("skip");
  });

  test("url in args (mcp-remote wrapper style) → refuse if credential", () => {
    const r = classifyServer("wrapped", {
      command: "npx",
      args: ["mcp-remote", "https://remote.example/?api_key=abcdefghijklmnop1234"],
    });
    expect(r.class).toBe("refuse");
  });
});

describe("buildSupersetReport", () => {
  test("happy path — one copy, one refuse, one skip, one already in project", () => {
    const global = {
      context7: { command: "bunx", args: ["-y", "@context7/mcp"] }, // copy, not in project → to_copy++
      tavily: {
        type: "http",
        url: "https://mcp.tavily.com/mcp/?tavilyApiKey=tvly-secretxxxxxxxxxxx",
      }, // refuse
      old: { command: "legacy", disabled: true }, // skip
      strands: { command: "npx", args: ["strands-mcp"] }, // in project already
    };
    const project = {
      strands: { command: "npx", args: ["strands-mcp"] },
    };

    const report = buildSupersetReport(global, project, {
      globalSource: "/fake/.claude.json",
      projectTarget: "/fake/.mcp.json",
      command: "mcp superset check",
    });

    expect(report.schema_version).toBe(1);
    expect(report.summary.total_global_enabled).toBe(3); // context7 + tavily + strands
    expect(report.summary.to_copy).toBe(1); // context7
    expect(report.summary.to_refuse).toBe(1); // tavily
    expect(report.summary.skipped_disabled).toBe(1); // old
    expect(report.summary.in_project).toBe(1); // strands
  });

  test("exit code 0 — everything satisfied", () => {
    const global = { s: { command: "bunx", args: ["s"] } };
    const project = { s: { command: "bunx", args: ["s"] } };
    const report = buildSupersetReport(global, project, {
      globalSource: "g",
      projectTarget: "p",
      command: "mcp superset check",
    });
    expect(report.exit_code).toBe(0);
  });

  test("exit code 1 — drift only, no refusal", () => {
    const global = { s: { command: "bunx", args: ["s"] } };
    const project = {};
    const report = buildSupersetReport(global, project, {
      globalSource: "g",
      projectTarget: "p",
      command: "mcp superset check",
    });
    expect(report.exit_code).toBe(1);
    expect(report.summary.to_copy).toBe(1);
  });

  test("exit code 2 — refusal dominates drift (distinct category)", () => {
    const global = {
      drift: { command: "bunx", args: ["drift"] }, // class=copy, not in project → drift
      leak: {
        type: "http",
        url: "https://x/?api_key=abcdefghijklmnop1234",
      }, // class=refuse
    };
    const project = {};
    const report = buildSupersetReport(global, project, {
      globalSource: "g",
      projectTarget: "p",
      command: "mcp superset check",
    });
    expect(report.exit_code).toBe(2);
    expect(report.summary.to_copy).toBe(1); // drift still counted
    expect(report.summary.to_refuse).toBe(1);
  });

  test("entries carry action field: add | none | refuse", () => {
    const global = {
      copy_me: { command: "x" }, // add
      already_there: { command: "y" }, // none
      refused: {
        type: "http",
        url: "https://x/?token=abcdefghijklmnop1234",
      }, // refuse
    };
    const project = { already_there: { command: "y" } };
    const report = buildSupersetReport(global, project, {
      globalSource: "g",
      projectTarget: "p",
      command: "mcp superset check",
    });
    const byName = Object.fromEntries(report.entries.map((e) => [e.name, e]));
    expect(byName.copy_me.action).toBe("add");
    expect(byName.already_there.action).toBe("none");
    expect(byName.refused.action).toBe("refuse");
  });

  test("empty global → exit 0 + empty entries", () => {
    const report = buildSupersetReport(
      {},
      {},
      {
        globalSource: "g",
        projectTarget: "p",
        command: "mcp superset check",
      },
    );
    expect(report.exit_code).toBe(0);
    expect(report.entries).toHaveLength(0);
  });
});
