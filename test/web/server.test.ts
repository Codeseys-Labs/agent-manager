import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as TOML from "@iarna/toml";
import { createApp } from "../../src/web/server";

let tmpDir: string;

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
});

afterAll(async () => {
  process.env.AM_CONFIG_DIR = undefined;
  await rm(tmpDir, { recursive: true, force: true });
});

function request(app: ReturnType<typeof createApp>, path: string, init?: RequestInit) {
  return app.request(path, init);
}

describe("Web API", () => {
  const app = createApp();

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
});
