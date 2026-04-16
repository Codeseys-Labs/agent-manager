import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createTestDir, type TestDir } from "../../helpers/tmp.ts";
import {
  getCommunityAdapterConfig,
  listCommunityAdapterNames,
  readAdaptersToml,
  removeCommunityAdapterConfig,
  setCommunityAdapterConfig,
  writeAdaptersToml,
} from "../../../src/adapters/community/loader.ts";
import type { AdaptersToml, CommunityAdapterConfig } from "../../../src/adapters/community/types.ts";

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
