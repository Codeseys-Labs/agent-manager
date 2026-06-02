/**
 * Wave E-WEBUI: the web dashboard must SURFACE the fail-closed drift gate.
 *
 * SEC-4b made `POST /api/apply` fail-closed — it returns a `skipped[]` list of
 * adapters that were NOT written because of detected/unknown drift. The web
 * frontend previously POSTed with no body and DROPPED the returned `skipped[]`,
 * so a user clicking Apply got no feedback that some targets were skipped for
 * safety.
 *
 * This test pins the two ends of the contract the UI relies on:
 *
 *   1. Backend: `POST /api/apply` returns `skipped[]` (adapter names) AND a
 *      parallel `results[]` entry whose `warnings[]` carry the reason text the
 *      UI classifies on ("drift detected ..." vs "drift check failed ..."),
 *      and `{ force: true }` clears the gate.
 *   2. Frontend (static HTML served at `/`): the dashboard ships the
 *      skipped-feedback panel + a Force re-apply control wired to a confirm
 *      step. The UI is static HTML with no DOM test harness, so we assert the
 *      load-bearing element ids / handlers are present in the served markup.
 *
 * Adapters are injected via the controller's `__setAdapterResolverForTests`
 * seam (cleared in afterEach) — NOT `mock.module`, matching apply-failclosed.
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

describe("Web apply UI — skipped[] feedback + force re-apply (Wave E-WEBUI / SEC-4b)", () => {
  let tmpDir: string;
  let authToken: string;
  let app: Awaited<ReturnType<typeof createApp>>;
  const originalEnv = process.env.AM_CONFIG_DIR;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "am-web-skipped-ui-"));
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

  // ── Backend contract the UI renders on ──────────────────────────────

  test("apply response surfaces skipped[] with a drift-DETECTED reason warning", async () => {
    __setAdapterResolverForTests(async () => [driftedAdapter("drifted-fake")]);
    const res = await apply({ force: false });
    const data = (await res.json()) as {
      skipped: string[];
      results: Array<{ adapter: string; warnings: string[] }>;
    };

    // The UI keys off skipped[] to decide whether to show the panel.
    expect(data.skipped).toEqual(["drifted-fake"]);
    // The UI classifies the reason from the parallel results[].warnings.
    const entry = data.results.find((r) => r.adapter === "drifted-fake");
    const warning = (entry?.warnings ?? []).join(" ").toLowerCase();
    expect(warning).toContain("drift detected");
    expect(warning).not.toContain("drift check failed");
  });

  test("apply response surfaces skipped[] with a drift-CHECK-FAILED reason warning", async () => {
    __setAdapterResolverForTests(async () => [throwingAdapter("throwing-fake")]);
    const res = await apply({ force: false });
    const data = (await res.json()) as {
      skipped: string[];
      results: Array<{ adapter: string; warnings: string[] }>;
    };

    expect(data.skipped).toEqual(["throwing-fake"]);
    const entry = data.results.find((r) => r.adapter === "throwing-fake");
    const warning = (entry?.warnings ?? []).join(" ").toLowerCase();
    // The UI maps this token to its own "drift-check-failed" reason badge.
    expect(warning).toContain("drift check failed");
  });

  test("force re-apply clears skipped[] (matches the UI's {force:true} re-POST)", async () => {
    __setAdapterResolverForTests(async () => [driftedAdapter("drifted-fake")]);
    const res = await apply({ force: true });
    const data = (await res.json()) as { skipped: string[] };
    expect(data.skipped).toEqual([]);
  });

  // ── Frontend contract: static dashboard ships the panel + force control ──

  test("served index.html wires up the skipped panel and force re-apply control", async () => {
    const res = await app.request("/", { method: "GET" });
    expect(res.status).toBe(200);
    const html = await res.text();

    // Skipped-feedback panel + list the renderer targets.
    expect(html).toContain('id="apply-skipped"');
    expect(html).toContain('id="apply-skipped-list"');
    // Force re-apply control.
    expect(html).toContain('id="btn-force-apply"');
    // Force path must re-POST with {force:true} and guard with a confirm step.
    expect(html).toContain("runApply(true)");
    expect(html).toContain("window.confirm");
    // Reason tokens the renderer emits as CSS classes for the two skip kinds.
    expect(html).toContain("drift-check-failed");
    expect(html).toContain("drift-detected");
  });
});
