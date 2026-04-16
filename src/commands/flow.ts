/**
 * CLI: am flow — Run and manage multi-step ACP workflows.
 *
 * Usage:
 *   am flow run <name>             — run a flow by name
 *   am flow list                   — list recent flow runs
 *   am flow status <runId>         — show status of a flow run
 *
 * See ADR-0026 Phase 3.
 */

import { defineCommand } from "citty";
import { debug, error, info, output } from "../lib/output";
import { type FlowRunState, listRuns, loadRunState } from "../protocols/acp/flows";

// ── Subcommand: am flow run ───────────────────────────────────

const flowRunCommand = defineCommand({
  meta: { name: "run", description: "Run a flow by name" },
  args: {
    name: { type: "positional", description: "Flow name or path to flow module", required: true },
    cwd: { type: "string", description: "Working directory for the flow" },
    input: { type: "string", description: "JSON input to pass to the first node" },
    runsDir: { type: "string", description: "Override flow runs directory" },
    json: { type: "boolean", description: "JSON output", default: false },
    quiet: { type: "boolean", alias: "q", default: false },
    verbose: { type: "boolean", alias: "v", default: false },
  },
  async run({ args }) {
    const opts = { json: args.json, quiet: args.quiet, verbose: args.verbose };
    const flowName = args.name as string;

    // Parse optional JSON input
    let initialInput: Record<string, unknown> = {};
    if (args.input) {
      try {
        initialInput = JSON.parse(args.input as string);
      } catch {
        error("Invalid --input: must be valid JSON", opts);
        process.exitCode = 1;
        return;
      }
    }

    // Dynamically import the flow module
    let flowModule: Record<string, unknown>;
    try {
      flowModule = await import(flowName);
    } catch (err) {
      error(
        `Could not load flow "${flowName}": ${err instanceof Error ? err.message : String(err)}`,
        opts,
      );
      process.exitCode = 1;
      return;
    }

    const flowDef = flowModule.default ?? flowModule.flow;
    if (!flowDef || typeof flowDef !== "object" || !("nodes" in flowDef) || !("edges" in flowDef)) {
      error(
        `Flow module "${flowName}" must export a default FlowDefinition (use defineFlow())`,
        opts,
      );
      process.exitCode = 1;
      return;
    }

    // Lazy import runFlow to avoid loading ACP deps at CLI parse time
    const { runFlow } = await import("../protocols/acp/flows");

    info(`Running flow: ${(flowDef as { name?: string }).name ?? flowName}`, opts);

    try {
      const result = await runFlow(flowDef as import("../protocols/acp/flows").FlowDefinition, {
        cwd: (args.cwd as string) ?? process.cwd(),
        input: initialInput,
        runsDir: args.runsDir as string | undefined,
        acpExecutor: async (agentName, prompt, cwd) => {
          const { AmAcpClient } = await import("../protocols/acp/client");
          const client = new AmAcpClient();
          try {
            await client.connectByName(agentName);
            const sessionId = await client.newSession({ cwd });
            const result = await client.prompt(sessionId, [{ type: "text", text: prompt }]);
            return { text: result.text };
          } finally {
            await client.disconnect().catch(() => {});
          }
        },
      });

      if (args.json) {
        output(result, opts);
      } else {
        info(`\nRun ID: ${result.runId}`, opts);
        info(`Status: ${result.status}`, opts);
        info(`Nodes executed: ${result.executionOrder.join(" -> ")}`, opts);
        for (const nodeId of result.executionOrder) {
          const node = result.nodes[nodeId];
          const icon = node.status === "completed" ? "+" : node.status === "failed" ? "x" : "?";
          info(`  [${icon}] ${nodeId}: ${node.status}`, opts);
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      error(`Flow failed: ${message}`, opts);
      process.exitCode = 1;
    }
  },
});

// ── Subcommand: am flow list ──────────────────────────────────

const flowListCommand = defineCommand({
  meta: { name: "list", description: "List recent flow runs" },
  args: {
    runsDir: { type: "string", description: "Override flow runs directory" },
    json: { type: "boolean", description: "JSON output", default: false },
    quiet: { type: "boolean", alias: "q", default: false },
    verbose: { type: "boolean", alias: "v", default: false },
  },
  async run({ args }) {
    const opts = { json: args.json, quiet: args.quiet, verbose: args.verbose };
    const runs = await listRuns(args.runsDir as string | undefined);

    if (args.json) {
      output({ runs }, opts);
      return;
    }

    if (runs.length === 0) {
      info("No flow runs found.", opts);
      return;
    }

    info(`${"Run ID".padEnd(24)} ${"Flow".padEnd(20)} ${"Status".padEnd(12)} ${"Created"}`, opts);
    info(`${"─".repeat(24)} ${"─".repeat(20)} ${"─".repeat(12)} ${"─".repeat(20)}`, opts);
    for (const run of runs) {
      const created = run.createdAt.slice(0, 16).replace("T", " ");
      info(
        `${run.runId.padEnd(24)} ${run.flowName.padEnd(20)} ${run.status.padEnd(12)} ${created}`,
        opts,
      );
    }
    info(`\n${runs.length} run(s)`, opts);
  },
});

// ── Subcommand: am flow status ────────────────────────────────

const flowStatusCommand = defineCommand({
  meta: { name: "status", description: "Show status of a flow run" },
  args: {
    runId: { type: "positional", description: "Flow run ID", required: true },
    runsDir: { type: "string", description: "Override flow runs directory" },
    json: { type: "boolean", description: "JSON output", default: false },
    quiet: { type: "boolean", alias: "q", default: false },
    verbose: { type: "boolean", alias: "v", default: false },
  },
  async run({ args }) {
    const opts = { json: args.json, quiet: args.quiet, verbose: args.verbose };
    const runId = args.runId as string;
    const state = await loadRunState(runId, args.runsDir as string | undefined);

    if (!state) {
      error(`Run "${runId}" not found.`, opts);
      process.exitCode = 1;
      return;
    }

    if (args.json) {
      output(state, opts);
      return;
    }

    info(`Run: ${state.runId}`, opts);
    info(`Flow: ${state.flowName}`, opts);
    info(`Status: ${state.status}`, opts);
    info(`Created: ${state.createdAt}`, opts);
    info(`Updated: ${state.updatedAt}`, opts);
    info(`CWD: ${state.cwd}`, opts);
    info("", opts);
    info("Nodes:", opts);
    for (const nodeId of Object.keys(state.nodes)) {
      const node = state.nodes[nodeId];
      const ran = state.executionOrder.includes(nodeId);
      const icon =
        node.status === "completed" ? "+" : node.status === "failed" ? "x" : ran ? "~" : " ";
      info(`  [${icon}] ${nodeId}: ${node.status}`, opts);
      if (node.error) {
        info(`      Error: ${node.error}`, opts);
      }
      if (args.verbose && node.output !== null) {
        const preview = JSON.stringify(node.output).slice(0, 100);
        info(`      Output: ${preview}`, opts);
      }
    }
    info(`\nExecution order: ${state.executionOrder.join(" -> ") || "(none)"}`, opts);
  },
});

// ── Export top-level command ───────────────────────────────────

export const flowCommand = defineCommand({
  meta: {
    name: "flow",
    description: "Run and manage multi-step ACP workflows",
  },
  subCommands: {
    run: () => Promise.resolve(flowRunCommand),
    list: () => Promise.resolve(flowListCommand),
    status: () => Promise.resolve(flowStatusCommand),
  },
});
