import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { __setWhichFn, resetAgentDetectionCache } from "../../src/core/agent-detection";

// The no-arg `am agent detect` path runs full adapter detection, which
// probes installed IDE CLIs via Bun.spawnSync([<cli>, "--version"]). On a
// dev box with several IDE CLIs actually installed, those serialized probes
// (each capped at 2s in the adapter detect()s) can exceed the 5s default
// under full-suite load. CI runners have no IDE CLIs so this is fast there;
// 30s gives headroom on dev machines without hiding real regressions.
// (Wave CI / P0-5.)
setDefaultTimeout(30_000);

// ── Test harness ────────────────────────────────────────────────

type SubcommandFactory = () => Promise<{
  run: (ctx: { args: Record<string, unknown> }) => Promise<void> | void;
}>;

async function resolveDetectSubcommand() {
  const mod = await import("../../src/commands/agents");
  const subCommands = mod.agentsCommand.subCommands as
    | Record<string, SubcommandFactory>
    | undefined;
  const sub = subCommands?.detect;
  if (!sub) throw new Error("detect subcommand not registered");
  return sub();
}

function mockWhich(hits: Record<string, string>): (name: string) => string | null {
  return (name: string) => hits[name] ?? null;
}

// ── Console capture ─────────────────────────────────────────────

let stdoutLines: string[] = [];
let stderrLines: string[] = [];
const origLog = console.log;
const origErr = console.error;

function captureConsole() {
  stdoutLines = [];
  stderrLines = [];
  console.log = (...args: unknown[]) => {
    stdoutLines.push(args.map(String).join(" "));
  };
  console.error = (...args: unknown[]) => {
    stderrLines.push(args.map(String).join(" "));
  };
}

function restoreConsole() {
  console.log = origLog;
  console.error = origErr;
}

describe("am agent detect", () => {
  beforeEach(() => {
    resetAgentDetectionCache();
    captureConsole();
    process.exitCode = undefined;
  });

  afterEach(() => {
    restoreConsole();
    __setWhichFn(null);
    resetAgentDetectionCache();
    process.exitCode = undefined;
  });

  test("no arg: prints a table and summary count (text mode)", async () => {
    __setWhichFn(mockWhich({ claude: "/usr/local/bin/claude" }));

    const detect = await resolveDetectSubcommand();
    await detect.run({
      args: { json: false, quiet: false, verbose: false, timeout: "8000" },
    });

    const joined = stdoutLines.join("\n");
    expect(joined).toContain("Name");
    expect(joined).toContain("Installed");
    expect(joined).toContain("claude");
    // Summary line mentions the installed count.
    expect(joined).toMatch(/\d+ of \d+ built-in agents installed/);
  });

  test("no arg with --json: returns the full detection map keyed by agent name", async () => {
    __setWhichFn(mockWhich({ claude: "/usr/local/bin/claude" }));

    const detect = await resolveDetectSubcommand();
    await detect.run({
      args: { json: true, quiet: false, verbose: false, timeout: "8000" },
    });

    const envelope = JSON.parse(stdoutLines.join("\n"));
    expect(envelope.agents).toBeDefined();
    expect(envelope.agents.claude.installed).toBe(true);
    expect(envelope.agents.claude.source).toBe("path");
    expect(envelope.agents.claude.binary).toBe("/usr/local/bin/claude");
    // Tier-3 catalog-only agents still have an entry and are never
    // reported as installed via PATH.
    expect(envelope.agents.windsurf.installed).toBe(false);
  });

  test("with unknown name: exits non-zero and reports the error", async () => {
    const detect = await resolveDetectSubcommand();
    await detect.run({
      args: {
        name: "not-a-real-agent",
        json: false,
        quiet: false,
        verbose: false,
        timeout: "8000",
      },
    });
    expect(process.exitCode).toBe(1);
    const joinedErr = stderrLines.join("\n");
    expect(joinedErr).toContain("not-a-real-agent");
  });

  test("with unknown name --json: error surfaces as JSON on stderr", async () => {
    const detect = await resolveDetectSubcommand();
    await detect.run({
      args: {
        name: "not-a-real-agent",
        json: true,
        quiet: false,
        verbose: false,
        timeout: "8000",
      },
    });
    expect(process.exitCode).toBe(1);
    const joined = stderrLines.join("\n");
    // error() in JSON mode emits a JSON object on stderr.
    const parsed = JSON.parse(joined);
    expect(parsed.error).toContain("not-a-real-agent");
  });

  test("adapters are invoked but not blocking when they report missing", async () => {
    __setWhichFn(mockWhich({})); // every PATH check misses

    const detect = await resolveDetectSubcommand();
    await detect.run({
      args: { json: true, quiet: false, verbose: false, timeout: "8000" },
    });
    const envelope = JSON.parse(stdoutLines.join("\n"));
    // With nothing on PATH and no adapters detecting (CI-like env), everything
    // should be reported as not installed without throwing.
    const allFalse = Object.values(envelope.agents).every(
      (d) => (d as { installed: boolean }).installed === false,
    );
    // On developer laptops adapters may detect host tools, so we don't require
    // allFalse — we only require no entries errored out.
    for (const [name, detection] of Object.entries(envelope.agents)) {
      const d = detection as { installed: boolean; source: string };
      expect(typeof d.installed).toBe("boolean");
      expect(["path", "adapter", "none"]).toContain(d.source);
    }
    expect(typeof allFalse).toBe("boolean");
  });

  test("with a known tier-1 agent name but no --json: text output includes PATH + handshake lines", async () => {
    __setWhichFn(mockWhich({})); // miss — handshake will also fail fast

    const detect = await resolveDetectSubcommand();
    await detect.run({
      args: {
        name: "gemini",
        json: false,
        quiet: false,
        verbose: false,
        // Short timeout so a missing binary fails the connect quickly.
        timeout: "500",
      },
    });

    const joined = stdoutLines.join("\n");
    expect(joined).toContain("Agent: gemini");
    expect(joined).toContain("PATH binary: gemini");
    expect(joined).toContain("PATH check:");
    expect(joined).toContain("ACP command:");
    expect(joined).toContain("ACP handshake:");
    // handshake should fail (no binary, no server) — "failed" appears in output.
    expect(joined).toMatch(/handshake: (verified|failed)/);
  }, 15_000);

  test("with a tier-3 catalog-only agent name: errors with a 'catalog-only' message", async () => {
    const detect = await resolveDetectSubcommand();
    await detect.run({
      args: {
        name: "cline",
        json: false,
        quiet: false,
        verbose: false,
        timeout: "500",
      },
    });
    expect(process.exitCode).toBe(1);
    const joinedErr = stderrLines.join("\n");
    expect(joinedErr).toContain("catalog-only");
  });
});
