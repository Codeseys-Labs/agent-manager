import { describe, expect, it } from "bun:test";
import type {
  AdapterManifest,
  AdaptersToml,
  CommunityAdapterConfig,
  InitializeResult,
  JsonRpcError,
  JsonRpcRequest,
  JsonRpcResponse,
} from "../../../src/adapters/community/types.ts";

describe("CommunityAdapterConfig", () => {
  it("has required fields", () => {
    const config: CommunityAdapterConfig = {
      source: "npm:am-adapter-zed@0.2.0",
      command: "~/.config/agent-manager/adapters/zed/bin/adapter.js",
      installed_at: "2026-04-14T10:30:00Z",
    };
    expect(config.source).toBe("npm:am-adapter-zed@0.2.0");
    expect(config.command).toContain("adapter.js");
    expect(config.installed_at).toMatch(/^\d{4}-/);
  });

  it("supports optional fields", () => {
    const config: CommunityAdapterConfig = {
      source: "git+https://github.com/user/am-adapter-void.git",
      command: "/path/to/adapter",
      installed_at: "2026-04-14T10:30:00Z",
      checksum: "sha256:abc123",
      enabled: false,
    };
    expect(config.checksum).toBe("sha256:abc123");
    expect(config.enabled).toBe(false);
  });
});

describe("AdaptersToml", () => {
  it("holds a record of adapter configs", () => {
    const toml: AdaptersToml = {
      adapters: {
        zed: {
          source: "npm:am-adapter-zed@0.2.0",
          command: "/path/to/zed",
          installed_at: "2026-04-14T10:30:00Z",
        },
        void: {
          source: "git+https://github.com/user/am-adapter-void.git",
          command: "/path/to/void",
          installed_at: "2026-04-14T11:00:00Z",
        },
      },
    };
    expect(Object.keys(toml.adapters)).toHaveLength(2);
    expect(toml.adapters.zed.source).toContain("npm:");
    expect(toml.adapters.void.source).toContain("git+");
  });

  it("supports empty adapters record", () => {
    const toml: AdaptersToml = { adapters: {} };
    expect(Object.keys(toml.adapters)).toHaveLength(0);
  });
});

describe("AdapterManifest", () => {
  it("has required fields", () => {
    const manifest: AdapterManifest = {
      name: "zed",
      displayName: "Zed",
      capabilities: ["mcp", "instructions"],
    };
    expect(manifest.name).toBe("zed");
    expect(manifest.capabilities).toContain("mcp");
  });

  it("supports optional minAmVersion", () => {
    const manifest: AdapterManifest = {
      name: "zed",
      displayName: "Zed",
      minAmVersion: "0.3.0",
      capabilities: ["mcp"],
    };
    expect(manifest.minAmVersion).toBe("0.3.0");
  });
});

describe("JsonRpcRequest", () => {
  it("has correct shape", () => {
    const req: JsonRpcRequest = {
      jsonrpc: "2.0",
      id: 1,
      method: "adapter/meta",
      params: {},
    };
    expect(req.jsonrpc).toBe("2.0");
    expect(req.id).toBe(1);
    expect(req.method).toBe("adapter/meta");
  });
});

describe("JsonRpcResponse", () => {
  it("has success shape", () => {
    const res: JsonRpcResponse = {
      jsonrpc: "2.0",
      id: 1,
      result: { name: "zed" },
    };
    expect(res.result).toEqual({ name: "zed" });
    expect(res.error).toBeUndefined();
  });

  it("has error shape", () => {
    const err: JsonRpcError = {
      code: -32600,
      message: "Invalid request",
    };
    const res: JsonRpcResponse = {
      jsonrpc: "2.0",
      id: 1,
      error: err,
    };
    expect(res.error?.code).toBe(-32600);
    expect(res.result).toBeUndefined();
  });
});

describe("InitializeResult", () => {
  it("has protocol and adapter version", () => {
    const result: InitializeResult = {
      protocolVersion: "1.0",
      adapterVersion: "0.2.0",
    };
    expect(result.protocolVersion).toBe("1.0");
    expect(result.adapterVersion).toBe("0.2.0");
  });
});
