import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { A2AClient, A2AClientError, createA2AClient } from "../../../src/protocols/a2a/client";
import type {
  A2AJsonRpcResponse,
  AgentCard,
  TaskArtifactUpdateEvent,
  TaskStatusUpdateEvent,
} from "../../../src/protocols/a2a/types";

// ── Helpers ─────────────────────────────────────────────────────

const MOCK_AGENT_CARD: AgentCard = {
  name: "test-agent",
  description: "A test agent for unit testing",
  version: "1.0.0",
  url: "https://agent.example.com",
  capabilities: {
    streaming: false,
    pushNotifications: false,
    stateTransitionHistory: true,
  },
  skills: [
    {
      id: "test.skill",
      name: "Test Skill",
      description: "A skill for testing",
      inputModes: ["text"],
      outputModes: ["text"],
      tags: ["test"],
    },
  ],
  authentication: [{ type: "bearer", description: "Bearer token" }],
  defaultInputModes: ["text"],
  defaultOutputModes: ["text"],
};

// ── Tests ───────────────────────────────────────────────────────

describe("A2AClient", () => {
  const originalFetch = globalThis.fetch;
  let mockFetch: ReturnType<typeof mock>;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  // ── Constructor ─────────────────────────────────────────────

  describe("constructor", () => {
    test("creates client with default options", () => {
      const client = new A2AClient();
      expect(client).toBeDefined();
    });

    test("creates client with custom options", () => {
      const client = new A2AClient({
        timeout: 5000,
        bearerToken: "test-token",
      });
      expect(client).toBeDefined();
    });
  });

  // ── createA2AClient convenience function ────────────────────

  describe("createA2AClient", () => {
    test("returns an A2AClient instance", () => {
      const client = createA2AClient();
      expect(client).toBeInstanceOf(A2AClient);
    });

    test("passes options through", () => {
      const client = createA2AClient({ timeout: 1000 });
      expect(client).toBeInstanceOf(A2AClient);
    });
  });

  // ── discoverAgent ───────────────────────────────────────────

  describe("discoverAgent", () => {
    test("fetches agent card from /.well-known/agent.json", async () => {
      mockFetch = mock(() =>
        Promise.resolve(
          new Response(JSON.stringify(MOCK_AGENT_CARD), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
        ),
      );
      globalThis.fetch = mockFetch as unknown as typeof fetch;

      const client = new A2AClient();
      const card = await client.discoverAgent("https://agent.example.com");

      expect(card).not.toBeNull();
      expect(card!.name).toBe("test-agent");
      expect(card!.description).toBe("A test agent for unit testing");
      expect(card!.version).toBe("1.0.0");
      expect(card!.url).toBe("https://agent.example.com");
      expect(card!.skills).toHaveLength(1);
      expect(card!.skills[0].id).toBe("test.skill");
      expect(card!.capabilities.streaming).toBe(false);
      expect(card!.capabilities.stateTransitionHistory).toBe(true);
    });

    test("constructs correct URL with /.well-known/agent.json", async () => {
      mockFetch = mock(() =>
        Promise.resolve(new Response(JSON.stringify(MOCK_AGENT_CARD), { status: 200 })),
      );
      globalThis.fetch = mockFetch as unknown as typeof fetch;

      const client = new A2AClient();
      await client.discoverAgent("https://agent.example.com");

      const calledUrl = (mockFetch.mock.calls[0] as unknown[])[0] as string;
      expect(calledUrl).toBe("https://agent.example.com/.well-known/agent.json");
    });

    test("strips trailing slashes from base URL", async () => {
      mockFetch = mock(() =>
        Promise.resolve(new Response(JSON.stringify(MOCK_AGENT_CARD), { status: 200 })),
      );
      globalThis.fetch = mockFetch as unknown as typeof fetch;

      const client = new A2AClient();
      await client.discoverAgent("https://agent.example.com///");

      const calledUrl = (mockFetch.mock.calls[0] as unknown[])[0] as string;
      expect(calledUrl).toBe("https://agent.example.com/.well-known/agent.json");
    });

    test("returns null for 404 response", async () => {
      mockFetch = mock(() => Promise.resolve(new Response("Not Found", { status: 404 })));
      globalThis.fetch = mockFetch as unknown as typeof fetch;

      const client = new A2AClient();
      const card = await client.discoverAgent("https://no-agent.example.com");

      expect(card).toBeNull();
    });

    test("throws A2AClientError for non-404 HTTP errors", async () => {
      mockFetch = mock(() =>
        Promise.resolve(
          new Response("Internal Server Error", {
            status: 500,
            statusText: "Internal Server Error",
          }),
        ),
      );
      globalThis.fetch = mockFetch as unknown as typeof fetch;

      const client = new A2AClient();
      try {
        await client.discoverAgent("https://broken.example.com");
        expect(true).toBe(false); // should not reach here
      } catch (err) {
        expect(err).toBeInstanceOf(A2AClientError);
        expect((err as A2AClientError).message).toContain("500");
        expect((err as A2AClientError).code).toBe(500);
      }
    });

    test("throws A2AClientError on network failure", async () => {
      mockFetch = mock(() => Promise.reject(new Error("Network unreachable")));
      globalThis.fetch = mockFetch as unknown as typeof fetch;

      const client = new A2AClient();
      try {
        await client.discoverAgent("https://offline.example.com");
        expect(true).toBe(false);
      } catch (err) {
        expect(err).toBeInstanceOf(A2AClientError);
        expect((err as A2AClientError).message).toContain("Network unreachable");
      }
    });

    test("includes bearer token in headers when configured", async () => {
      mockFetch = mock(() =>
        Promise.resolve(new Response(JSON.stringify(MOCK_AGENT_CARD), { status: 200 })),
      );
      globalThis.fetch = mockFetch as unknown as typeof fetch;

      const client = new A2AClient({ bearerToken: "my-secret-token" });
      await client.discoverAgent("https://agent.example.com");

      const fetchOpts = (mockFetch.mock.calls[0] as unknown[])[1] as RequestInit;
      const headers = fetchOpts.headers as Record<string, string>;
      expect(headers.Authorization).toBe("Bearer my-secret-token");
    });

    test("includes API key in headers when configured", async () => {
      mockFetch = mock(() =>
        Promise.resolve(new Response(JSON.stringify(MOCK_AGENT_CARD), { status: 200 })),
      );
      globalThis.fetch = mockFetch as unknown as typeof fetch;

      const client = new A2AClient({ apiKey: "my-api-key" });
      await client.discoverAgent("https://agent.example.com");

      const fetchOpts = (mockFetch.mock.calls[0] as unknown[])[1] as RequestInit;
      const headers = fetchOpts.headers as Record<string, string>;
      expect(headers["X-API-Key"]).toBe("my-api-key");
    });
  });

  // ── sendTask ────────────────────────────────────────────────

  describe("sendTask", () => {
    test("sends JSON-RPC request to /a2a endpoint", async () => {
      const mockResponse: A2AJsonRpcResponse = {
        jsonrpc: "2.0",
        id: 1,
        result: {
          id: "task-123",
          status: { state: "submitted", timestamp: new Date().toISOString() },
        },
      };

      mockFetch = mock(() =>
        Promise.resolve(
          new Response(JSON.stringify(mockResponse), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
        ),
      );
      globalThis.fetch = mockFetch as unknown as typeof fetch;

      const client = new A2AClient();
      const task = await client.sendTask("https://agent.example.com", {
        id: "task-123",
        message: {
          role: "user",
          parts: [{ type: "text", text: "Hello agent" }],
        },
      });

      expect(task.id).toBe("task-123");
      expect(task.status.state).toBe("submitted");

      // Verify it called /a2a endpoint
      const calledUrl = (mockFetch.mock.calls[0] as unknown[])[0] as string;
      expect(calledUrl).toBe("https://agent.example.com/a2a");

      // Verify JSON-RPC structure
      const fetchOpts = (mockFetch.mock.calls[0] as unknown[])[1] as RequestInit;
      const body = JSON.parse(fetchOpts.body as string);
      expect(body.jsonrpc).toBe("2.0");
      expect(body.method).toBe("tasks/send");
      expect(body.params.id).toBe("task-123");
    });

    test("throws A2AClientError on JSON-RPC error response", async () => {
      const mockResponse: A2AJsonRpcResponse = {
        jsonrpc: "2.0",
        id: 1,
        error: {
          code: -32600,
          message: "Invalid request",
          data: { detail: "Missing required field" },
        },
      };

      mockFetch = mock(() =>
        Promise.resolve(new Response(JSON.stringify(mockResponse), { status: 200 })),
      );
      globalThis.fetch = mockFetch as unknown as typeof fetch;

      const client = new A2AClient();
      try {
        await client.sendTask("https://agent.example.com", {
          id: "task-bad",
          message: { role: "user", parts: [{ type: "text", text: "test" }] },
        });
        expect(true).toBe(false);
      } catch (err) {
        expect(err).toBeInstanceOf(A2AClientError);
        expect((err as A2AClientError).message).toBe("Invalid request");
        expect((err as A2AClientError).code).toBe(-32600);
      }
    });
  });

  // ── getTask ─────────────────────────────────────────────────

  describe("getTask", () => {
    test("queries task state via tasks/get", async () => {
      const mockResponse: A2AJsonRpcResponse = {
        jsonrpc: "2.0",
        id: 1,
        result: {
          id: "task-456",
          status: { state: "completed", timestamp: new Date().toISOString() },
        },
      };

      mockFetch = mock(() =>
        Promise.resolve(new Response(JSON.stringify(mockResponse), { status: 200 })),
      );
      globalThis.fetch = mockFetch as unknown as typeof fetch;

      const client = new A2AClient();
      const task = await client.getTask("https://agent.example.com", {
        id: "task-456",
      });

      expect(task.id).toBe("task-456");
      expect(task.status.state).toBe("completed");

      // Verify method
      const fetchOpts = (mockFetch.mock.calls[0] as unknown[])[1] as RequestInit;
      const body = JSON.parse(fetchOpts.body as string);
      expect(body.method).toBe("tasks/get");
    });
  });

  // ── cancelTask ──────────────────────────────────────────────

  describe("cancelTask", () => {
    test("cancels a task via tasks/cancel", async () => {
      const mockResponse: A2AJsonRpcResponse = {
        jsonrpc: "2.0",
        id: 1,
        result: {
          id: "task-789",
          status: { state: "canceled", timestamp: new Date().toISOString() },
        },
      };

      mockFetch = mock(() =>
        Promise.resolve(new Response(JSON.stringify(mockResponse), { status: 200 })),
      );
      globalThis.fetch = mockFetch as unknown as typeof fetch;

      const client = new A2AClient();
      const task = await client.cancelTask("https://agent.example.com", {
        id: "task-789",
      });

      expect(task.id).toBe("task-789");
      expect(task.status.state).toBe("canceled");

      const fetchOpts = (mockFetch.mock.calls[0] as unknown[])[1] as RequestInit;
      const body = JSON.parse(fetchOpts.body as string);
      expect(body.method).toBe("tasks/cancel");
    });
  });

  // ── sendSubscribe ───────────────────────────────────────────

  describe("sendSubscribe", () => {
    /** Build an SSE response body from a list of events. */
    function buildSSEBody(events: Array<{ event: string; data: unknown }>): string {
      return events.map((e) => `event: ${e.event}\ndata: ${JSON.stringify(e.data)}\n\n`).join("");
    }

    test("parses SSE stream and calls onStatus callbacks", async () => {
      const sseBody = buildSSEBody([
        {
          event: "status",
          data: {
            id: "task-sse-1",
            status: { state: "working", timestamp: "2026-01-01T00:00:00Z" },
            final: false,
          },
        },
        {
          event: "status",
          data: {
            id: "task-sse-1",
            status: { state: "completed", timestamp: "2026-01-01T00:00:01Z" },
            final: true,
          },
        },
      ]);

      mockFetch = mock(() =>
        Promise.resolve(
          new Response(sseBody, {
            status: 200,
            headers: { "Content-Type": "text/event-stream" },
          }),
        ),
      );
      globalThis.fetch = mockFetch as unknown as typeof fetch;

      const client = new A2AClient({ timeout: 5000 });
      const statusEvents: TaskStatusUpdateEvent[] = [];

      const final = await client.sendSubscribe(
        "https://agent.example.com",
        {
          id: "task-sse-1",
          message: { role: "user", parts: [{ type: "text", text: "status" }] },
        },
        {
          onStatus: (evt) => statusEvents.push(evt),
        },
      );

      expect(statusEvents).toHaveLength(2);
      expect(statusEvents[0].status.state).toBe("working");
      expect(statusEvents[0].final).toBe(false);
      expect(statusEvents[1].status.state).toBe("completed");
      expect(statusEvents[1].final).toBe(true);
      expect(final.status.state).toBe("completed");
      expect(final.final).toBe(true);
    });

    test("parses artifact events in SSE stream", async () => {
      const sseBody = buildSSEBody([
        {
          event: "status",
          data: {
            id: "task-art-1",
            status: { state: "working", timestamp: "2026-01-01T00:00:00Z" },
            final: false,
          },
        },
        {
          event: "artifact",
          data: {
            id: "task-art-1",
            artifact: {
              name: "output.json",
              parts: [{ type: "data", data: { result: 42 } }],
            },
          },
        },
        {
          event: "status",
          data: {
            id: "task-art-1",
            status: { state: "completed", timestamp: "2026-01-01T00:00:01Z" },
            final: true,
          },
        },
      ]);

      mockFetch = mock(() =>
        Promise.resolve(
          new Response(sseBody, {
            status: 200,
            headers: { "Content-Type": "text/event-stream" },
          }),
        ),
      );
      globalThis.fetch = mockFetch as unknown as typeof fetch;

      const client = new A2AClient({ timeout: 5000 });
      const artifacts: TaskArtifactUpdateEvent[] = [];

      await client.sendSubscribe(
        "https://agent.example.com",
        {
          id: "task-art-1",
          message: { role: "user", parts: [{ type: "text", text: "test" }] },
        },
        {
          onArtifact: (evt) => artifacts.push(evt),
        },
      );

      expect(artifacts).toHaveLength(1);
      expect(artifacts[0].artifact.name).toBe("output.json");
    });

    test("handles JSON response (task already terminal) instead of SSE", async () => {
      const jsonResponse: A2AJsonRpcResponse = {
        jsonrpc: "2.0",
        id: 1,
        result: {
          id: "task-already-done",
          status: { state: "completed", timestamp: "2026-01-01T00:00:00Z" },
        },
      };

      mockFetch = mock(() =>
        Promise.resolve(
          new Response(JSON.stringify(jsonResponse), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
        ),
      );
      globalThis.fetch = mockFetch as unknown as typeof fetch;

      const client = new A2AClient({ timeout: 5000 });
      const statusEvents: TaskStatusUpdateEvent[] = [];

      const final = await client.sendSubscribe(
        "https://agent.example.com",
        {
          id: "task-already-done",
          message: { role: "user", parts: [{ type: "text", text: "status" }] },
        },
        {
          onStatus: (evt) => statusEvents.push(evt),
        },
      );

      expect(statusEvents).toHaveLength(1);
      expect(final.status.state).toBe("completed");
      expect(final.final).toBe(true);
    });

    test("throws on JSON-RPC error response", async () => {
      const errorResponse: A2AJsonRpcResponse = {
        jsonrpc: "2.0",
        id: 1,
        error: { code: -32602, message: "Invalid params" },
      };

      mockFetch = mock(() =>
        Promise.resolve(
          new Response(JSON.stringify(errorResponse), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
        ),
      );
      globalThis.fetch = mockFetch as unknown as typeof fetch;

      const client = new A2AClient({ timeout: 5000 });
      try {
        await client.sendSubscribe(
          "https://agent.example.com",
          {
            id: "task-err",
            message: { role: "user", parts: [{ type: "text", text: "test" }] },
          },
          {},
        );
        expect(true).toBe(false);
      } catch (err) {
        expect(err).toBeInstanceOf(A2AClientError);
        expect((err as A2AClientError).message).toBe("Invalid params");
        expect((err as A2AClientError).code).toBe(-32602);
      }
    });

    test("throws on HTTP error", async () => {
      mockFetch = mock(() =>
        Promise.resolve(
          new Response("Internal Server Error", {
            status: 500,
            statusText: "Internal Server Error",
          }),
        ),
      );
      globalThis.fetch = mockFetch as unknown as typeof fetch;

      const client = new A2AClient({ timeout: 5000 });
      try {
        await client.sendSubscribe(
          "https://agent.example.com",
          {
            id: "task-http-err",
            message: { role: "user", parts: [{ type: "text", text: "test" }] },
          },
          {},
        );
        expect(true).toBe(false);
      } catch (err) {
        expect(err).toBeInstanceOf(A2AClientError);
        expect((err as A2AClientError).message).toContain("500");
      }
    });

    test("sends correct JSON-RPC method tasks/sendSubscribe", async () => {
      const sseBody = buildSSEBody([
        {
          event: "status",
          data: {
            id: "task-method-check",
            status: { state: "completed", timestamp: "2026-01-01T00:00:00Z" },
            final: true,
          },
        },
      ]);

      mockFetch = mock(() =>
        Promise.resolve(
          new Response(sseBody, {
            status: 200,
            headers: { "Content-Type": "text/event-stream" },
          }),
        ),
      );
      globalThis.fetch = mockFetch as unknown as typeof fetch;

      const client = new A2AClient({ timeout: 5000 });
      await client.sendSubscribe(
        "https://agent.example.com",
        {
          id: "task-method-check",
          message: { role: "user", parts: [{ type: "text", text: "test" }] },
        },
        {},
      );

      const fetchOpts = (mockFetch.mock.calls[0] as unknown[])[1] as RequestInit;
      const body = JSON.parse(fetchOpts.body as string);
      expect(body.method).toBe("tasks/sendSubscribe");
      expect(body.jsonrpc).toBe("2.0");
      expect(body.params.id).toBe("task-method-check");
    });
  });

  // ── A2AClientError ──────────────────────────────────────────

  describe("A2AClientError", () => {
    test("has correct name and properties", () => {
      const err = new A2AClientError("test error", 42, { detail: "info" });
      expect(err.name).toBe("A2AClientError");
      expect(err.message).toBe("test error");
      expect(err.code).toBe(42);
      expect(err.data).toEqual({ detail: "info" });
    });

    test("works without optional fields", () => {
      const err = new A2AClientError("simple error");
      expect(err.code).toBeUndefined();
      expect(err.data).toBeUndefined();
    });
  });
});
