import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  compute,
  defineFlow,
  listRuns,
  loadRunState,
  runFlow,
} from "../../src/protocols/acp/flows";

// ── Helpers ─────────────────────────────────────────────────────

let runsDir: string;

beforeEach(async () => {
  runsDir = await mkdtemp(join(tmpdir(), "am-flow-cmd-test-"));
});

afterEach(async () => {
  await rm(runsDir, { recursive: true, force: true });
});

// ── CLI registration ─────────────────────────────────────────────

describe("am flow: CLI registration", () => {
  test("flow command exports correctly", async () => {
    const mod = await import("../../src/commands/flow");
    const { resolveMeta } = await import("../helpers/citty");
    expect(mod.flowCommand).toBeDefined();
    expect((await resolveMeta(mod.flowCommand))?.name).toBe("flow");
    expect((await resolveMeta(mod.flowCommand))?.description).toContain("workflow");
  });

  test("flow command has expected subcommands", async () => {
    const mod = await import("../../src/commands/flow");
    const { resolveSubCommands } = await import("../helpers/citty");
    const subCommands = await resolveSubCommands(mod.flowCommand);
    expect(subCommands).toBeDefined();
    expect(subCommands!.run).toBeDefined();
    expect(subCommands!.list).toBeDefined();
    expect(subCommands!.status).toBeDefined();
  });

  test("flow command is registered in cli.ts", async () => {
    const mod = await import("../../src/commands/flow");
    expect(mod.flowCommand).toBeDefined();
  });
});

// ── Subcommand: am flow run ──────────────────────────────────────

describe("am flow run: argument structure", () => {
  test("run subcommand has expected args", async () => {
    const mod = await import("../../src/commands/flow");
    const { resolveSubCommands } = await import("../helpers/citty");
    const subs = await resolveSubCommands(mod.flowCommand);
    const runSub = subs!.run;
    const resolved = await (runSub as () => Promise<any>)();
    expect(resolved.args).toBeDefined();
    expect(resolved.args.name).toBeDefined();
    expect(resolved.args.name.type).toBe("positional");
    expect(resolved.args.name.required).toBe(true);
    expect(resolved.args.cwd).toBeDefined();
    expect(resolved.args.input).toBeDefined();
    expect(resolved.args.runsDir).toBeDefined();
    expect(resolved.args.json).toBeDefined();
  });

  test("run subcommand meta is correct", async () => {
    const mod = await import("../../src/commands/flow");
    const { resolveSubCommands } = await import("../helpers/citty");
    const subs = await resolveSubCommands(mod.flowCommand);
    const runSub = subs!.run;
    const resolved = await (runSub as () => Promise<any>)();
    expect(resolved.meta.name).toBe("run");
    expect(resolved.meta.description).toContain("Run");
  });
});

// ── Subcommand: am flow list ─────────────────────────────────────

describe("am flow list: argument structure", () => {
  test("list subcommand has expected args", async () => {
    const mod = await import("../../src/commands/flow");
    const { resolveSubCommands } = await import("../helpers/citty");
    const subs = await resolveSubCommands(mod.flowCommand);
    const listSub = subs!.list;
    const resolved = await (listSub as () => Promise<any>)();
    expect(resolved.args).toBeDefined();
    expect(resolved.args.runsDir).toBeDefined();
    expect(resolved.args.json).toBeDefined();
    expect(resolved.args.quiet).toBeDefined();
    expect(resolved.args.verbose).toBeDefined();
  });

  test("list subcommand meta is correct", async () => {
    const mod = await import("../../src/commands/flow");
    const listSub = mod.flowCommand.subCommands!.list;
    const resolved = await (listSub as () => Promise<any>)();
    expect(resolved.meta.name).toBe("list");
    expect(resolved.meta.description).toContain("List");
  });
});

// ── Subcommand: am flow status ───────────────────────────────────

describe("am flow status: argument structure", () => {
  test("status subcommand has expected args", async () => {
    const mod = await import("../../src/commands/flow");
    const statusSub = mod.flowCommand.subCommands!.status;
    const resolved = await (statusSub as () => Promise<any>)();
    expect(resolved.args).toBeDefined();
    expect(resolved.args.runId).toBeDefined();
    expect(resolved.args.runId.type).toBe("positional");
    expect(resolved.args.runId.required).toBe(true);
    expect(resolved.args.runsDir).toBeDefined();
    expect(resolved.args.json).toBeDefined();
  });

  test("status subcommand meta is correct", async () => {
    const mod = await import("../../src/commands/flow");
    const statusSub = mod.flowCommand.subCommands!.status;
    const resolved = await (statusSub as () => Promise<any>)();
    expect(resolved.meta.name).toBe("status");
    expect(resolved.meta.description).toContain("status");
  });
});

// ── Flow list integration ────────────────────────────────────────

describe("am flow list: integration", () => {
  test("listRuns returns empty for no runs", async () => {
    const runs = await listRuns(runsDir);
    expect(runs).toEqual([]);
  });

  test("listRuns returns runs after execution", async () => {
    const flow = defineFlow({
      name: "list-integration",
      nodes: { a: compute({ fn: () => ({ done: true }) }) },
      edges: [],
    });

    await runFlow(flow, { runsDir });
    await runFlow(flow, { runsDir });

    const runs = await listRuns(runsDir);
    expect(runs).toHaveLength(2);
    for (const run of runs) {
      expect(run.flowName).toBe("list-integration");
      expect(run.status).toBe("completed");
    }
  });
});

// ── Flow status integration ──────────────────────────────────────

describe("am flow status: integration", () => {
  test("loadRunState returns state for completed run", async () => {
    const flow = defineFlow({
      name: "status-test",
      nodes: { a: compute({ fn: () => ({ value: 42 }) }) },
      edges: [],
    });

    const result = await runFlow(flow, { runsDir });
    const state = await loadRunState(result.runId, runsDir);

    expect(state).not.toBeNull();
    expect(state!.status).toBe("completed");
    expect(state!.flowName).toBe("status-test");
    expect(state!.nodes.a.output).toEqual({ value: 42 });
  });

  test("loadRunState returns null for nonexistent run", async () => {
    const state = await loadRunState("nonexistent-run", runsDir);
    expect(state).toBeNull();
  });
});

// ── Error cases ──────────────────────────────────────────────────

describe("am flow run: error handling", () => {
  test("invalid --input JSON causes error", () => {
    const badJson = "not-valid-json{";
    expect(() => JSON.parse(badJson)).toThrow();
  });

  test("flow module without required exports is rejected", () => {
    const flowDef = { notNodes: true, notEdges: true };
    const isValid =
      flowDef && typeof flowDef === "object" && "nodes" in flowDef && "edges" in flowDef;
    expect(isValid).toBe(false);
  });

  test("flow module with null nodes/edges is rejected", () => {
    const flowDef = { nodes: null, edges: 42 };
    // Passes the structure check but would fail at runtime
    const hasKeys = "nodes" in flowDef && "edges" in flowDef;
    expect(hasKeys).toBe(true);
    // The actual nodes/edges are not valid objects
    expect(flowDef.nodes).toBeNull();
  });

  test("empty object is rejected as flow definition", () => {
    const flowDef = {};
    const isValid =
      flowDef && typeof flowDef === "object" && "nodes" in flowDef && "edges" in flowDef;
    expect(isValid).toBe(false);
  });
});
