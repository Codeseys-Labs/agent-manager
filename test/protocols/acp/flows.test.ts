import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AcpNodeExecutor,
  type CheckpointHandler,
  DEFAULT_MAX_FLOW_STEPS,
  type FlowDefinition,
  FlowError,
  FlowPausedError,
  acp,
  action,
  checkpoint,
  compute,
  defineFlow,
  detectCycles,
  interpolateTemplate,
  listRuns,
  loadRunState,
  runFlow,
} from "../../../src/protocols/acp/flows";

// ── Helpers ─────────────────────────────────────────────────────

let runsDir: string;

beforeEach(async () => {
  runsDir = await mkdtemp(join(tmpdir(), "am-flows-test-"));
});

afterEach(async () => {
  await rm(runsDir, { recursive: true, force: true });
});

// ── Node constructor helpers ──────────────────────────────────

describe("Node constructors", () => {
  test("acp() creates AcpNode", () => {
    const node = acp({ agent: "claude", prompt: "do stuff" });
    expect(node.type).toBe("acp");
    expect(node.agent).toBe("claude");
    expect(node.prompt).toBe("do stuff");
  });

  test("action() creates ActionNode", () => {
    const node = action({ command: "echo hello" });
    expect(node.type).toBe("action");
    expect(node.command).toBe("echo hello");
  });

  test("action() with cwd", () => {
    const node = action({ command: "ls", cwd: "/tmp" });
    expect(node.cwd).toBe("/tmp");
  });

  test("compute() creates ComputeNode", () => {
    const fn = (input: Record<string, unknown>) => input;
    const node = compute({ fn });
    expect(node.type).toBe("compute");
    expect(node.fn).toBe(fn);
  });

  test("checkpoint() creates CheckpointNode", () => {
    const node = checkpoint({ message: "waiting" });
    expect(node.type).toBe("checkpoint");
    expect(node.message).toBe("waiting");
  });

  test("checkpoint() without options", () => {
    const node = checkpoint();
    expect(node.type).toBe("checkpoint");
    expect(node.message).toBeUndefined();
  });
});

// ── defineFlow ────────────────────────────────────────────────

describe("defineFlow", () => {
  test("returns the definition unchanged", () => {
    const def: FlowDefinition = {
      name: "test-flow",
      nodes: { a: compute({ fn: () => ({}) }) },
      edges: [],
    };
    const result = defineFlow(def);
    expect(result).toBe(def);
    expect(result.name).toBe("test-flow");
  });

  test("accepts description", () => {
    const def = defineFlow({
      name: "described-flow",
      description: "A flow with a description",
      nodes: { a: compute({ fn: () => ({}) }) },
      edges: [],
    });
    expect(def.description).toBe("A flow with a description");
  });
});

// ── interpolateTemplate ───────────────────────────────────────

describe("interpolateTemplate", () => {
  test("replaces simple placeholders", () => {
    const result = interpolateTemplate("Hello {{name}}", { name: "world" });
    expect(result).toBe("Hello world");
  });

  test("replaces multiple placeholders", () => {
    const result = interpolateTemplate("{{greeting}} {{name}}", {
      greeting: "Hi",
      name: "Bob",
    });
    expect(result).toBe("Hi Bob");
  });

  test("stringifies non-string values", () => {
    const result = interpolateTemplate("Count: {{count}}", { count: 42 });
    expect(result).toBe("Count: 42");
  });

  test("stringifies objects", () => {
    const result = interpolateTemplate("Data: {{data}}", { data: { a: 1 } });
    expect(result).toBe('Data: {"a":1}');
  });

  test("leaves unmatched placeholders", () => {
    const result = interpolateTemplate("Hello {{missing}}", {});
    expect(result).toBe("Hello {{missing}}");
  });

  test("handles empty input", () => {
    const result = interpolateTemplate("no placeholders", {});
    expect(result).toBe("no placeholders");
  });
});

// ── runFlow: simple linear flows ──────────────────────────────

describe("runFlow", () => {
  test("runs a single compute node", async () => {
    const flow = defineFlow({
      name: "single-compute",
      nodes: {
        step1: compute({ fn: () => ({ answer: 42 }) }),
      },
      edges: [],
    });

    const result = await runFlow(flow, { runsDir });

    expect(result.status).toBe("completed");
    expect(result.flowName).toBe("single-compute");
    expect(result.executionOrder).toEqual(["step1"]);
    expect(result.nodes.step1.status).toBe("completed");
    expect(result.nodes.step1.output).toEqual({ answer: 42 });
  });

  test("runs a linear 3-node compute flow", async () => {
    const flow = defineFlow({
      name: "linear-3",
      nodes: {
        add: compute({ fn: (input) => ({ value: ((input.value as number) ?? 0) + 10 }) }),
        double: compute({ fn: (input) => ({ value: (input.value as number) * 2 }) }),
        label: compute({ fn: (input) => ({ result: `answer: ${input.value}` }) }),
      },
      edges: [
        { from: "add", to: "double" },
        { from: "double", to: "label" },
      ],
    });

    const result = await runFlow(flow, {
      runsDir,
      input: { value: 5 },
    });

    expect(result.status).toBe("completed");
    expect(result.executionOrder).toEqual(["add", "double", "label"]);
    expect(result.nodes.add.output).toEqual({ value: 15 });
    expect(result.nodes.double.output).toEqual({ value: 30 });
    expect(result.nodes.label.output).toEqual({ result: "answer: 30" });
  });

  test("passes input between nodes via output", async () => {
    const flow = defineFlow({
      name: "data-passing",
      nodes: {
        produce: compute({ fn: () => ({ items: ["a", "b", "c"], count: 3 }) }),
        consume: compute({
          fn: (input) => ({
            received: input.count,
            firstItem: (input.items as string[])[0],
          }),
        }),
      },
      edges: [{ from: "produce", to: "consume" }],
    });

    const result = await runFlow(flow, { runsDir });

    expect(result.nodes.consume.output).toEqual({ received: 3, firstItem: "a" });
  });

  test("wraps non-object output in {result: ...}", async () => {
    const flow = defineFlow({
      name: "non-object",
      nodes: {
        step1: compute({ fn: () => "hello" }),
        step2: compute({ fn: (input) => ({ got: input.result }) }),
      },
      edges: [{ from: "step1", to: "step2" }],
    });

    const result = await runFlow(flow, { runsDir });

    expect(result.nodes.step2.input).toEqual({ result: "hello" });
    expect(result.nodes.step2.output).toEqual({ got: "hello" });
  });
});

// ── runFlow: action nodes ─────────────────────────────────────

describe("runFlow with action nodes", () => {
  test("runs a shell command", async () => {
    const flow = defineFlow({
      name: "shell-echo",
      nodes: {
        echo: action({ command: "echo hello-flows" }),
      },
      edges: [],
    });

    const result = await runFlow(flow, { runsDir });

    expect(result.status).toBe("completed");
    expect(result.nodes.echo.status).toBe("completed");
    const output = result.nodes.echo.output as { stdout: string; exitCode: number };
    expect(output.stdout).toBe("hello-flows");
    expect(output.exitCode).toBe(0);
  });

  test("action node failure marks flow as failed", async () => {
    const flow = defineFlow({
      name: "failing-action",
      nodes: {
        fail: action({ command: "false" }),
      },
      edges: [],
    });

    try {
      await runFlow(flow, { runsDir });
      expect(true).toBe(false); // should not reach
    } catch (err) {
      expect(err).toBeInstanceOf(FlowError);
      expect((err as FlowError).code).toBe("ACTION_FAILED");
    }

    // Verify persisted state reflects failure
    const runs = await listRuns(runsDir);
    expect(runs).toHaveLength(1);
    expect(runs[0].status).toBe("failed");
    expect(runs[0].nodes.fail.status).toBe("failed");
  });

  test("action command supports template interpolation", async () => {
    const flow = defineFlow({
      name: "template-action",
      nodes: {
        produce: compute({ fn: () => ({ greeting: "hello-from-template" }) }),
        echo: action({ command: "echo {{greeting}}" }),
      },
      edges: [{ from: "produce", to: "echo" }],
    });

    const result = await runFlow(flow, { runsDir });

    const output = result.nodes.echo.output as { stdout: string };
    expect(output.stdout).toBe("hello-from-template");
  });
});

// ── runFlow: ACP nodes (mocked) ───────────────────────────────

describe("runFlow with ACP nodes", () => {
  test("calls acpExecutor and passes result", async () => {
    const mockExecutor: AcpNodeExecutor = mock(async (agent, prompt, cwd) => ({
      text: `Agent ${agent} replied to: ${prompt}`,
    }));

    const flow = defineFlow({
      name: "acp-flow",
      nodes: {
        ask: acp({ agent: "claude", prompt: "Analyze {{topic}}" }),
        summarize: compute({
          fn: (input) => ({ summary: `Summary: ${input.text}` }),
        }),
      },
      edges: [{ from: "ask", to: "summarize" }],
    });

    const result = await runFlow(flow, {
      runsDir,
      input: { topic: "TypeScript" },
      acpExecutor: mockExecutor,
    });

    expect(result.status).toBe("completed");
    expect(mockExecutor).toHaveBeenCalledTimes(1);
    // Verify the interpolated prompt was passed
    const call = (mockExecutor as ReturnType<typeof mock>).mock.calls[0];
    expect(call[0]).toBe("claude");
    expect(call[1]).toBe("Analyze TypeScript");
    expect(result.nodes.summarize.output).toEqual({
      summary: "Summary: Agent claude replied to: Analyze TypeScript",
    });
  });

  test("throws FlowError when no acpExecutor provided", async () => {
    const flow = defineFlow({
      name: "no-executor",
      nodes: {
        ask: acp({ agent: "claude", prompt: "hello" }),
      },
      edges: [],
    });

    try {
      await runFlow(flow, { runsDir });
      expect(true).toBe(false);
    } catch (err) {
      expect(err).toBeInstanceOf(FlowError);
      expect((err as FlowError).code).toBe("NO_ACP_EXECUTOR");
    }
  });
});

// ── runFlow: checkpoint nodes ─────────────────────────────────

describe("runFlow with checkpoint nodes", () => {
  test("pauses flow when no checkpoint handler", async () => {
    const flow = defineFlow({
      name: "checkpoint-pause",
      nodes: {
        step1: compute({ fn: () => ({ prepared: true }) }),
        review: checkpoint({ message: "Review before continuing" }),
        step3: compute({ fn: () => ({ done: true }) }),
      },
      edges: [
        { from: "step1", to: "review" },
        { from: "review", to: "step3" },
      ],
    });

    const result = await runFlow(flow, { runsDir });

    expect(result.status).toBe("paused");
    expect(result.executionOrder).toEqual(["step1", "review"]);
    expect(result.nodes.review.status).toBe("paused");
    // step3 should not have run
    expect(result.nodes.step3.status).toBe("pending");
  });

  test("continues flow when checkpoint handler provides input", async () => {
    const handler: CheckpointHandler = mock(async () => ({
      approved: true,
      reviewer: "human",
    }));

    const flow = defineFlow({
      name: "checkpoint-continue",
      nodes: {
        step1: compute({ fn: () => ({ data: "ready" }) }),
        review: checkpoint({ message: "Please review" }),
        step3: compute({
          fn: (input) => ({ result: `approved=${input.approved}` }),
        }),
      },
      edges: [
        { from: "step1", to: "review" },
        { from: "review", to: "step3" },
      ],
    });

    const result = await runFlow(flow, {
      runsDir,
      checkpointHandler: handler,
    });

    expect(result.status).toBe("completed");
    expect(result.executionOrder).toEqual(["step1", "review", "step3"]);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(result.nodes.step3.output).toEqual({ result: "approved=true" });
  });
});

// ── runFlow: conditional edges ────────────────────────────────

describe("runFlow with conditional edges", () => {
  test("routes based on switch function", async () => {
    const flow = defineFlow({
      name: "conditional-routing",
      nodes: {
        classify: compute({
          fn: (input) => ({
            severity: (input.score as number) > 5 ? "high" : "low",
          }),
        }),
        handleHigh: compute({ fn: () => ({ action: "escalate" }) }),
        handleLow: compute({ fn: () => ({ action: "log" }) }),
      },
      edges: [
        {
          from: "classify",
          switch: (input) => input.severity as string,
          cases: {
            high: "handleHigh",
            low: "handleLow",
          },
        },
      ],
    });

    // Score > 5 -> high -> handleHigh
    const highResult = await runFlow(flow, {
      runsDir,
      input: { score: 8 },
    });
    expect(highResult.executionOrder).toEqual(["classify", "handleHigh"]);
    expect(highResult.nodes.handleHigh.output).toEqual({ action: "escalate" });

    // Score <= 5 -> low -> handleLow
    const lowResult = await runFlow(flow, {
      runsDir,
      input: { score: 3 },
    });
    expect(lowResult.executionOrder).toEqual(["classify", "handleLow"]);
    expect(lowResult.nodes.handleLow.output).toEqual({ action: "log" });
  });

  test("uses default case when no match", async () => {
    const flow = defineFlow({
      name: "conditional-default",
      nodes: {
        classify: compute({ fn: () => ({ category: "unknown" }) }),
        handleKnown: compute({ fn: () => ({ handled: "known" }) }),
        handleDefault: compute({ fn: () => ({ handled: "default" }) }),
      },
      edges: [
        {
          from: "classify",
          switch: (input) => input.category as string,
          cases: {
            bug: "handleKnown",
          },
          default: "handleDefault",
        },
      ],
    });

    const result = await runFlow(flow, { runsDir });
    expect(result.executionOrder).toEqual(["classify", "handleDefault"]);
    expect(result.nodes.handleDefault.output).toEqual({ handled: "default" });
  });

  test("stops flow when no matching case and no default", async () => {
    const flow = defineFlow({
      name: "conditional-no-match",
      nodes: {
        classify: compute({ fn: () => ({ category: "unknown" }) }),
        handleBug: compute({ fn: () => ({ handled: "bug" }) }),
      },
      edges: [
        {
          from: "classify",
          switch: (input) => input.category as string,
          cases: {
            bug: "handleBug",
          },
        },
      ],
    });

    const result = await runFlow(flow, { runsDir });
    // Should complete without running handleBug
    expect(result.status).toBe("completed");
    expect(result.executionOrder).toEqual(["classify"]);
    expect(result.nodes.handleBug.status).toBe("pending");
  });
});

// ── runFlow: entry node detection ─────────────────────────────

describe("Entry node detection", () => {
  test("detects entry node as the one not targeted by any edge", async () => {
    const flow = defineFlow({
      name: "entry-detection",
      nodes: {
        end: compute({ fn: () => ({ done: true }) }),
        middle: compute({ fn: (input) => input }),
        start: compute({ fn: () => ({ started: true }) }),
      },
      edges: [
        { from: "start", to: "middle" },
        { from: "middle", to: "end" },
      ],
    });

    const result = await runFlow(flow, { runsDir });
    expect(result.executionOrder[0]).toBe("start");
    expect(result.executionOrder).toEqual(["start", "middle", "end"]);
  });
});

// ── State persistence ─────────────────────────────────────────

describe("State persistence", () => {
  test("saves run state to disk", async () => {
    const flow = defineFlow({
      name: "persist-test",
      nodes: { a: compute({ fn: () => ({ x: 1 }) }) },
      edges: [],
    });

    const result = await runFlow(flow, { runsDir });

    const files = await readdir(runsDir);
    expect(files).toHaveLength(1);
    expect(files[0]).toBe(`${result.runId}.json`);
  });

  test("loadRunState reads persisted state", async () => {
    const flow = defineFlow({
      name: "load-test",
      nodes: { a: compute({ fn: () => ({ loaded: true }) }) },
      edges: [],
    });

    const result = await runFlow(flow, { runsDir });
    const loaded = await loadRunState(result.runId, runsDir);

    expect(loaded).not.toBeNull();
    expect(loaded!.runId).toBe(result.runId);
    expect(loaded!.flowName).toBe("load-test");
    expect(loaded!.status).toBe("completed");
    expect(loaded!.nodes.a.output).toEqual({ loaded: true });
  });

  test("loadRunState returns null for missing run", async () => {
    const loaded = await loadRunState("nonexistent-run-id", runsDir);
    expect(loaded).toBeNull();
  });

  test("listRuns returns all runs sorted by creation time", async () => {
    const flow = defineFlow({
      name: "list-test",
      nodes: { a: compute({ fn: () => ({}) }) },
      edges: [],
    });

    await runFlow(flow, { runsDir });
    await runFlow(flow, { runsDir });
    await runFlow(flow, { runsDir });

    const runs = await listRuns(runsDir);
    expect(runs).toHaveLength(3);
    // Sorted newest first
    expect(runs[0].createdAt >= runs[1].createdAt).toBe(true);
    expect(runs[1].createdAt >= runs[2].createdAt).toBe(true);
  });

  test("listRuns returns empty array for empty/missing directory", async () => {
    const runs = await listRuns(join(runsDir, "nonexistent"));
    expect(runs).toEqual([]);
  });

  test("failed flow state is persisted", async () => {
    const flow = defineFlow({
      name: "fail-persist",
      nodes: {
        good: compute({ fn: () => ({ ok: true }) }),
        bad: compute({
          fn: () => {
            throw new Error("boom");
          },
        }),
      },
      edges: [{ from: "good", to: "bad" }],
    });

    try {
      await runFlow(flow, { runsDir });
    } catch {
      // expected
    }

    const runs = await listRuns(runsDir);
    expect(runs).toHaveLength(1);
    expect(runs[0].status).toBe("failed");
    expect(runs[0].nodes.good.status).toBe("completed");
    expect(runs[0].nodes.bad.status).toBe("failed");
    expect(runs[0].nodes.bad.error).toBe("boom");
  });

  test("paused flow state is persisted", async () => {
    const flow = defineFlow({
      name: "pause-persist",
      nodes: {
        step1: compute({ fn: () => ({ ready: true }) }),
        wait: checkpoint({ message: "pausing" }),
      },
      edges: [{ from: "step1", to: "wait" }],
    });

    await runFlow(flow, { runsDir });

    const runs = await listRuns(runsDir);
    expect(runs).toHaveLength(1);
    expect(runs[0].status).toBe("paused");
    expect(runs[0].nodes.wait.status).toBe("paused");
  });
});

// ── Error types ───────────────────────────────────────────────

describe("FlowError", () => {
  test("has correct name and properties", () => {
    const err = new FlowError("test error", "TEST_CODE");
    expect(err.name).toBe("FlowError");
    expect(err.message).toBe("test error");
    expect(err.code).toBe("TEST_CODE");
  });

  test("works without code", () => {
    const err = new FlowError("simple error");
    expect(err.code).toBeUndefined();
  });

  test("is instanceof Error", () => {
    expect(new FlowError("test")).toBeInstanceOf(Error);
  });
});

describe("FlowPausedError", () => {
  test("has correct name and properties", () => {
    const err = new FlowPausedError("paused", { key: "val" });
    expect(err.name).toBe("FlowPausedError");
    expect(err.message).toBe("paused");
    expect(err.data).toEqual({ key: "val" });
  });

  test("works without data", () => {
    const err = new FlowPausedError("paused");
    expect(err.data).toBeUndefined();
  });
});

// ── Cycle detection ──────────────────────────────────────────

describe("detectCycles", () => {
  test("returns null for acyclic linear graph", () => {
    const flow = defineFlow({
      name: "linear",
      nodes: {
        a: compute({ fn: () => ({}) }),
        b: compute({ fn: () => ({}) }),
        c: compute({ fn: () => ({}) }),
      },
      edges: [
        { from: "a", to: "b" },
        { from: "b", to: "c" },
      ],
    });
    expect(detectCycles(flow)).toBeNull();
  });

  test("returns null for single node with no edges", () => {
    const flow = defineFlow({
      name: "single",
      nodes: { a: compute({ fn: () => ({}) }) },
      edges: [],
    });
    expect(detectCycles(flow)).toBeNull();
  });

  test("detects simple A->B->A cycle", () => {
    const flow = defineFlow({
      name: "cycle-ab",
      nodes: {
        a: compute({ fn: () => ({}) }),
        b: compute({ fn: () => ({}) }),
      },
      edges: [
        { from: "a", to: "b" },
        { from: "b", to: "a" },
      ],
    });
    const cycle = detectCycles(flow);
    expect(cycle).not.toBeNull();
    expect(cycle!.length).toBeGreaterThanOrEqual(2);
    expect(cycle!).toContain("a");
    expect(cycle!).toContain("b");
  });

  test("detects self-loop", () => {
    const flow = defineFlow({
      name: "self-loop",
      nodes: { a: compute({ fn: () => ({}) }) },
      edges: [{ from: "a", to: "a" }],
    });
    const cycle = detectCycles(flow);
    expect(cycle).not.toBeNull();
    expect(cycle!).toContain("a");
  });

  test("detects cycle in larger graph", () => {
    const flow = defineFlow({
      name: "larger-cycle",
      nodes: {
        a: compute({ fn: () => ({}) }),
        b: compute({ fn: () => ({}) }),
        c: compute({ fn: () => ({}) }),
        d: compute({ fn: () => ({}) }),
      },
      edges: [
        { from: "a", to: "b" },
        { from: "b", to: "c" },
        { from: "c", to: "d" },
        { from: "d", to: "b" }, // cycle: b -> c -> d -> b
      ],
    });
    const cycle = detectCycles(flow);
    expect(cycle).not.toBeNull();
  });

  test("detects cycle through conditional edges", () => {
    const flow = defineFlow({
      name: "conditional-cycle",
      nodes: {
        a: compute({ fn: () => ({}) }),
        b: compute({ fn: () => ({}) }),
      },
      edges: [
        {
          from: "a",
          switch: () => "loop",
          cases: { loop: "b" },
        },
        { from: "b", to: "a" },
      ],
    });
    const cycle = detectCycles(flow);
    expect(cycle).not.toBeNull();
  });

  test("returns null for diamond graph (no cycle)", () => {
    const flow = defineFlow({
      name: "diamond",
      nodes: {
        a: compute({ fn: () => ({}) }),
        b: compute({ fn: () => ({}) }),
        c: compute({ fn: () => ({}) }),
        d: compute({ fn: () => ({}) }),
      },
      edges: [
        { from: "a", to: "b" },
        { from: "a", to: "c" },
        { from: "b", to: "d" },
        { from: "c", to: "d" },
      ],
    });
    expect(detectCycles(flow)).toBeNull();
  });
});

describe("runFlow rejects cyclic flows", () => {
  test("throws FlowError with CYCLE_DETECTED code", async () => {
    const flow = defineFlow({
      name: "cyclic-flow",
      nodes: {
        a: compute({ fn: () => ({}) }),
        b: compute({ fn: () => ({}) }),
      },
      edges: [
        { from: "a", to: "b" },
        { from: "b", to: "a" },
      ],
    });

    try {
      await runFlow(flow, { runsDir });
      expect(true).toBe(false); // should not reach
    } catch (err) {
      expect(err).toBeInstanceOf(FlowError);
      expect((err as FlowError).code).toBe("CYCLE_DETECTED");
      expect((err as FlowError).message).toContain("Cycle detected in flow");
    }
  });
});

// ── Max steps guard ──────────────────────────────────────────

describe("Max steps guard", () => {
  test("DEFAULT_MAX_FLOW_STEPS is 1000", () => {
    expect(DEFAULT_MAX_FLOW_STEPS).toBe(1000);
  });

  test("throws FlowError when maxSteps exceeded", async () => {
    // Create a long chain that exceeds a low maxSteps
    const nodes: Record<string, import("../../../src/protocols/acp/flows").FlowNode> = {};
    const edges: import("../../../src/protocols/acp/flows").FlowEdge[] = [];
    for (let i = 0; i < 6; i++) {
      nodes[`n${i}`] = compute({ fn: () => ({}) });
      if (i > 0) edges.push({ from: `n${i - 1}`, to: `n${i}` });
    }

    const flow = defineFlow({ name: "long-chain", nodes, edges });

    try {
      await runFlow(flow, { runsDir, maxSteps: 3 });
      expect(true).toBe(false); // should not reach
    } catch (err) {
      expect(err).toBeInstanceOf(FlowError);
      expect((err as FlowError).code).toBe("MAX_STEPS_EXCEEDED");
      expect((err as FlowError).message).toContain("maximum steps (3)");
    }
  });

  test("flow completes when under maxSteps limit", async () => {
    const flow = defineFlow({
      name: "short-flow",
      nodes: {
        a: compute({ fn: () => ({ x: 1 }) }),
        b: compute({ fn: () => ({ x: 2 }) }),
      },
      edges: [{ from: "a", to: "b" }],
    });

    const result = await runFlow(flow, { runsDir, maxSteps: 5 });
    expect(result.status).toBe("completed");
    expect(result.executionOrder).toEqual(["a", "b"]);
  });

  test("maxSteps persists failed state", async () => {
    const nodes: Record<string, import("../../../src/protocols/acp/flows").FlowNode> = {};
    const edges: import("../../../src/protocols/acp/flows").FlowEdge[] = [];
    for (let i = 0; i < 5; i++) {
      nodes[`n${i}`] = compute({ fn: () => ({}) });
      if (i > 0) edges.push({ from: `n${i - 1}`, to: `n${i}` });
    }

    const flow = defineFlow({ name: "exceed-persist", nodes, edges });

    try {
      await runFlow(flow, { runsDir, maxSteps: 2 });
    } catch {
      // expected
    }

    const runs = await listRuns(runsDir);
    expect(runs).toHaveLength(1);
    expect(runs[0].status).toBe("failed");
  });
});

// ── Checkpoint handler receives correct nodeId ───────────────

describe("Checkpoint handler nodeId", () => {
  test("checkpoint handler receives the node ID, not the message", async () => {
    let receivedNodeId: string | undefined;
    let receivedMessage: string | undefined;

    const handler: CheckpointHandler = async (nodeId, message) => {
      receivedNodeId = nodeId;
      receivedMessage = message;
      return { approved: true };
    };

    const flow = defineFlow({
      name: "checkpoint-nodeid",
      nodes: {
        step1: compute({ fn: () => ({ ready: true }) }),
        myCheckpoint: checkpoint({ message: "Please review this" }),
        step3: compute({ fn: () => ({ done: true }) }),
      },
      edges: [
        { from: "step1", to: "myCheckpoint" },
        { from: "myCheckpoint", to: "step3" },
      ],
    });

    await runFlow(flow, { runsDir, checkpointHandler: handler });

    expect(receivedNodeId).toBe("myCheckpoint");
    expect(receivedMessage).toBe("Please review this");
  });

  test("checkpoint handler receives undefined message when not set", async () => {
    let receivedNodeId: string | undefined;
    let receivedMessage: string | undefined;

    const handler: CheckpointHandler = async (nodeId, message) => {
      receivedNodeId = nodeId;
      receivedMessage = message;
      return {};
    };

    const flow = defineFlow({
      name: "checkpoint-no-message",
      nodes: {
        review: checkpoint(),
      },
      edges: [],
    });

    await runFlow(flow, { runsDir, checkpointHandler: handler });

    expect(receivedNodeId).toBe("review");
    expect(receivedMessage).toBeUndefined();
  });
});

// ── Action node cwd override ────────────────────────────────

describe("Action node cwd override", () => {
  test("action node respects cwd override", async () => {
    const flow = defineFlow({
      name: "action-cwd",
      nodes: {
        pwd: action({ command: "pwd", cwd: "/tmp" }),
      },
      edges: [],
    });

    const result = await runFlow(flow, { runsDir });
    expect(result.status).toBe("completed");
    const output = result.nodes.pwd.output as { stdout: string };
    // /tmp may resolve to /private/tmp on macOS
    expect(output.stdout).toContain("tmp");
  });
});

// ── Compute node error state ────────────────────────────────

describe("Compute node error state details", () => {
  test("compute node failure persists error message in node state", async () => {
    const flow = defineFlow({
      name: "compute-error-detail",
      nodes: {
        bomb: compute({
          fn: () => {
            throw new Error("compute kaboom");
          },
        }),
      },
      edges: [],
    });

    try {
      await runFlow(flow, { runsDir });
      expect(true).toBe(false);
    } catch {
      // expected
    }

    const runs = await listRuns(runsDir);
    expect(runs).toHaveLength(1);
    expect(runs[0].status).toBe("failed");
    expect(runs[0].nodes.bomb.status).toBe("failed");
    expect(runs[0].nodes.bomb.error).toBe("compute kaboom");
  });

  test("compute node throwing non-Error value persists string representation", async () => {
    const flow = defineFlow({
      name: "compute-throw-string",
      nodes: {
        bomb: compute({
          fn: () => {
            throw "string error";
          },
        }),
      },
      edges: [],
    });

    try {
      await runFlow(flow, { runsDir });
      expect(true).toBe(false);
    } catch {
      // expected
    }

    const runs = await listRuns(runsDir);
    expect(runs).toHaveLength(1);
    expect(runs[0].nodes.bomb.error).toBe("string error");
  });
});

// ── Multiple entry points (disconnected nodes) ─────────────

describe("Disconnected nodes", () => {
  test("only the entry node runs when nodes have no edges connecting them", async () => {
    const flow = defineFlow({
      name: "disconnected",
      nodes: {
        first: compute({ fn: () => ({ x: 1 }) }),
        island: compute({ fn: () => ({ y: 2 }) }),
      },
      edges: [],
    });

    const result = await runFlow(flow, { runsDir });
    expect(result.status).toBe("completed");
    // Only the entry node should run; the island node stays pending
    expect(result.executionOrder).toHaveLength(1);
    expect(result.nodes.island.status).toBe("pending");
  });
});

// ── Flow with empty nodes ───────────────────────────────────

describe("Edge cases", () => {
  test("flow with single node and no edges completes", async () => {
    const flow = defineFlow({
      name: "single-node",
      nodes: {
        only: compute({ fn: () => ({ solo: true }) }),
      },
      edges: [],
    });

    const result = await runFlow(flow, { runsDir });
    expect(result.status).toBe("completed");
    expect(result.executionOrder).toEqual(["only"]);
    expect(result.nodes.only.output).toEqual({ solo: true });
  });

  test("conditional edge with null return from switch stops flow", async () => {
    const flow = defineFlow({
      name: "switch-null",
      nodes: {
        start: compute({ fn: () => ({ path: "none" }) }),
        a: compute({ fn: () => ({ reached: "a" }) }),
      },
      edges: [
        {
          from: "start",
          switch: () => "nonexistent-case",
          cases: { a: "a" },
          // no default
        },
      ],
    });

    const result = await runFlow(flow, { runsDir });
    expect(result.status).toBe("completed");
    expect(result.executionOrder).toEqual(["start"]);
    expect(result.nodes.a.status).toBe("pending");
  });
});

// ── Mixed flow: compute + action + acp ────────────────────────

describe("Mixed node type flows", () => {
  test("compute -> action -> compute pipeline", async () => {
    const flow = defineFlow({
      name: "mixed-pipeline",
      nodes: {
        prepare: compute({ fn: () => ({ filename: "test-output" }) }),
        run: action({ command: "echo {{filename}}" }),
        collect: compute({
          fn: (input) => ({ collected: (input.stdout as string).trim() }),
        }),
      },
      edges: [
        { from: "prepare", to: "run" },
        { from: "run", to: "collect" },
      ],
    });

    const result = await runFlow(flow, { runsDir });

    expect(result.status).toBe("completed");
    expect(result.executionOrder).toEqual(["prepare", "run", "collect"]);
    expect(result.nodes.collect.output).toEqual({ collected: "test-output" });
  });

  test("acp -> compute -> action flow with mock executor", async () => {
    const mockExecutor: AcpNodeExecutor = mock(async (agent, prompt) => ({
      text: "fix: add null check",
      files: ["src/main.ts"],
    }));

    const flow = defineFlow({
      name: "code-review",
      nodes: {
        analyze: acp({ agent: "claude", prompt: "Review the PR diff" }),
        categorize: compute({
          fn: (input) => ({
            fixCount: 1,
            description: input.text,
          }),
        }),
        report: action({ command: "echo {{description}}" }),
      },
      edges: [
        { from: "analyze", to: "categorize" },
        { from: "categorize", to: "report" },
      ],
    });

    const result = await runFlow(flow, {
      runsDir,
      acpExecutor: mockExecutor,
    });

    expect(result.status).toBe("completed");
    expect(result.executionOrder).toEqual(["analyze", "categorize", "report"]);
    expect(mockExecutor).toHaveBeenCalledTimes(1);
  });
});
