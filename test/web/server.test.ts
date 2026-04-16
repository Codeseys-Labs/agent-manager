import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as TOML from "@iarna/toml";
import { createApp, ensureAuthToken } from "../../src/web/server";

let tmpDir: string;
let authToken: string;

// Set up a temp config directory so API routes work without a real config
beforeAll(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "am-web-test-"));
  await mkdir(join(tmpDir, ".agent-manager"), { recursive: true });

  const config = {
    settings: { default_profile: "default" },
    servers: {
      fetch: {
        command: "uvx",
        args: ["mcp-server-fetch"],
        transport: "stdio",
        enabled: true,
        tags: ["web"],
        description: "HTTP fetch server",
      },
      slack: {
        command: "slack-mcp",
        args: [],
        transport: "stdio",
        enabled: false,
        tags: ["chat"],
        description: "Slack integration",
      },
    },
    profiles: {
      default: { description: "Default profile", servers: ["fetch"] },
      work: {
        description: "Work profile",
        inherits: "default",
        servers: ["fetch", "slack"],
      },
    },
  };

  await writeFile(join(tmpDir, "config.toml"), TOML.stringify(config as TOML.JsonMap));

  // Point agent-manager at the temp dir
  process.env.AM_CONFIG_DIR = tmpDir;

  // Generate auth token for test requests
  authToken = ensureAuthToken(tmpDir);
});

afterAll(async () => {
  process.env.AM_CONFIG_DIR = undefined;
  await rm(tmpDir, { recursive: true, force: true });
});

function request(app: Awaited<ReturnType<typeof createApp>>, path: string, init?: RequestInit) {
  // Inject auth header for API routes (except health which is unauthenticated)
  const headers = new Headers(init?.headers);
  if (!headers.has("authorization") && path.startsWith("/api/") && path !== "/api/health") {
    headers.set("authorization", `Bearer ${authToken}`);
  }
  return app.request(path, { ...init, headers });
}

describe("Web API", () => {
  let app: Awaited<ReturnType<typeof createApp>>;

  beforeAll(async () => {
    // createApp() must be called AFTER AM_CONFIG_DIR is set so the auth
    // token is generated in the test temp directory.
    app = await createApp();
  });

  it("GET /api/health returns 200 with version", async () => {
    const res = await request(app, "/api/health");
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.status).toBe("ok");
    expect(data.version).toBe("0.1.0");
  });

  it("GET /api/config returns resolved config", async () => {
    const res = await request(app, "/api/config");
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.profile).toBe("default");
    expect(data.config).toBeDefined();
    expect(data.config.servers).toBeDefined();
  });

  it("GET /api/servers returns array of servers", async () => {
    const res = await request(app, "/api/servers");
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(Array.isArray(data.servers)).toBe(true);
    expect(data.servers.length).toBe(2);

    const fetch = data.servers.find((s: { name: string }) => s.name === "fetch");
    expect(fetch).toBeDefined();
    expect(fetch.command).toBe("uvx");
    expect(fetch.enabled).toBe(true);

    const slack = data.servers.find((s: { name: string }) => s.name === "slack");
    expect(slack).toBeDefined();
    expect(slack.enabled).toBe(false);
  });

  it("GET /api/profiles returns profiles with active marker", async () => {
    const res = await request(app, "/api/profiles");
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(Array.isArray(data.profiles)).toBe(true);
    expect(data.profiles.length).toBe(2);
    expect(data.active).toBe("default");

    const defaultProfile = data.profiles.find((p: { name: string }) => p.name === "default");
    expect(defaultProfile.active).toBe(true);

    const workProfile = data.profiles.find((p: { name: string }) => p.name === "work");
    expect(workProfile.active).toBe(false);
    expect(workProfile.inherits).toBe("default");
  });

  it("POST /api/profile/use changes active profile", async () => {
    const res = await request(app, "/api/profile/use", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ profile: "work" }),
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.action).toBe("use");
    expect(data.profile).toBe("work");

    // Verify profile changed
    const profilesRes = await request(app, "/api/profiles");
    const profilesData = await profilesRes.json();
    expect(profilesData.active).toBe("work");

    // Switch back
    await request(app, "/api/profile/use", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ profile: "default" }),
    });
  });

  it("POST /api/profile/use rejects missing profile field", async () => {
    const res = await request(app, "/api/profile/use", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toContain("Missing");
  });

  it("POST /api/profile/use rejects unknown profile", async () => {
    const res = await request(app, "/api/profile/use", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ profile: "nonexistent" }),
    });
    expect(res.status).toBe(404);
    const data = await res.json();
    expect(data.error).toContain("not found");
    expect(data.available).toBeDefined();
  });

  it("GET /api/status returns status object", async () => {
    const res = await request(app, "/api/status");
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(typeof data.profile).toBe("string");
    expect(typeof data.servers).toBe("number");
    expect(data.git).toBeDefined();
    expect(Array.isArray(data.tools)).toBe(true);
  });

  it("GET /api/events returns SSE stream", async () => {
    const res = await request(app, "/api/events");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/event-stream");
  });

  it("POST /api/servers creates a server and returns 201", async () => {
    const res = await request(app, "/api/servers", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "test-new",
        command: "npx",
        args: ["test-server"],
        tags: ["test"],
        description: "Test server",
      }),
    });
    expect(res.status).toBe(201);
    const data = await res.json();
    expect(data.action).toBe("add");
    expect(data.server).toBe("test-new");

    // Verify it shows up in server list
    const listRes = await request(app, "/api/servers");
    const listData = await listRes.json();
    const created = listData.servers.find((s: { name: string }) => s.name === "test-new");
    expect(created).toBeDefined();
    expect(created.command).toBe("npx");
  });

  it("POST /api/servers returns 409 for duplicate", async () => {
    const res = await request(app, "/api/servers", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "fetch",
        command: "uvx",
        args: ["mcp-server-fetch"],
      }),
    });
    expect(res.status).toBe(409);
    const data = await res.json();
    expect(data.error).toContain("already exists");
  });

  it("PUT /api/servers/:name updates server fields", async () => {
    const res = await request(app, "/api/servers/fetch", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        description: "Updated fetch server",
        tags: ["web", "http"],
      }),
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.action).toBe("update");
    expect(data.server).toBe("fetch");

    // Verify update
    const listRes = await request(app, "/api/servers");
    const listData = await listRes.json();
    const updated = listData.servers.find((s: { name: string }) => s.name === "fetch");
    expect(updated.description).toBe("Updated fetch server");
  });

  it("DELETE /api/servers/:name removes server", async () => {
    // First create a server to delete
    await request(app, "/api/servers", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "to-delete",
        command: "echo",
        args: ["delete-me"],
      }),
    });

    const res = await request(app, "/api/servers/to-delete", {
      method: "DELETE",
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.action).toBe("delete");
    expect(data.server).toBe("to-delete");

    // Verify it's gone
    const listRes = await request(app, "/api/servers");
    const listData = await listRes.json();
    const deleted = listData.servers.find((s: { name: string }) => s.name === "to-delete");
    expect(deleted).toBeUndefined();
  });

  it("DELETE /api/servers/:name returns 404 for missing", async () => {
    const res = await request(app, "/api/servers/nonexistent", {
      method: "DELETE",
    });
    expect(res.status).toBe(404);
    const data = await res.json();
    expect(data.error).toContain("not found");
  });

  // ── Wiki endpoints ──────────────────────────────────────────

  it("GET /api/wiki/pages returns pages array (may be empty)", async () => {
    const res = await request(app, "/api/wiki/pages");
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(Array.isArray(data.pages)).toBe(true);
  });

  it("GET /api/wiki/search?q=test returns search results", async () => {
    const res = await request(app, "/api/wiki/search?q=test");
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.query).toBe("test");
    expect(Array.isArray(data.results)).toBe(true);
  });

  it("GET /api/wiki/search without q returns 400", async () => {
    const res = await request(app, "/api/wiki/search");
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toContain("required");
  });

  it("GET /api/wiki/projects returns project list", async () => {
    const res = await request(app, "/api/wiki/projects");
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(Array.isArray(data.projects)).toBe(true);
  });

  it("GET /api/wiki/pages/nonexistent returns 404", async () => {
    const res = await request(app, "/api/wiki/pages/nonexistent");
    expect(res.status).toBe(404);
    const data = await res.json();
    expect(data.error).toContain("not found");
  });

  it("GET /api/wiki/graph returns nodes and edges", async () => {
    const res = await request(app, "/api/wiki/graph");
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(Array.isArray(data.nodes)).toBe(true);
    expect(Array.isArray(data.edges)).toBe(true);
  });
});
