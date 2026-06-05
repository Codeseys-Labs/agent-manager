/**
 * Coverage: POST /api/sync/push and POST /api/sync/pull (src/web/server.ts).
 *
 * These endpoints were previously untested. Two concerns:
 *
 *   1. Success-action shape — on a successful git push/pull the handler returns
 *      `{ action: "push"|"pull", success: true }`.
 *
 *   2. Credential-leak in error bodies (SECURITY) — on failure the handler
 *      returns `{ error: errorMessage(e) || "...failed" }`, where
 *      `errorMessage` is the RAW `err.message`. isomorphic-git push/pull errors
 *      can embed the remote URL (including any `user:token@host` credentials).
 *      A safe handler MUST scrub credentials from the URL before echoing it.
 *
 *      EMPIRICAL FINDING (2026-06-04): the handler does NO sanitization — a
 *      credential-bearing error message is echoed verbatim into the 500 JSON
 *      body, leaking the token to the client. We pin the SAFE contract (no
 *      token in the body) with `it.failing`, which:
 *        - keeps the suite green WHILE the leak exists (the assertion is
 *          expected to fail), and
 *        - FLIPS to a hard failure the moment someone adds sanitization (the
 *          test then "unexpectedly passes"), forcing them to drop `.failing`.
 *      This asserts the real, un-weakened safe behavior without masking the bug
 *      or breaking the green-suite verify gate. Tracked as a backlog item:
 *      "web sync error bodies leak credential-bearing remote URLs".
 *
 * We drive both endpoints by stubbing the git module's `push`/`pull` via
 * `mock.module`. Per the Bun caveat (`mock.restore()` does NOT undo
 * `mock.module()`), we snapshot the real git module in beforeAll and re-install
 * it after each test + in afterAll so the stubs never leak into later files.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it, mock } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as TOML from "@iarna/toml";

let tmpDir: string;
let authToken: string;
const originalConfigDir = process.env.AM_CONFIG_DIR;
let REAL_GIT: Record<string, unknown> | undefined;

// A realistic credential-bearing remote URL. The token MUST NOT survive into
// any error body.
const SECRET_TOKEN = "ghp_LEAKYtoken0123456789abcdefABCDEF0123";
const CRED_URL = `https://user:${SECRET_TOKEN}@github.com/me/private-repo.git`;

beforeAll(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "am-web-sync-"));
  REAL_GIT = { ...(await import("../../src/core/git")) };

  const { initRepo } = await import("../../src/core/git");
  await initRepo(tmpDir);
  await writeFile(
    join(tmpDir, "config.toml"),
    TOML.stringify({
      settings: { default_profile: "default" },
      servers: {},
      profiles: { default: { description: "Default profile" } },
    } as TOML.JsonMap),
  );

  process.env.AM_CONFIG_DIR = tmpDir;
  const { ensureAuthToken } = await import("../../src/web/server");
  authToken = ensureAuthToken(tmpDir);
});

afterEach(() => {
  mock.restore();
  // `mock.restore()` does NOT undo `mock.module()`; re-install the real git
  // exports so the push/pull stubs do not leak to later test files.
  if (REAL_GIT) mock.module("../../src/core/git", () => REAL_GIT);
});

afterAll(async () => {
  if (REAL_GIT) mock.module("../../src/core/git", () => REAL_GIT);
  if (originalConfigDir === undefined) Reflect.deleteProperty(process.env, "AM_CONFIG_DIR");
  else process.env.AM_CONFIG_DIR = originalConfigDir;
  await rm(tmpDir, { recursive: true, force: true });
});

describe("POST /api/sync/push & /pull — success-action shape", () => {
  it("push returns { action: 'push', success: true }", async () => {
    const realGit = await import("../../src/core/git");
    mock.module("../../src/core/git", () => ({
      ...realGit,
      push: async () => {
        /* succeed */
      },
    }));
    const { createApp } = await import("../../src/web/server");
    const app = await createApp();

    const res = await app.request("/api/sync/push", {
      method: "POST",
      headers: { authorization: `Bearer ${authToken}` },
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as { action: string; success: boolean };
    expect(data.action).toBe("push");
    expect(data.success).toBe(true);
  });

  it("pull returns { action: 'pull', success: true }", async () => {
    const realGit = await import("../../src/core/git");
    mock.module("../../src/core/git", () => ({
      ...realGit,
      pull: async () => {
        /* succeed */
      },
    }));
    const { createApp } = await import("../../src/web/server");
    const app = await createApp();

    const res = await app.request("/api/sync/pull", {
      method: "POST",
      headers: { authorization: `Bearer ${authToken}` },
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as { action: string; success: boolean };
    expect(data.action).toBe("pull");
    expect(data.success).toBe(true);
  });
});

describe("POST /api/sync/push & /pull — error responses", () => {
  it("push error returns a 500 with an error string", async () => {
    const realGit = await import("../../src/core/git");
    mock.module("../../src/core/git", () => ({
      ...realGit,
      push: async () => {
        throw new Error("ECONNREFUSED");
      },
    }));
    const { createApp } = await import("../../src/web/server");
    const app = await createApp();

    const res = await app.request("/api/sync/push", {
      method: "POST",
      headers: { authorization: `Bearer ${authToken}` },
    });
    expect(res.status).toBe(500);
    const data = (await res.json()) as { error: string };
    expect(typeof data.error).toBe("string");
    expect(data.error.length).toBeGreaterThan(0);
  });

  // ── SECURITY contract (currently FAILING — known leak, see file header) ──
  //
  // These assert the SAFE behavior: a credential-bearing remote URL in the
  // underlying git error must be scrubbed before it reaches the response body.
  // The handler does not yet do this, so the assertions fail and `it.failing`
  // records them as expected failures (suite stays green). When a fix lands,
  // these "unexpectedly pass" and Bun turns them into hard failures — the
  // signal to delete `.failing`.

  it.failing("push error body must NOT echo a credential-bearing remote URL", async () => {
    const realGit = await import("../../src/core/git");
    mock.module("../../src/core/git", () => ({
      ...realGit,
      push: async () => {
        throw new Error(`failed to push to ${CRED_URL}: HTTP 403`);
      },
    }));
    const { createApp } = await import("../../src/web/server");
    const app = await createApp();

    const res = await app.request("/api/sync/push", {
      method: "POST",
      headers: { authorization: `Bearer ${authToken}` },
    });
    expect(res.status).toBe(500);
    const raw = await res.text();
    // SAFE contract: the token must not appear anywhere in the body.
    expect(raw).not.toContain(SECRET_TOKEN);
  });

  it.failing("pull error body must NOT echo a credential-bearing remote URL", async () => {
    const realGit = await import("../../src/core/git");
    mock.module("../../src/core/git", () => ({
      ...realGit,
      pull: async () => {
        throw new Error(`failed to pull from ${CRED_URL}: HTTP 403`);
      },
    }));
    const { createApp } = await import("../../src/web/server");
    const app = await createApp();

    const res = await app.request("/api/sync/pull", {
      method: "POST",
      headers: { authorization: `Bearer ${authToken}` },
    });
    expect(res.status).toBe(500);
    const raw = await res.text();
    expect(raw).not.toContain(SECRET_TOKEN);
  });
});
