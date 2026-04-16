import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { join } from "node:path";
import { CommunityAdapterProxy } from "../../../src/adapters/community/proxy.ts";

const MOCK_ADAPTER = join(import.meta.dir, "mock-adapter.ts");

describe("CommunityAdapterProxy", () => {
  let proxy: CommunityAdapterProxy;

  beforeEach(async () => {
    proxy = await CommunityAdapterProxy.create("bun", [MOCK_ADAPTER]);
  });

  afterEach(() => {
    proxy.kill();
  });

  it("initializes and fetches meta", () => {
    expect(proxy.meta.name).toBe("mock-tool");
    expect(proxy.meta.displayName).toBe("Mock Tool");
    expect(proxy.meta.version).toBe("0.1.0");
    expect(proxy.meta.capabilities).toContain("mcp");
    expect(proxy.meta.capabilities).toContain("instructions");
  });

  it("fetches schema", () => {
    expect(proxy.schema).toBeDefined();
  });

  it("calls detect() via async IPC", async () => {
    const result = await proxy.detect();
    expect(result.installed).toBe(true);
    expect(result.version).toBe("1.0.0");
    expect(result.paths.configDir).toBe("/tmp/mock");
  });

  it("calls import() via async IPC", async () => {
    const result = await proxy.import({});
    expect(result.servers).toEqual([]);
    expect(result.instructions).toEqual([]);
    expect(result.skills).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  it("calls export()", async () => {
    const config = {
      servers: {},
      instructions: {},
      skills: {},
      agents: {},
      profile: "default",
      adapters: {},
    };
    const result = await proxy.export(config, {});
    expect(result.files).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  it("calls diff() via async IPC", async () => {
    const config = {
      servers: {},
      instructions: {},
      skills: {},
      agents: {},
      profile: "default",
      adapters: {},
    };
    const result = await proxy.diff(config);
    expect(result.status).toBe("in-sync");
    expect(result.changes).toEqual([]);
  });
});

describe("CommunityAdapterProxy.isAlive()", () => {
  it("returns true when subprocess is running", async () => {
    const p = await CommunityAdapterProxy.create("bun", [MOCK_ADAPTER]);
    expect(p.isAlive()).toBe(true);
    p.kill();
  });

  it("returns false after kill()", async () => {
    const p = await CommunityAdapterProxy.create("bun", [MOCK_ADAPTER]);
    p.kill();
    expect(p.isAlive()).toBe(false);
  });
});

describe("CommunityAdapterProxy error handling", () => {
  it("fails to create with invalid command", async () => {
    await expect(CommunityAdapterProxy.create("/nonexistent/binary")).rejects.toThrow();
  });
});
