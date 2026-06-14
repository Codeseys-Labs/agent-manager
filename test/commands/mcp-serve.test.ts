import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { mcpServeCommand } from "../../src/commands/mcp-serve";
import { writeConfig } from "../../src/core/config";
import { initRepo } from "../../src/core/git";
import type { Config } from "../../src/core/schema";
import { McpServer } from "../../src/mcp/server";
import { resolveMeta } from "../helpers/citty";
import { type TestDir, createTestDir } from "../helpers/tmp";

describe("mcp-serve command", () => {
  test("meta name is 'mcp-serve'", async () => {
    expect((await resolveMeta(mcpServeCommand))?.name).toBe("mcp-serve");
  });

  test("meta has description", async () => {
    expect((await resolveMeta(mcpServeCommand))?.description).toBeTruthy();
    expect(typeof (await resolveMeta(mcpServeCommand))?.description).toBe("string");
  });

  test("declares a --profile arg", async () => {
    const args = mcpServeCommand.args as Record<string, { type: string }>;
    expect(args.profile).toBeDefined();
    expect(args.profile.type).toBe("string");
  });
});

// (f) ADR-0055: the McpServer `connectionProfile` constructor seam (which the
// `--profile` flag feeds) must take PRECEDENCE over the AM_MCP_PROFILE env. We
// drive `am_get_scope` over the in-process request handler — its manifest
// reports the SAME profile name the gateway gated on, so it is the ground truth
// for "which profile is active".
describe("mcp-serve --profile precedence (ADR-0055)", () => {
  let dir: TestDir;
  const originalConfigDir = process.env.AM_CONFIG_DIR;
  const originalProfileEnv = process.env.AM_MCP_PROFILE;

  afterEach(async () => {
    if (originalConfigDir) process.env.AM_CONFIG_DIR = originalConfigDir;
    else Reflect.deleteProperty(process.env, "AM_CONFIG_DIR");
    if (originalProfileEnv) process.env.AM_MCP_PROFILE = originalProfileEnv;
    else Reflect.deleteProperty(process.env, "AM_MCP_PROFILE");
    if (dir) await dir.cleanup();
  });

  async function setup(): Promise<string> {
    dir = await createTestDir("am-mcp-serve-profile-");
    const configDir = dir.path;
    process.env.AM_CONFIG_DIR = configDir;
    await initRepo(configDir);
    const config: Config = {
      settings: { default_profile: "default", mcp_serve: { tools: ["core", "registry"] } },
      profiles: {
        default: {},
        // Both keep `core` (so the diagnostic am_get_scope tool stays callable),
        // but differ in whether `registry` is in scope — making the resolved
        // tool_groups unambiguous about which profile actually won.
        flag: { scope: { tool_groups: ["core"] } },
        env: { scope: { tool_groups: ["core", "registry"] } },
      },
    };
    await writeConfig(join(configDir, "config.toml"), config);
    return configDir;
  }

  async function getScope(server: McpServer): Promise<Record<string, any>> {
    const resp = await server.handleRequest({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "am_get_scope", arguments: {} },
    });
    const result = resp?.result as Record<string, any>;
    return JSON.parse(result.content[0].text) as Record<string, any>;
  }

  test("the connectionProfile constructor option overrides AM_MCP_PROFILE env", async () => {
    await setup();
    // Env points at `env` (registry-only); the flag-seeded option points at
    // `flag` (core-only). The flag MUST win.
    process.env.AM_MCP_PROFILE = "env";
    const server = new McpServer({
      auth: { token: undefined, allowUnsafeLocal: true },
      connectionProfile: "flag",
    });

    const manifest = await getScope(server);
    expect(manifest.profile).toBe("flag");
    expect(manifest.toolGroups).toEqual(["core"]);
    // registry is narrowed out by the `flag` profile, proving env did NOT win.
    expect(manifest.effectiveTools).not.toContain("am_registry_search");
  });

  test("AM_MCP_PROFILE env is still honored when no flag is supplied", async () => {
    await setup();
    process.env.AM_MCP_PROFILE = "env";
    const server = new McpServer({ auth: { token: undefined, allowUnsafeLocal: true } });
    // The env channel is read at the `initialize` handshake (the wire entry
    // point), so drive it before resolving scope — mirroring a real client.
    await server.handleRequest({
      jsonrpc: "2.0",
      id: 0,
      method: "initialize",
      params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "t" } },
    });

    const manifest = await getScope(server);
    expect(manifest.profile).toBe("env");
    expect(manifest.toolGroups).toEqual(["core", "registry"]);
  });

  test("the --profile flag still wins even after an initialize with AM_MCP_PROFILE set", async () => {
    await setup();
    process.env.AM_MCP_PROFILE = "env";
    const server = new McpServer({
      auth: { token: undefined, allowUnsafeLocal: true },
      connectionProfile: "flag",
    });
    // Even when initialize runs (which would normally consult the env), the
    // flag-seeded connectionProfile must NOT be overwritten — the explicit
    // operator binding outranks the env.
    await server.handleRequest({
      jsonrpc: "2.0",
      id: 0,
      method: "initialize",
      params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "t" } },
    });

    const manifest = await getScope(server);
    expect(manifest.profile).toBe("flag");
    expect(manifest.toolGroups).toEqual(["core"]);
  });

  // fix-1-0: an EXPLICITLY-named profile that is absent from config.profiles (a
  // typo, or a profile that was deleted) must NOT silently widen to the global
  // ceiling. It fails CLOSED to the maximally-restrictive scope so an operator
  // who deliberately named a confinement profile is never accidentally exposed
  // to the full registry-bearing ceiling. The DIAGNOSTIC_SCOPE_EXEMPT carve-out
  // keeps am_get_scope callable so the breakage is visible + fixable over MCP.
  test("an explicit connectionProfile that does not exist fails CLOSED (no ceiling widening)", async () => {
    await setup();
    const server = new McpServer({
      auth: { token: undefined, allowUnsafeLocal: true },
      connectionProfile: "does-not-exist",
    });

    const manifest = await getScope(server);
    // The resolved profile name is the explicit (missing) one — no drift.
    expect(manifest.profile).toBe("does-not-exist");
    // Fail-closed: the empty scope narrows EVERY group out, so NO ceiling tool
    // (registry write tools, etc.) is effective. am_registry_search is a ceiling
    // tool under the `registry` group — it must be excluded.
    expect(manifest.effectiveTools).not.toContain("am_registry_search");
    // R2-4 NO-DRIFT: under scopeFailClosed the dispatch gate (isToolScoped)
    // STILL lets the DIAGNOSTIC_SCOPE_EXEMPT tools through — so the manifest
    // MUST report them as effective, or the audit surface drifts from
    // enforcement (am_get_scope succeeded above, so it is provably callable).
    expect(manifest.effectiveTools).toEqual(["am_doctor", "am_get_scope"]);
    // …and they must NOT appear in excludedTools (a tool can't be both).
    expect(manifest.excludedTools).not.toContain("am_doctor");
    expect(manifest.excludedTools).not.toContain("am_get_scope");
    // The scope is the maximally-restrictive empty scope, not the ceiling.
    expect(manifest.scoped).toBe(true);
    expect(manifest.toolGroups).toEqual([]);

    // The diagnostic tool itself stays callable (DIAGNOSTIC_SCOPE_EXEMPT) even
    // while failing closed — that's how getScope() succeeded above. A ceiling
    // write tool, by contrast, is refused by the dispatch gate.
    const denied = await server.handleRequest({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "am_registry_search", arguments: { query: "x" } },
    });
    expect(denied?.error?.code).toBe(-32601);

    // R2-4 POSITIVE: am_doctor (the OTHER DIAGNOSTIC_SCOPE_EXEMPT tool that the
    // manifest now lists as effective) really IS dispatchable under fail-closed
    // — it is not refused by the scope gate (-32601 "not available …"). This
    // proves the manifest's effectiveTools claim, closing the drift.
    const doctored = await server.handleRequest({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "am_doctor", arguments: {} },
    });
    const doctorMsg = doctored?.error?.message ?? "";
    expect(doctorMsg).not.toContain("not available in the active profile");
  });

  test("settings.default_profile naming a missing profile also fails CLOSED", async () => {
    dir = await createTestDir("am-mcp-serve-profile-");
    const configDir = dir.path;
    process.env.AM_CONFIG_DIR = configDir;
    Reflect.deleteProperty(process.env, "AM_MCP_PROFILE");
    await initRepo(configDir);
    // default_profile points at a profile that is NOT in the profiles table —
    // an explicit (settings-supplied) name that is missing → fail closed.
    const config: Config = {
      settings: {
        default_profile: "ghost",
        mcp_serve: { tools: ["core", "registry"] },
      },
      profiles: {
        // `ghost` deliberately absent; only `real` exists.
        real: { scope: { tool_groups: ["core"] } },
      },
    };
    await writeConfig(join(configDir, "config.toml"), config);

    const server = new McpServer({ auth: { token: undefined, allowUnsafeLocal: true } });
    const manifest = await getScope(server);
    expect(manifest.profile).toBe("ghost");
    expect(manifest.effectiveTools).not.toContain("am_registry_search");
    // R2-4 NO-DRIFT: same fail-closed reasoning as the does-not-exist case —
    // the diagnostic tools stay callable, so they stay in effectiveTools.
    expect(manifest.effectiveTools).toEqual(["am_doctor", "am_get_scope"]);
    expect(manifest.excludedTools).not.toContain("am_doctor");
    expect(manifest.excludedTools).not.toContain("am_get_scope");
    expect(manifest.scoped).toBe(true);
    expect(manifest.toolGroups).toEqual([]);
  });

  // R2-4 NO-DRIFT (malformed-config path): the OTHER scopeFailClosed entry
  // point is refreshSettings' catch branch (a config that EXISTS but fails to
  // parse/validate — e.g. a bogus tool_groups enum). It pins ceiling=[] and an
  // empty scope. The diagnostic tools must still be both callable AND reported
  // as effective by am_get_scope, or the audit surface drifts from enforcement.
  test("a malformed config (invalid tool_groups) fails CLOSED but still lists the diagnostic tools as effective", async () => {
    dir = await createTestDir("am-mcp-serve-profile-");
    const configDir = dir.path;
    process.env.AM_CONFIG_DIR = configDir;
    Reflect.deleteProperty(process.env, "AM_MCP_PROFILE");
    await initRepo(configDir);
    // Write a config.toml whose `default` profile declares an INVALID tool group
    // ("bogus" is not in the McpToolGroup enum). loadResolvedConfig's ZodError
    // propagates to refreshSettings' catch branch → scopeFailClosed = true,
    // ceiling = [], scope = empty. We write the TOML by hand because writeConfig
    // would reject the invalid value before it ever reaches disk.
    await Bun.write(
      join(configDir, "config.toml"),
      ["[profiles.default.scope]", 'tool_groups = ["bogus"]', ""].join("\n"),
    );

    const server = new McpServer({ auth: { token: undefined, allowUnsafeLocal: true } });
    const manifest = await getScope(server);
    // Fail-closed ceiling ∩ ∅ = ∅ for everything EXCEPT the diagnostic carve-out.
    expect(manifest.effectiveTools).not.toContain("am_registry_search");
    expect(manifest.effectiveTools).toEqual(["am_doctor", "am_get_scope"]);
    expect(manifest.excludedTools).not.toContain("am_doctor");
    expect(manifest.excludedTools).not.toContain("am_get_scope");
    expect(manifest.scoped).toBe(true);
    expect(manifest.toolGroups).toEqual([]);

    // Enforcement side: the diagnostic tools dispatch, a ceiling tool is refused.
    const doctored = await server.handleRequest({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "am_doctor", arguments: {} },
    });
    expect(doctored?.error?.message ?? "").not.toContain("not available in the active profile");
    const denied = await server.handleRequest({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "am_registry_search", arguments: { query: "x" } },
    });
    expect(denied?.error?.code).toBe(-32601);
  });

  // REGRESSION GUARD: the fresh-install case (no profiles table, no
  // default_profile → bare hardcoded "default" literal fallback) must remain
  // the global ceiling (undefined scope). The explicit-vs-implicit split must
  // NOT break minimal configs that never declared any boundary.
  test("bare 'default' fallback (no profiles, no default_profile) stays the global ceiling", async () => {
    dir = await createTestDir("am-mcp-serve-profile-");
    const configDir = dir.path;
    process.env.AM_CONFIG_DIR = configDir;
    Reflect.deleteProperty(process.env, "AM_MCP_PROFILE");
    await initRepo(configDir);
    // No `default_profile`, no `profiles` table — only the ceiling is declared.
    const config: Config = {
      settings: { mcp_serve: { tools: ["core", "registry"] } },
    };
    await writeConfig(join(configDir, "config.toml"), config);

    const server = new McpServer({ auth: { token: undefined, allowUnsafeLocal: true } });
    const manifest = await getScope(server);
    expect(manifest.profile).toBe("default");
    // undefined scope = global ceiling unchanged → ceiling tools ARE effective.
    expect(manifest.scoped).toBe(false);
    expect(manifest.effectiveTools).toContain("am_registry_search");

    // A ceiling write tool is callable (the gate only fires when this.scope is
    // defined; here scope is undefined → no profile narrowing).
    const allowed = await server.handleRequest({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "am_registry_search", arguments: { query: "x" } },
    });
    // Not refused by the scope gate (-32601 "not available in the active
    // profile"). It may return its own result/isError, but never the scope
    // denial that the explicit-missing case produced.
    const msg = allowed?.error?.message ?? "";
    expect(msg).not.toContain("not available in the active profile");
  });
});
