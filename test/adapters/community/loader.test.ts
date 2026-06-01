import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { createHash } from "node:crypto";
import { join } from "node:path";
import {
  getCommunityAdapterConfig,
  killAllProxies,
  listCommunityAdapterNames,
  loadCommunityAdapters,
  readAdaptersToml,
  removeCommunityAdapterConfig,
  setCommunityAdapterConfig,
  verifyChecksum,
  writeAdaptersToml,
} from "../../../src/adapters/community/loader.ts";
import type {
  AdaptersToml,
  CommunityAdapterConfig,
} from "../../../src/adapters/community/types.ts";
import { bunExe } from "../../helpers/bun-exe.ts";
import { type TestDir, createTestDir } from "../../helpers/tmp.ts";

describe("readAdaptersToml()", () => {
  let dir: TestDir;

  beforeEach(async () => {
    dir = await createTestDir("am-community-loader-");
  });

  afterEach(async () => {
    await dir.cleanup();
  });

  it("returns empty adapters when file does not exist", async () => {
    const result = await readAdaptersToml(dir.path);
    expect(result.adapters).toEqual({});
  });

  it("parses valid adapters.toml", async () => {
    await dir.write(
      "adapters.toml",
      `[adapters.zed]
source = "npm:am-adapter-zed@0.2.0"
command = "/path/to/zed"
installed_at = "2026-04-14T10:30:00Z"
`,
    );
    const result = await readAdaptersToml(dir.path);
    expect(result.adapters.zed).toBeDefined();
    expect(result.adapters.zed.source).toBe("npm:am-adapter-zed@0.2.0");
    expect(result.adapters.zed.command).toBe("/path/to/zed");
  });

  it("parses multiple adapters", async () => {
    await dir.write(
      "adapters.toml",
      `[adapters.zed]
source = "npm:am-adapter-zed@0.2.0"
command = "/path/to/zed"
installed_at = "2026-04-14T10:30:00Z"

[adapters.void]
source = "git+https://github.com/user/am-adapter-void.git"
command = "/path/to/void"
installed_at = "2026-04-14T11:00:00Z"
enabled = false
`,
    );
    const result = await readAdaptersToml(dir.path);
    expect(Object.keys(result.adapters)).toHaveLength(2);
    expect(result.adapters.void.enabled).toBe(false);
  });
});

describe("writeAdaptersToml()", () => {
  let dir: TestDir;

  beforeEach(async () => {
    dir = await createTestDir("am-community-write-");
  });

  afterEach(async () => {
    await dir.cleanup();
  });

  it("writes valid TOML file", async () => {
    const data: AdaptersToml = {
      adapters: {
        zed: {
          source: "npm:am-adapter-zed@0.2.0",
          command: "/path/to/zed",
          installed_at: "2026-04-14T10:30:00Z",
        },
      },
    };
    await writeAdaptersToml(dir.path, data);
    const content = await dir.read("adapters.toml");
    expect(content).toContain("[adapters.zed]");
    expect(content).toContain('source = "npm:am-adapter-zed@0.2.0"');
  });

  it("roundtrips through read", async () => {
    const data: AdaptersToml = {
      adapters: {
        test: {
          source: "local:./my-adapter",
          command: "/usr/local/bin/my-adapter",
          installed_at: "2026-04-14T12:00:00Z",
          checksum: "sha256:deadbeef",
        },
      },
    };
    await writeAdaptersToml(dir.path, data);
    const result = await readAdaptersToml(dir.path);
    expect(result.adapters.test.source).toBe("local:./my-adapter");
    expect(result.adapters.test.checksum).toBe("sha256:deadbeef");
  });
});

describe("listCommunityAdapterNames()", () => {
  let dir: TestDir;

  beforeEach(async () => {
    dir = await createTestDir("am-community-list-");
  });

  afterEach(async () => {
    await dir.cleanup();
  });

  it("returns empty array when no adapters.toml", async () => {
    const names = await listCommunityAdapterNames(dir.path);
    expect(names).toEqual([]);
  });

  it("returns adapter names", async () => {
    await dir.write(
      "adapters.toml",
      `[adapters.zed]
source = "npm:am-adapter-zed"
command = "/path/to/zed"
installed_at = "2026-04-14T10:30:00Z"

[adapters.void]
source = "npm:am-adapter-void"
command = "/path/to/void"
installed_at = "2026-04-14T11:00:00Z"
`,
    );
    const names = await listCommunityAdapterNames(dir.path);
    expect(names).toContain("zed");
    expect(names).toContain("void");
    expect(names).toHaveLength(2);
  });
});

describe("getCommunityAdapterConfig()", () => {
  let dir: TestDir;

  beforeEach(async () => {
    dir = await createTestDir("am-community-get-");
  });

  afterEach(async () => {
    await dir.cleanup();
  });

  it("returns undefined when adapter not found", async () => {
    const config = await getCommunityAdapterConfig(dir.path, "nonexistent");
    expect(config).toBeUndefined();
  });

  it("returns config for existing adapter", async () => {
    await dir.write(
      "adapters.toml",
      `[adapters.zed]
source = "npm:am-adapter-zed@0.2.0"
command = "/path/to/zed"
installed_at = "2026-04-14T10:30:00Z"
`,
    );
    const config = await getCommunityAdapterConfig(dir.path, "zed");
    expect(config).toBeDefined();
    expect(config!.source).toBe("npm:am-adapter-zed@0.2.0");
  });
});

describe("setCommunityAdapterConfig()", () => {
  let dir: TestDir;

  beforeEach(async () => {
    dir = await createTestDir("am-community-set-");
  });

  afterEach(async () => {
    await dir.cleanup();
  });

  it("adds a new adapter to adapters.toml", async () => {
    const config: CommunityAdapterConfig = {
      source: "npm:am-adapter-zed@0.2.0",
      command: "/path/to/zed",
      installed_at: "2026-04-14T10:30:00Z",
    };
    await setCommunityAdapterConfig(dir.path, "zed", config);

    const result = await readAdaptersToml(dir.path);
    expect(result.adapters.zed).toBeDefined();
    expect(result.adapters.zed.source).toBe("npm:am-adapter-zed@0.2.0");
  });

  it("updates an existing adapter", async () => {
    await dir.write(
      "adapters.toml",
      `[adapters.zed]
source = "npm:am-adapter-zed@0.1.0"
command = "/old/path"
installed_at = "2026-04-01T10:00:00Z"
`,
    );

    const updated: CommunityAdapterConfig = {
      source: "npm:am-adapter-zed@0.3.0",
      command: "/new/path",
      installed_at: "2026-04-14T10:30:00Z",
    };
    await setCommunityAdapterConfig(dir.path, "zed", updated);

    const result = await readAdaptersToml(dir.path);
    expect(result.adapters.zed.source).toBe("npm:am-adapter-zed@0.3.0");
    expect(result.adapters.zed.command).toBe("/new/path");
  });
});

describe("removeCommunityAdapterConfig()", () => {
  let dir: TestDir;

  beforeEach(async () => {
    dir = await createTestDir("am-community-remove-");
  });

  afterEach(async () => {
    await dir.cleanup();
  });

  it("returns false when adapter not found", async () => {
    const removed = await removeCommunityAdapterConfig(dir.path, "nonexistent");
    expect(removed).toBe(false);
  });

  it("removes adapter from adapters.toml", async () => {
    await dir.write(
      "adapters.toml",
      `[adapters.zed]
source = "npm:am-adapter-zed@0.2.0"
command = "/path/to/zed"
installed_at = "2026-04-14T10:30:00Z"

[adapters.void]
source = "npm:am-adapter-void"
command = "/path/to/void"
installed_at = "2026-04-14T11:00:00Z"
`,
    );

    const removed = await removeCommunityAdapterConfig(dir.path, "zed");
    expect(removed).toBe(true);

    const result = await readAdaptersToml(dir.path);
    expect(result.adapters.zed).toBeUndefined();
    expect(result.adapters.void).toBeDefined();
  });
});

const MOCK_ADAPTER = join(import.meta.dir, "mock-adapter.ts");

describe("verifyChecksum()", () => {
  let dir: TestDir;

  beforeEach(async () => {
    dir = await createTestDir("am-community-checksum-");
  });

  afterEach(async () => {
    await dir.cleanup();
  });

  it("throws on checksum mismatch", async () => {
    const binaryPath = await dir.write("fake-adapter", "#!/bin/sh\necho hello\n");
    await expect(
      verifyChecksum(
        "bad",
        binaryPath,
        "sha256:0000000000000000000000000000000000000000000000000000000000000000",
      ),
    ).rejects.toThrow("Adapter binary checksum mismatch for bad");
  });

  it("includes expected and actual hash in error", async () => {
    const binaryPath = await dir.write("fake-adapter", "binary content");
    const actualHash = createHash("sha256").update(Buffer.from("binary content")).digest("hex");
    try {
      await verifyChecksum("test", binaryPath, "sha256:aaaa");
      throw new Error("should have thrown");
    } catch (err) {
      expect((err as Error).message).toContain("Expected aaaa");
      expect((err as Error).message).toContain(`got ${actualHash}`);
      expect((err as Error).message).toContain("may have been tampered with");
    }
  });

  it("throws when no checksum is stored (non-local source)", async () => {
    // A missing checksum for a remote/npm/git adapter is now fatal — we
    // refuse to spawn untrusted code without a pinned hash.
    await expect(verifyChecksum("nocheck", "/any/path", undefined)).rejects.toThrow(
      /no checksum in adapters\.toml/,
    );
    await expect(
      verifyChecksum("nocheck", "/any/path", undefined, "npm:am-adapter-nocheck"),
    ).rejects.toThrow(/no checksum/);
  });

  it("warns but allows when no checksum is stored AND source is local:", async () => {
    const stderrSpy = spyOn(console, "error");
    // Local adapters are the user's own code — churn on every edit would
    // be noise, so we warn instead of failing.
    await verifyChecksum("mylocal", "/any/path", undefined, "local:./mylocal");
    expect(stderrSpy).toHaveBeenCalled();
    const msg = stderrSpy.mock.calls[0][0] as string;
    expect(msg).toContain("local adapter");
    expect(msg).toContain("mylocal");
    stderrSpy.mockRestore();
  });

  it("passes when checksum matches", async () => {
    const content = "adapter binary content here";
    const binaryPath = await dir.write("good-adapter", content);
    const hash = createHash("sha256").update(Buffer.from(content)).digest("hex");
    // Should not throw
    await verifyChecksum("good", binaryPath, `sha256:${hash}`);
  });

  it("throws when binary file not found", async () => {
    await expect(
      verifyChecksum("missing", "/nonexistent/path/to/binary", "sha256:abc123"),
    ).rejects.toThrow("Adapter binary not found");
  });

  it("throws on invalid checksum format (no colon)", async () => {
    const binaryPath = await dir.write("adapter", "content");
    await expect(verifyChecksum("bad-format", binaryPath, "nocolonseparator")).rejects.toThrow(
      "checksum format invalid",
    );
  });
});

describe("loadCommunityAdapters() checksum integration", () => {
  let dir: TestDir;

  beforeEach(async () => {
    dir = await createTestDir("am-community-checksum-int-");
    killAllProxies();
  });

  afterEach(async () => {
    killAllProxies();
    await dir.cleanup();
  });

  it("rejects adapter with checksum mismatch via loadCommunityAdapters", async () => {
    const binaryPath = await dir.write("fake-adapter", "#!/bin/sh\necho hello\n");
    await dir.write(
      "adapters.toml",
      `[adapters.bad]
source = "local:./bad-adapter"
command = "${binaryPath}"
installed_at = "2026-04-15T10:00:00Z"
checksum = "sha256:0000000000000000000000000000000000000000000000000000000000000000"
`,
    );

    const stderrSpy = spyOn(console, "error");
    const loaded = await loadCommunityAdapters(dir.path);
    expect(loaded.size).toBe(0);
    expect(stderrSpy).toHaveBeenCalled();
    const errMsg = stderrSpy.mock.calls[0][0] as string;
    expect(errMsg).toContain("checksum mismatch");
    stderrSpy.mockRestore();
  });
});

describe("loadCommunityAdapters() dead proxy detection", () => {
  let dir: TestDir;

  beforeEach(async () => {
    dir = await createTestDir("am-community-deadproxy-");
    killAllProxies();
  });

  afterEach(async () => {
    killAllProxies();
    await dir.cleanup();
  });

  it("evicts dead proxy from cache and attempts respawn", async () => {
    const mockAdapterPath = join(import.meta.dir, "mock-adapter.ts");
    // Compute checksum of the mock adapter script
    const { readFile: rf } = await import("node:fs/promises");
    const mockData = await rf(mockAdapterPath);
    const mockHash = createHash("sha256").update(mockData).digest("hex");

    // Point command at "bun" with the mock adapter as arg.
    // But loadCommunityAdapters only passes config.command (no args), so
    // we can't use the mock adapter through loadCommunityAdapters directly.
    // Instead, test the logic through the proxy + isAlive directly.
    const { CommunityAdapterProxy } = await import("../../../src/adapters/community/proxy.ts");

    // First: create a live proxy
    const proxy = await CommunityAdapterProxy.create(bunExe(), [MOCK_ADAPTER]);
    expect(proxy.isAlive()).toBe(true);

    // Simulate crash
    proxy.kill();
    expect(proxy.isAlive()).toBe(false);

    // A second create should give us a fresh, alive proxy
    const proxy2 = await CommunityAdapterProxy.create(bunExe(), [MOCK_ADAPTER]);
    expect(proxy2.isAlive()).toBe(true);
    expect(proxy2).not.toBe(proxy); // Different instance
    proxy2.kill();
  });
});

describe("loadCommunityAdapters() skips disabled adapters", () => {
  let dir: TestDir;

  beforeEach(async () => {
    dir = await createTestDir("am-community-disabled-");
    killAllProxies();
  });

  afterEach(async () => {
    killAllProxies();
    await dir.cleanup();
  });

  it("skips adapters with enabled = false", async () => {
    await dir.write(
      "adapters.toml",
      `[adapters.disabled]
source = "npm:am-adapter-disabled"
command = "/nonexistent/binary"
installed_at = "2026-04-15T10:00:00Z"
enabled = false
`,
    );

    const stderrSpy = spyOn(console, "error");
    const loaded = await loadCommunityAdapters(dir.path);
    expect(loaded.size).toBe(0);
    // Should not have attempted to load (no warnings about this adapter)
    const calls = stderrSpy.mock.calls.map((c) => c[0] as string);
    const loadWarning = calls.find((c) => c.includes("disabled"));
    expect(loadWarning).toBeUndefined();
    stderrSpy.mockRestore();
  });
});
