/**
 * A2A-ACP Bridge — Routes incoming A2A tasks to local ACP agents.
 *
 * This is ADR-0026 Phase 4: the keystone that connects remote delegation (A2A)
 * to local agent execution (ACP). When an external agent sends an A2A task to
 * agent-manager, the bridge can resolve the target agent locally, spawn it via
 * ACP, execute the prompt, and return the result as an A2A response.
 *
 * Message format (two options):
 *   1. Text: "run <agent>: <prompt>"  (e.g., "run claude: fix the failing tests")
 *   2. Data part: { agent: "claude", prompt: "fix the failing tests" }
 */

import type { ResolvedConfig } from "../adapters/types";
import type { TaskHandler } from "./a2a/server";
import { TaskEventEmitter } from "./a2a/server";
import type { Artifact, Message } from "./a2a/types";
import { AmAcpClient } from "./acp/client";
import { resolveAgent } from "./acp/registry";
import type { AcpSettings } from "./acp/types";

// ── Message parsing ────────────────────────────────────────────

export interface BridgeRequest {
  agent: string;
  prompt: string;
}

/**
 * Parse a bridge request from an A2A user message.
 *
 * Supports two formats:
 *   1. Text part matching "run <agent>: <prompt>"
 *   2. Data part with { agent, prompt } fields
 *
 * Returns null if the message doesn't match either format.
 */
export function parseBridgeRequest(message: Message): BridgeRequest | null {
  // Check data parts first (more explicit)
  for (const part of message.parts) {
    if (part.type === "data") {
      const data = part.data as Record<string, unknown>;
      if (typeof data.agent === "string" && typeof data.prompt === "string") {
        return { agent: data.agent, prompt: data.prompt };
      }
    }
  }

  // Check text parts for "run <agent>: <prompt>" pattern
  for (const part of message.parts) {
    if (part.type === "text") {
      const match = part.text.match(/^run\s+(\S+):\s*(.+)$/is);
      if (match) {
        return { agent: match[1], prompt: match[2].trim() };
      }
    }
  }

  return null;
}

// ── Bridge handler ────────────────────────────────────────────

export interface BridgeConfig {
  /** Working directory for ACP sessions. Defaults to process.cwd(). */
  cwd?: string;
  /** Timeout in milliseconds for the ACP prompt. Default: 300000 (5 min). */
  timeout?: number;
  /** ACP settings from config (for agent command overrides). */
  acpSettings?: AcpSettings;
}

/**
 * Create a TaskHandler that bridges A2A tasks to local ACP agents.
 *
 * When the incoming message matches the bridge pattern ("run <agent>: <prompt>"
 * or a data part with {agent, prompt}), the handler:
 *   1. Resolves the agent name via the ACP registry
 *   2. Spawns the agent subprocess via ACP
 *   3. Creates a session and sends the prompt
 *   4. Collects the result and returns it as an A2A response
 *
 * If the message doesn't match the bridge pattern, returns null so the caller
 * can fall through to another handler.
 */
export function createBridgeTaskHandler(bridgeConfig?: BridgeConfig): TaskHandler {
  const cwd = bridgeConfig?.cwd ?? process.cwd();
  const timeout = bridgeConfig?.timeout ?? 300_000;
  const acpSettings = bridgeConfig?.acpSettings;

  return async (userMessage: Message, config: ResolvedConfig) => {
    const request = parseBridgeRequest(userMessage);
    if (!request) {
      return {
        message: {
          role: "agent" as const,
          parts: [
            {
              type: "text" as const,
              text: 'Bridge: message does not match bridge pattern. Use "run <agent>: <prompt>" or send a data part with {agent, prompt}.',
            },
          ],
        },
      };
    }

    // 1. Resolve agent in ACP registry
    const entry = resolveAgent(request.agent, acpSettings);
    if (!entry) {
      return {
        message: {
          role: "agent" as const,
          parts: [
            {
              type: "text" as const,
              text: `Bridge: agent "${request.agent}" is not available locally. Use "am run agents" to see available ACP agents.`,
            },
          ],
        },
      };
    }

    // 2. Spawn ACP agent and execute prompt
    const client = new AmAcpClient();
    try {
      await client.connect(entry.command, { initTimeout: 30_000 });
      const sessionId = await client.newSession({ cwd });
      const result = await Promise.race([
        client.prompt(sessionId, [{ type: "text", text: request.prompt }]),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("Bridge: ACP prompt timed out")), timeout),
        ),
      ]);

      // 3. Build A2A response from ACP result
      const responseParts: Message["parts"] = [];
      if (result.text) {
        responseParts.push({ type: "text" as const, text: result.text });
      }
      responseParts.push({
        type: "data" as const,
        data: {
          agent: request.agent,
          stopReason: result.stopReason,
          toolCalls: result.toolCalls.length,
          source: "acp-bridge",
        },
      });

      const artifacts: Artifact[] = [];
      if (result.toolCalls.length > 0) {
        artifacts.push({
          name: "tool-calls.json",
          description: `${result.toolCalls.length} tool call(s) made by ${request.agent}`,
          parts: [
            {
              type: "data" as const,
              data: {
                toolCalls: result.toolCalls.map((tc) => ({
                  id: tc.toolCallId,
                  title: tc.title,
                  status: tc.status,
                  kind: tc.kind,
                })),
              },
            },
          ],
        });
      }

      return {
        message: {
          role: "agent" as const,
          parts: responseParts,
        },
        ...(artifacts.length > 0 ? { artifacts } : {}),
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        message: {
          role: "agent" as const,
          parts: [
            {
              type: "text" as const,
              text: `Bridge: failed to execute on agent "${request.agent}" via ACP: ${message}`,
            },
          ],
        },
      };
    } finally {
      await client.disconnect();
    }
  };
}

// ── Composite handler ────────────────────────────────────────

/**
 * Create a TaskHandler that tries the bridge first, then falls through
 * to the default handler for non-bridge messages.
 *
 * This is the handler wired into the A2A server when `enableBridge` is true.
 */
export function createBridgedTaskHandler(
  defaultHandler: TaskHandler,
  bridgeConfig?: BridgeConfig,
): TaskHandler {
  const bridgeHandler = createBridgeTaskHandler(bridgeConfig);

  return async (userMessage: Message, config: ResolvedConfig) => {
    // If the message matches the bridge pattern, route to bridge
    const request = parseBridgeRequest(userMessage);
    if (request) {
      return bridgeHandler(userMessage, config);
    }
    // Otherwise, fall through to default handler
    return defaultHandler(userMessage, config);
  };
}
