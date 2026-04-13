import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { A2AClient, A2AClientError, createA2AClient } from "../../../src/protocols/a2a/client";
import type { A2AJsonRpcResponse, AgentCard } from "../../../src/protocols/a2a/types";

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
