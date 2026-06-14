/**
 * ws3 empty-overwrite guard (seed agent-manager-3edc, brownfield-wipe lineage).
 *
 * The wipe-out chain this guards against:
 *   1. `am init`        → baseline commit (now config.toml-bearing, ws3 guard 1)
 *   2. `am add server`  → commit 2 populates the catalog
 *   3. `am undo`        → revertHead rewinds the catalog
 *   4. `am apply --force` → an EMPTY resolved catalog would have each adapter
 *      export an empty native config OVER a populated hand-managed one.
 *
 * Guard 1 (init baseline commit) keeps config.toml in the baseline tree so an
 * undo restores a config.toml-bearing parent. Guard 2 (here) is the backstop:
 * `applyResolved` must REFUSE to overwrite a populated native config when the
 * resolved catalog is empty — EVEN under --force — so even if the catalog does
 * end up empty, no blank write lands.
 *
 * We use the controller's `__setAdapterResolverForTests` seam (cleared per-test
 * in finally), NOT `mock.module(...)` — Bun's mock.module is process-global and
 * leaks into other parallel test files.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import type { Adapter, DiffResult, ExportResult, ResolvedConfig } from "../../src/adapters/types";
import { writeConfig } from "../../src/core/config";
import { __setAdapterResolverForTests, applyResolved } from "../../src/core/controller";
import { commitAll, initRepo, revertHead } from "../../src/core/git";
import type { Config } from "../../src/core/schema";
import { type TestDir, createTestDir } from "../helpers/tmp";

/**
 * A fake adapter that owns a mutable "native store" of server names. Its
 * diff() compares the resolved catalog against that store; its export()
 * REPLACES the store with the catalog's servers (so an empty catalog blanks
 * it — exactly the wipe the guard must prevent).
 */
function makeFakeAdapter(initialNative: string[]): {
  adapter: Adapter;
  native: () => string[];
} {
  let nativeStore = [...initialNative];
  const adapter: Adapter = {
    meta: {
      name: "fake-tool",
      displayName: "Fake Tool",
      version: "0.0.0",
      capabilities: [],
    },
    detect() {
      return { installed: true, paths: {} };
    },
    import() {
      return { servers: [], instructions: [], skills: [], warnings: [] };
    },
    export(config: ResolvedConfig): ExportResult {
      // Overwrite the native store with the catalog's servers — an empty
      // catalog blanks it.
      nativeStore = Object.keys(config.servers ?? {});
      return {
        files: [{ path: "/tmp/fake-tool.json", content: "{}", written: true }],
        warnings: [],
      };
    },
    diff(config: ResolvedConfig): DiffResult {
      const catalogServers = new Set(Object.keys(config.servers ?? {}));
      const changes: DiffResult["changes"] = [];
      // Servers present natively but absent from the catalog would be REMOVED.
      for (const name of nativeStore) {
        if (!catalogServers.has(name)) {
          changes.push({ entity: "server", name, type: "removed-locally" });
        }
      }
      // Servers in the catalog but not native would be ADDED.
      for (const name of catalogServers) {
        if (!nativeStore.includes(name)) {
          changes.push({ entity: "server", name, type: "added-in-config" });
        }
      }
      if (nativeStore.length === 0 && changes.length === 0) {
        return { status: "unmanaged", changes: [] };
      }
      return { status: changes.length === 0 ? "in-sync" : "drifted", changes };
    },
  };
  return { adapter, native: () => [...nativeStore] };
}

describe("applyResolved — empty-catalog overwrite guard (ws3)", () => {
  let dir: TestDir | undefined;
  const originalEnv = process.env.AM_CONFIG_DIR;

  beforeEach(async () => {
    dir = await createTestDir("am-empty-overwrite-");
    process.env.AM_CONFIG_DIR = dir.path;
    await initRepo(dir.path);
  });

  afterEach(async () => {
    __setAdapterResolverForTests(null);
    if (originalEnv === undefined) Reflect.deleteProperty(process.env, "AM_CONFIG_DIR");
    else process.env.AM_CONFIG_DIR = originalEnv;
    if (dir) await dir.cleanup();
    dir = undefined;
  });

  test("empty catalog + populated native: live apply SKIPS (no overwrite)", async () => {
    if (!dir) throw new Error("setup failed");
    const { adapter, native } = makeFakeAdapter(["fetch", "tavily"]);
    __setAdapterResolverForTests(async () => [adapter]);

    // Empty catalog on disk.
    await writeConfig(join(dir.path, "config.toml"), {
      settings: { default_profile: "default" },
      servers: {},
    });

    const result = await applyResolved(dir.path, {});

    // The native store must be UNTOUCHED — no blank write landed.
    expect(native()).toEqual(["fetch", "tavily"]);
    expect(result.skipped).toContain("fake-tool");
    expect(result.succeeded).not.toContain("fake-tool");

    const entry = result.results.find((r) => r.adapter === "fake-tool");
    expect(entry?.files).toEqual([]);
    expect(entry?.warnings.join(" ")).toContain("EMPTY catalog");
  });

  test("empty catalog + populated native: --force does NOT override the guard", async () => {
    if (!dir) throw new Error("setup failed");
    const { adapter, native } = makeFakeAdapter(["fetch"]);
    __setAdapterResolverForTests(async () => [adapter]);

    await writeConfig(join(dir.path, "config.toml"), {
      settings: { default_profile: "default" },
      servers: {},
    });

    // --force opts into overwriting DRIFT, not into blanking a populated config.
    const result = await applyResolved(dir.path, { force: true });

    expect(native()).toEqual(["fetch"]); // still populated
    expect(result.skipped).toContain("fake-tool");
    expect(result.succeeded).not.toContain("fake-tool");
  });

  test("empty catalog + UNMANAGED native (no file): falls through, exports normally", async () => {
    if (!dir) throw new Error("setup failed");
    // Native store empty → diff() returns `unmanaged`; the guard must NOT fire.
    const { adapter, native } = makeFakeAdapter([]);
    __setAdapterResolverForTests(async () => [adapter]);

    await writeConfig(join(dir.path, "config.toml"), {
      settings: { default_profile: "default" },
      servers: {},
    });

    const result = await applyResolved(dir.path, {});

    expect(result.succeeded).toContain("fake-tool");
    expect(result.skipped).not.toContain("fake-tool");
    expect(native()).toEqual([]); // nothing erased (there was nothing)
  });

  test("populated catalog + populated native: guard is inert (normal apply)", async () => {
    if (!dir) throw new Error("setup failed");
    const { adapter, native } = makeFakeAdapter(["fetch"]);
    __setAdapterResolverForTests(async () => [adapter]);

    await writeConfig(join(dir.path, "config.toml"), {
      settings: { default_profile: "default" },
      servers: { fetch: { command: "uvx", transport: "stdio", enabled: true } },
    });

    const result = await applyResolved(dir.path, {});

    // Non-empty catalog → guard never engages → export ran → native = catalog.
    expect(result.succeeded).toContain("fake-tool");
    expect(native()).toEqual(["fetch"]);
  });

  test("dry-run is exempt: empty catalog + populated native is previewed, not skipped", async () => {
    if (!dir) throw new Error("setup failed");
    const { adapter, native } = makeFakeAdapter(["fetch"]);
    __setAdapterResolverForTests(async () => [adapter]);

    await writeConfig(join(dir.path, "config.toml"), {
      settings: { default_profile: "default" },
      servers: {},
    });

    const result = await applyResolved(dir.path, { dryRun: true });

    // Dry-run writes nothing regardless, so the guard does not gate it; the
    // adapter is processed (export is a no-op write path under dryRun in real
    // adapters; our fake records the would-be store but that's fine for a
    // preview). The load-bearing check is that it is NOT in `skipped`.
    expect(result.skipped).not.toContain("fake-tool");
    // Our fake's export mutates the store unconditionally; under a real dry-run
    // the adapter would not write. We only assert the gate did not fire.
    void native;
  });

  test("full init→add→undo→apply --force sequence never blanks a populated native config", async () => {
    if (!dir) throw new Error("setup failed");
    const { adapter, native } = makeFakeAdapter(["fetch"]);
    __setAdapterResolverForTests(async () => [adapter]);

    // (1) init already ran in beforeEach (single baseline commit). Simulate the
    //     ws3 baseline by committing a config.toml so the parent tree carries
    //     it (mirrors guard 1's effect). Here we use commitAll for a 2nd commit
    //     to drive the add → undo dance deterministically.
    await writeConfig(join(dir.path, "config.toml"), {
      settings: { default_profile: "default" },
      servers: {},
      profiles: { default: { description: "Default profile — all servers" } },
    });
    await commitAll(dir.path, "init config baseline");

    // (2) `am add server fetch` → commit 2 populates the catalog.
    await writeConfig(join(dir.path, "config.toml"), {
      settings: { default_profile: "default" },
      servers: { fetch: { command: "uvx", transport: "stdio", enabled: true } },
      profiles: { default: { description: "Default profile — all servers" } },
    });
    await commitAll(dir.path, "add server: fetch");

    // (3) `am undo` → revert HEAD. With the baseline config-bearing parent the
    //     catalog rewinds to its EMPTY-servers prior state (config.toml still
    //     present, just without `fetch`).
    await revertHead(dir.path);

    // (4) `am apply --force` → the resolved catalog now has no servers. The
    //     guard must refuse to blank the populated native store.
    const result = await applyResolved(dir.path, { force: true });

    expect(native()).toEqual(["fetch"]); // NOT blanked — acceptance criterion
    expect(result.skipped).toContain("fake-tool");
  });
});
