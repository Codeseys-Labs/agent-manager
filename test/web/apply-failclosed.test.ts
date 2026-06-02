/**
 * SEC-4b regression: the local web UI's `POST /api/apply` must inherit the
 * CLI's fail-closed drift gate.
 *
 * `POST /api/apply` is a write-local surface — it writes IDE-native config
 * files just like `am apply`. Before this fix it called `applyResolved`
 * WITHOUT `diff: true`, so a button click could silently OVERWRITE a native
 * config a human edited out of band (the 2026-04-15 `~/.claude.json` wipe
 * class). Now it defaults `diff: true` and SKIPS drifted (or unreadable-drift)
 * adapters; `{ "force": true }` in the body is the explicit overwrite opt-in.
 *
 * Adapters are injected via the controller's `__setAdapterResolverForTests`
 * seam (cleared in afterEach) — NOT `mock.module`.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as TOML from "@iarna/toml";
import type { Adapter, DiffResult, ExportResult, ResolvedConfig } from "../../src/adapters/types";
import { __setAdapterResolverForTests } from "../../src/core/controller";
import { initRepo } from "../../src/core/git";
import { createApp, ensureAuthToken } from "../../src/web/server";

let exportCalled = false;

function baseAdapter(name: string): Omit<Adapter, "diff"> {
  return {
    meta: { name, displayName: name, version: "0.0.0", capabilities: [] },
    detect() {
      return { installed: true, paths: {} };
    },
    import() {
      return { servers: [], instructions: [], skills: [], warnings: [] };
    },
    export(_config: ResolvedConfig, _options): ExportResult {
      exportCalled = true;
      return { files: [{ path: `/tmp/${name}.json`, content: "{}", written: true }], warnings: [] };
    },
  };
}

function driftedAdapter(name: string): Adapter {
  return {
    ...baseAdapter(name),
    diff(): DiffResult {
      return {
        status: "drifted",
        changes: [{ entity: "server", name: "fetch", type: "modified" }],
      };
    },
  };
}

function throwingAdapter(name: string): Adapter {
  return {
    ...baseAdapter(name),
    diff(): DiffResult {
      throw new Error("simulated diff() failure");
    },
  };
}

describe("Web POST /api/apply — fail-closed drift gate (SEC-4b)", () => {
  let tmpDir: string;
  let authToken: string;
  let app: Awaited<ReturnType<typeof createApp>>;
  const originalEnv = process.env.AM_CONFIG_DIR;

  beforeEach(async () => {
    exportCalled = false;
    tmpDir = await mkdtemp(join(tmpdir(), "am-web-failclosed-"));
    await initRepo(tmpDir);
    await writeFile(
      join(tmpDir, "config.toml"),
      TOML.stringify({
        settings: { default_profile: "default" },
        servers: {
          fetch: { command: "uvx", args: ["mcp-server-fetch"], transport: "stdio", enabled: true },
        },
      } as TOML.JsonMap),
    );
    process.env.AM_CONFIG_DIR = tmpDir;
    authToken = ensureAuthToken(tmpDir);
    app = await createApp();
  });

  afterEach(async () => {
    __setAdapterResolverForTests(null);
    if (originalEnv === undefined) Reflect.deleteProperty(process.env, "AM_CONFIG_DIR");
    else process.env.AM_CONFIG_DIR = originalEnv;
    await rm(tmpDir, { recursive: true, force: true });
  });

  function apply(body?: unknown): Promise<Response> {
    return Promise.resolve(
      app.request("/api/apply", {
        method: "POST",
        headers: {
          authorization: `Bearer ${authToken}`,
          "content-type": "application/json",
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      }),
    );
  }

  test("drifted adapter is SKIPPED, not overwritten (bodiless POST → safe default)", async () => {
    __setAdapterResolverForTests(async () => [driftedAdapter("drifted-fake")]);
    const res = await apply();
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      skipped: string[];
      results: Array<{ adapter: string; files: unknown[] }>;
    };

    expect(exportCalled).toBe(false);
    expect(data.skipped).toEqual(["drifted-fake"]);
    const entry = data.results.find((r) => r.adapter === "drifted-fake");
    expect(entry?.files).toEqual([]);
  });

  test("diff() that throws → SKIPPED (drift state unknown, fail-closed)", async () => {
    __setAdapterResolverForTests(async () => [throwingAdapter("throwing-fake")]);
    const res = await apply({});
    const data = (await res.json()) as {
      skipped: string[];
      results: Array<{ adapter: string; warnings: string[] }>;
    };

    expect(exportCalled).toBe(false);
    expect(data.skipped).toEqual(["throwing-fake"]);
    const entry = data.results.find((r) => r.adapter === "throwing-fake");
    expect((entry?.warnings ?? []).join(" ")).toContain("drift check failed");
  });

  test("{ force: true } overwrites the drifted adapter (explicit opt-in)", async () => {
    __setAdapterResolverForTests(async () => [driftedAdapter("drifted-fake")]);
    const res = await apply({ force: true });
    const data = (await res.json()) as {
      skipped: string[];
      results: Array<{ adapter: string; files: unknown[] }>;
    };

    expect(exportCalled).toBe(true);
    expect(data.skipped).toEqual([]);
    const entry = data.results.find((r) => r.adapter === "drifted-fake");
    expect((entry?.files ?? []).length).toBe(1);
  });
});
