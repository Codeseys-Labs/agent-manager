/**
 * Flows Engine — Multi-step workflow orchestration for ACP agents.
 *
 * Defines and runs workflows composed of typed nodes (acp, action, compute,
 * checkpoint) connected by edges with optional conditional routing.
 *
 * Flow run state is persisted to ~/.agent-manager/flows/runs/ for crash
 * recovery and status inspection.
 *
 * See ADR-0026 Phase 3.
 */

import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

// ── Node Types ────────────────────────────────────────────────

/** An ACP node sends a prompt to a coding agent via ACP. */
export interface AcpNode {
  type: "acp";
  agent: string;
  /** Prompt template. Use {{key}} for input interpolation. */
  prompt: string;
}

/** An action node runs a shell command. */
export interface ActionNode {
  type: "action";
  command: string;
  /** Working directory for the command. Defaults to flow cwd. */
  cwd?: string;
}

/** A compute node runs a local synchronous function. */
export interface ComputeNode {
  type: "compute";
  fn: (input: Record<string, unknown>) => unknown;
}

/** A checkpoint node pauses execution and waits for external input. */
export interface CheckpointNode {
  type: "checkpoint";
  /** Message to display when paused. */
  message?: string;
}

export type FlowNode = AcpNode | ActionNode | ComputeNode | CheckpointNode;

// ── Node Constructor Helpers ──────────────────────────────────

export function acp(opts: Omit<AcpNode, "type">): AcpNode {
  return { type: "acp", ...opts };
}

export function action(opts: Omit<ActionNode, "type">): ActionNode {
  return { type: "action", ...opts };
}

export function compute(opts: Omit<ComputeNode, "type">): ComputeNode {
  return { type: "compute", ...opts };
}

export function checkpoint(opts?: Omit<CheckpointNode, "type">): CheckpointNode {
  return { type: "checkpoint", ...opts };
}

// ── Edges ─────────────────────────────────────────────────────

/** A simple edge routes from one node to the next. */
export interface SimpleEdge {
  from: string;
  to: string;
}

/** A conditional edge routes based on a switch function. */
export interface ConditionalEdge {
  from: string;
  /** Map output key to target node. The switch function returns a key. */
  switch: (input: Record<string, unknown>) => string;
  cases: Record<string, string>;
  /** Fallback target if no case matches. */
  default?: string;
}

export type FlowEdge = SimpleEdge | ConditionalEdge;

function isConditionalEdge(edge: FlowEdge): edge is ConditionalEdge {
  return "switch" in edge && "cases" in edge;
}

// ── Flow Definition ───────────────────────────────────────────

export interface FlowDefinition {
  name: string;
  description?: string;
  nodes: Record<string, FlowNode>;
  edges: FlowEdge[];
}

export function defineFlow(def: FlowDefinition): FlowDefinition {
  return def;
}

// ── Flow Run State ────────────────────────────────────────────

export type NodeStatus = "pending" | "running" | "completed" | "failed" | "skipped" | "paused";

export interface NodeRunState {
  nodeId: string;
  status: NodeStatus;
  input: Record<string, unknown>;
  output: unknown;
  startedAt?: string;
  completedAt?: string;
  error?: string;
}

export type FlowRunStatus = "pending" | "running" | "completed" | "failed" | "paused";

export interface FlowRunState {
  runId: string;
  flowName: string;
  status: FlowRunStatus;
  /** Ordered list of node executions (may include future nodes as pending). */
  nodes: Record<string, NodeRunState>;
  /** Execution order: node IDs in the order they ran. */
  executionOrder: string[];
  createdAt: string;
  updatedAt: string;
  /** Working directory for action/acp nodes. */
  cwd: string;
}

// ── State Persistence ─────────────────────────────────────────

function defaultRunsDir(): string {
  return join(homedir(), ".agent-manager", "flows", "runs");
}

function runFilePath(runsDir: string, runId: string): string {
  return join(runsDir, `${runId}.json`);
}

/** Serialize a FlowRunState to disk (stripping non-serializable fn references). */
async function saveRunState(state: FlowRunState, runsDir: string): Promise<void> {
  await mkdir(runsDir, { recursive: true });
  const serializable = {
    ...state,
    nodes: Object.fromEntries(
      Object.entries(state.nodes).map(([id, n]) => [id, { ...n }]),
    ),
  };
  await writeFile(runFilePath(runsDir, state.runId), JSON.stringify(serializable, null, 2));
}

/** Load a run state from disk. Returns null if not found. */
export async function loadRunState(runId: string, runsDir?: string): Promise<FlowRunState | null> {
  const dir = runsDir ?? defaultRunsDir();
  try {
    const raw = await readFile(runFilePath(dir, runId), "utf-8");
    return JSON.parse(raw) as FlowRunState;
  } catch {
    return null;
  }
}

/** List all run IDs in the runs directory. */
export async function listRuns(runsDir?: string): Promise<FlowRunState[]> {
  const dir = runsDir ?? defaultRunsDir();
  try {
    const files = await readdir(dir);
    const runs: FlowRunState[] = [];
    for (const f of files) {
      if (f.endsWith(".json")) {
        try {
          const raw = await readFile(join(dir, f), "utf-8");
          runs.push(JSON.parse(raw) as FlowRunState);
        } catch {
          // Skip corrupt files
        }
      }
    }
    return runs.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  } catch {
    return [];
  }
}

// ── Node Executors ────────────────────────────────────────────

/** Handler for ACP nodes — injected by the runner to avoid hard dep on ACP client. */
export type AcpNodeExecutor = (
  agent: string,
  prompt: string,
  cwd: string,
) => Promise<{ text: string; [key: string]: unknown }>;

/** Handler for checkpoint nodes — injected by the runner. */
export type CheckpointHandler = (
  nodeId: string,
  message: string | undefined,
) => Promise<Record<string, unknown>>;

/** Interpolate {{key}} placeholders in a template with values from input. */
export function interpolateTemplate(template: string, input: Record<string, unknown>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => {
    const val = input[key];
    if (val === undefined) return `{{${key}}}`;
    if (typeof val === "string") return val;
    return JSON.stringify(val);
  });
}

// ── Flow Runner ───────────────────────────────────────────────

export interface FlowRunnerOptions {
  /** Working directory for action/acp nodes. */
  cwd?: string;
  /** Initial input to the first node. */
  input?: Record<string, unknown>;
  /** Override the runs directory for state persistence. */
  runsDir?: string;
  /** ACP node executor (required if flow contains acp nodes). */
  acpExecutor?: AcpNodeExecutor;
  /** Checkpoint handler (required if flow contains checkpoint nodes). */
  checkpointHandler?: CheckpointHandler;
}

/** Generate a unique run ID. */
function generateRunId(): string {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 8);
  return `run-${ts}-${rand}`;
}

/** Find the entry node: the first node that is never a target of any edge. */
function findEntryNode(flow: FlowDefinition): string {
  const allTargets = new Set<string>();
  for (const edge of flow.edges) {
    if (isConditionalEdge(edge)) {
      for (const target of Object.values(edge.cases)) allTargets.add(target);
      if (edge.default) allTargets.add(edge.default);
    } else {
      allTargets.add(edge.to);
    }
  }
  const nodeIds = Object.keys(flow.nodes);
  for (const id of nodeIds) {
    if (!allTargets.has(id)) return id;
  }
  // Fallback: first node
  return nodeIds[0];
}

/** Find the next node after the current one, following edges. */
function findNextNode(
  flow: FlowDefinition,
  currentId: string,
  currentOutput: Record<string, unknown>,
): string | null {
  for (const edge of flow.edges) {
    if (edge.from !== currentId) continue;

    if (isConditionalEdge(edge)) {
      const key = edge.switch(currentOutput);
      const target = edge.cases[key] ?? edge.default;
      return target ?? null;
    }
    return edge.to;
  }
  return null;
}

/**
 * Execute a flow and return the final run state.
 *
 * Nodes run sequentially following edges. The output of each node becomes
 * the input of the next. Conditional edges route based on output values.
 */
export async function runFlow(
  flow: FlowDefinition,
  opts?: FlowRunnerOptions,
): Promise<FlowRunState> {
  const runsDir = opts?.runsDir ?? defaultRunsDir();
  const cwd = opts?.cwd ?? process.cwd();
  const runId = generateRunId();
  const now = new Date().toISOString();

  const state: FlowRunState = {
    runId,
    flowName: flow.name,
    status: "running",
    nodes: {},
    executionOrder: [],
    createdAt: now,
    updatedAt: now,
    cwd,
  };

  // Initialize all node states as pending
  for (const nodeId of Object.keys(flow.nodes)) {
    state.nodes[nodeId] = {
      nodeId,
      status: "pending",
      input: {},
      output: null,
    };
  }

  await saveRunState(state, runsDir);

  // Find the entry node
  let currentId: string | null = findEntryNode(flow);
  let currentInput: Record<string, unknown> = opts?.input ?? {};

  while (currentId !== null) {
    const node = flow.nodes[currentId];
    if (!node) {
      state.status = "failed";
      state.updatedAt = new Date().toISOString();
      await saveRunState(state, runsDir);
      throw new FlowError(`Node "${currentId}" not found in flow "${flow.name}"`, "NODE_NOT_FOUND");
    }

    const nodeState = state.nodes[currentId];
    nodeState.input = currentInput;
    nodeState.status = "running";
    nodeState.startedAt = new Date().toISOString();
    state.executionOrder.push(currentId);
    state.updatedAt = new Date().toISOString();
    await saveRunState(state, runsDir);

    try {
      const output = await executeNode(node, currentInput, cwd, opts);

      nodeState.status = "completed";
      nodeState.output = output;
      nodeState.completedAt = new Date().toISOString();

      // Prepare input for next node
      const nextInput: Record<string, unknown> =
        output !== null && typeof output === "object" && !Array.isArray(output)
          ? { ...(output as Record<string, unknown>) }
          : { result: output };

      state.updatedAt = new Date().toISOString();
      await saveRunState(state, runsDir);

      // Follow edge to next node
      currentId = findNextNode(flow, currentId, nextInput);
      currentInput = nextInput;
    } catch (err) {
      if (err instanceof FlowPausedError) {
        nodeState.status = "paused";
        nodeState.output = err.data;
        state.status = "paused";
        state.updatedAt = new Date().toISOString();
        await saveRunState(state, runsDir);
        return state;
      }

      nodeState.status = "failed";
      nodeState.error = err instanceof Error ? err.message : String(err);
      nodeState.completedAt = new Date().toISOString();
      state.status = "failed";
      state.updatedAt = new Date().toISOString();
      await saveRunState(state, runsDir);
      throw err;
    }
  }

  state.status = "completed";
  state.updatedAt = new Date().toISOString();
  await saveRunState(state, runsDir);

  return state;
}

// ── Individual Node Execution ─────────────────────────────────

async function executeNode(
  node: FlowNode,
  input: Record<string, unknown>,
  cwd: string,
  opts?: FlowRunnerOptions,
): Promise<unknown> {
  switch (node.type) {
    case "acp":
      return executeAcpNode(node, input, cwd, opts);
    case "action":
      return executeActionNode(node, input, cwd);
    case "compute":
      return executeComputeNode(node, input);
    case "checkpoint":
      return executeCheckpointNode(node, input, opts);
  }
}

async function executeAcpNode(
  node: AcpNode,
  input: Record<string, unknown>,
  cwd: string,
  opts?: FlowRunnerOptions,
): Promise<unknown> {
  if (!opts?.acpExecutor) {
    throw new FlowError(
      "ACP executor required for acp nodes. Provide acpExecutor in FlowRunnerOptions.",
      "NO_ACP_EXECUTOR",
    );
  }
  const prompt = interpolateTemplate(node.prompt, input);
  return opts.acpExecutor(node.agent, prompt, cwd);
}

async function executeActionNode(
  node: ActionNode,
  input: Record<string, unknown>,
  flowCwd: string,
): Promise<unknown> {
  const actionCwd = node.cwd ?? flowCwd;
  const command = interpolateTemplate(node.command, input);

  const proc = Bun.spawn(["sh", "-c", command], {
    cwd: actionCwd,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env },
  });

  const exitCode = await proc.exited;
  const stdout = proc.stdout ? await new Response(proc.stdout).text() : "";
  const stderr = proc.stderr ? await new Response(proc.stderr).text() : "";

  if (exitCode !== 0) {
    throw new FlowError(
      `Action "${command}" failed (exit ${exitCode}): ${stderr.trim() || stdout.trim()}`,
      "ACTION_FAILED",
    );
  }

  return { stdout: stdout.trim(), stderr: stderr.trim(), exitCode };
}

async function executeComputeNode(
  node: ComputeNode,
  input: Record<string, unknown>,
): Promise<unknown> {
  return node.fn(input);
}

async function executeCheckpointNode(
  node: CheckpointNode,
  _input: Record<string, unknown>,
  opts?: FlowRunnerOptions,
): Promise<unknown> {
  if (opts?.checkpointHandler) {
    // Handler returns external input to continue the flow
    return opts.checkpointHandler(node.message ?? "checkpoint", node.message);
  }
  // No handler — pause the flow
  throw new FlowPausedError(node.message ?? "Flow paused at checkpoint");
}

// ── Error Types ───────────────────────────────────────────────

export class FlowError extends Error {
  constructor(
    message: string,
    public code?: string,
  ) {
    super(message);
    this.name = "FlowError";
  }
}

export class FlowPausedError extends Error {
  constructor(
    message: string,
    public data?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "FlowPausedError";
  }
}
