/**
 * Regression: GET /api/status must NOT fabricate clean:true when getStatus()
 * throws.
 *
 * getStatus() throws only on a REAL git fault (not-a-repo, corrupt index, IO
 * error) — a merely dirty tree returns clean:false normally. The handler used
 * to substitute { branch:"unknown", clean:true, ... } on ANY failure, reporting
 * "clean" precisely when git is broken (the web sync indicator then shows
 * nothing to sync). This file mocks getStatus() to throw and asserts the
 * response reports clean:FALSE and surfaces a `gitError` string (matching the
 * MCP am_status field naming).
 */

import { afterAll, afterEach, beforeAll, describe, expect, it, mock } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as TOML from "@iarna/toml";

let tmpDir: string;
let authToken: string;
const originalEnv = process.env.AM_CONFIG_DIR;
// Snapshot the genuine git module up front. Bun's `mock.restore()` does NOT
// undo `mock.module()`, so we must explicitly re-install the real exports
// after each test or the `getStatus`-throws stub leaks into every test file
// loaded later in the same process (e.g. wiki sync's git-root resolution).
let REAL_GIT: typeof import("../../src/core/git") | undefined;

beforeAll(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "am-web-status-error-"));
  REAL_GIT = { ...(await import("../../src/core/git")) };
  const { initRepo } = await import("../../src/core/git");
  await initRepo(tmpDir);
  await writeFile(
    join(tmpDir, "config.toml"),
    TOML.stringify({
      settings: { default_profile: "default" },
      servers: {
        fetch: { command: "uvx", args: ["mcp-server-fetch"], transport: "stdio", enabled: true },
      },
      profiles: { default: { description: "Default profile", servers: ["fetch"] } },
    } as TOML.JsonMap),
  );
  process.env.AM_CONFIG_DIR = tmpDir;
  const { ensureAuthToken } = await import("../../src/web/server");
  authToken = ensureAuthToken(tmpDir);
});

afterEach(() => {
  mock.restore();
  // `mock.restore()` does not undo `mock.module()`; explicitly re-install the
  // real git exports so the throwing `getStatus` stub does not leak to other
  // test files in the same run.
  if (REAL_GIT) mock.module("../../src/core/git", () => REAL_GIT);
});

afterAll(async () => {
  if (REAL_GIT) mock.module("../../src/core/git", () => REAL_GIT);
  if (originalEnv === undefined) Reflect.deleteProperty(process.env, "AM_CONFIG_DIR");
  else process.env.AM_CONFIG_DIR = originalEnv;
  await rm(tmpDir, { recursive: true, force: true });
});

describe("GET /api/status — getStatus() fault reporting", () => {
  it("reports clean:false + a gitError string when getStatus throws", async () => {
    // Mock the git module so getStatus throws a real-fault style error. Other
    // exports (initRepo, push, pull, commitAll) are preserved.
    const realGit = await import("../../src/core/git");
    mock.module("../../src/core/git", () => ({
      ...realGit,
      getStatus: async () => {
        throw new Error("could not find git root for the repository");
      },
    }));

    // Import createApp AFTER the mock so the handler closes over the stub.
    const { createApp } = await import("../../src/web/server");
    const app = await createApp();

    const res = await app.request("/api/status", {
      headers: { authorization: `Bearer ${authToken}` },
    });
    expect(res.status).toBe(200);

    const data = (await res.json()) as {
      git: { branch: string; clean: boolean; dirty: string[]; gitError?: string };
    };

    // The crux: a git fault must NOT masquerade as a clean tree.
    expect(data.git.clean).toBe(false);
    expect(typeof data.git.gitError).toBe("string");
    expect(data.git.gitError).toContain("git root");
  }, 15000);
});
