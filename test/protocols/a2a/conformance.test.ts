import { describe, expect, test } from "bun:test";
import type { ResolvedConfig } from "../../../src/adapters/types";
import { createA2ARoutes } from "../../../src/protocols/a2a/server";
import { A2A_PROTOCOL_VERSION, A2A_VERSION_HEADER } from "../../../src/protocols/a2a/version";

function makeResolvedConfig(): ResolvedConfig {
  return {
    servers: {},
    instructions: {},
    skills: {},
    agents: {},
    profile: "default",
    adapters: {},
  };
}
function makeApp(strictV03 = false) {
  return createA2ARoutes({
    config: makeResolvedConfig(),
    cardOptions: { baseUrl: "http://localhost:9090" },
    strictV03,
  });
}

describe("A2A conformance: Agent Card discovery URL", () => {
  test("serves Agent Card at /.well-known/agent-card.json (v0.3 canonical)", async () => {
    const res = await makeApp().request("/.well-known/agent-card.json");
    expect(res.status).toBe(200);
    expect((await res.json()).name).toBe("agent-manager");
  });
  test("serves Agent Card at /.well-known/agent.json (legacy alias)", async () => {
    const res = await makeApp().request("/.well-known/agent.json");
    expect(res.status).toBe(200);
    expect((await res.json()).name).toBe("agent-manager");
  });
  test("both paths return the same payload", async () => {
    const app = makeApp();
    const [a, b] = await Promise.all([
      app.request("/.well-known/agent-card.json").then((r) => r.json()),
      app.request("/.well-known/agent.json").then((r) => r.json()),
    ]);
    expect(a).toEqual(b);
  });
});

describe("A2A conformance: A2A-Version header", () => {
  test("present on agent-card.json", async () => {
    const res = await makeApp().request("/.well-known/agent-card.json");
    expect(res.headers.get(A2A_VERSION_HEADER)).toBe(A2A_PROTOCOL_VERSION);
  });
  test("present on agent.json (legacy)", async () => {
    const res = await makeApp().request("/.well-known/agent.json");
    expect(res.headers.get(A2A_VERSION_HEADER)).toBe(A2A_PROTOCOL_VERSION);
  });
});

describe("A2A conformance: tasks/list", () => {
  test("returns empty list when no tasks exist", async () => {
    const res = await makeApp().request("/a2a", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tasks/list", params: {} }),
    });
    const body = (await res.json()) as {
      result: { tasks: unknown[]; nextPageToken: string; totalSize: number };
    };
    expect(body.result.tasks).toHaveLength(0);
    expect(body.result.nextPageToken).toBe("");
    expect(body.result.totalSize).toBe(0);
  });
});

describe("A2A conformance: AgentCard v0.3 fields", () => {
  test("protocolVersion is 0.3.0", async () => {
    const res = await makeApp().request("/.well-known/agent-card.json");
    expect((await res.json()).protocolVersion).toBe("0.3.0");
  });
  test("preferredTransport is set", async () => {
    const res = await makeApp().request("/.well-known/agent-card.json");
    const card = (await res.json()) as { preferredTransport?: string };
    expect(typeof card.preferredTransport).toBe("string");
    expect(card.preferredTransport?.length).toBeGreaterThan(0);
  });
  test("securitySchemes includes a bearer entry", async () => {
    const res = await makeApp().request("/.well-known/agent-card.json");
    const card = (await res.json()) as {
      securitySchemes?: Record<string, { type: string; scheme?: string }>;
    };
    expect(card.securitySchemes?.bearer).toBeDefined();
    expect(card.securitySchemes?.bearer.type).toBe("http");
    expect(card.securitySchemes?.bearer.scheme).toBe("bearer");
  });
  test("supportsAuthenticatedExtendedCard flag present", async () => {
    const res = await makeApp().request("/.well-known/agent-card.json");
    const card = (await res.json()) as { supportsAuthenticatedExtendedCard?: boolean };
    expect(typeof card.supportsAuthenticatedExtendedCard).toBe("boolean");
  });
});

describe("A2A conformance: strict-mode taskId + cancel (strictV03=true)", () => {
  test("tasks/send rejects client id on new task with -32602", async () => {
    const res = await makeApp(true).request("/a2a", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tasks/send",
        params: {
          id: "client-id",
          message: { role: "user", parts: [{ type: "text", text: "status" }] },
        },
      }),
    });
    const body = (await res.json()) as { error?: { code: number; message: string } };
    expect(body.error?.code).toBe(-32602);
  });

  test("tasks/send mints server id when omitted", async () => {
    const res = await makeApp(true).request("/a2a", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tasks/send",
        params: { message: { role: "user", parts: [{ type: "text", text: "status" }] } },
      }),
    });
    const body = (await res.json()) as { result?: { id: string } };
    expect(body.result?.id).toBeDefined();
    expect(body.result?.id.startsWith("task-")).toBe(true);
  });
});
