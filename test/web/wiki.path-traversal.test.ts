/**
 * wiki.path-traversal.test.ts — B-07 / Union security: wiki slug guard.
 *
 * Pins the contract that `GET /api/wiki/pages/:slug` validates the slug
 * against a strict allow-regex BEFORE calling readPage(). Without the
 * guard, a slug like "../../../.ssh/id_rsa" composed with
 * `join("/wiki/notes", slug)` inside readPage()'s pagePath() escapes the
 * wiki dir and reads arbitrary `.md` files post-auth.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as TOML from "@iarna/toml";
import { createApp, ensureAuthToken } from "../../src/web/server";

let tmpDir: string;
let authToken: string;
let app: Awaited<ReturnType<typeof createApp>>;

beforeAll(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "am-wiki-traversal-"));
  await mkdir(join(tmpDir, ".agent-manager"), { recursive: true });
  const { initRepo } = await import("../../src/core/git");
  await initRepo(tmpDir);

  await writeFile(
    join(tmpDir, "config.toml"),
    TOML.stringify({ settings: { default_profile: "default" } } as TOML.JsonMap),
  );

  process.env.AM_CONFIG_DIR = tmpDir;
  authToken = ensureAuthToken(tmpDir);
  app = await createApp();
});

afterAll(async () => {
  process.env.AM_CONFIG_DIR = undefined;
  await rm(tmpDir, { recursive: true, force: true });
});

function get(path: string) {
  return app.request(path, {
    headers: { authorization: `Bearer ${authToken}` },
  });
}

describe("GET /api/wiki/pages/:slug — path-traversal guard (B-07)", () => {
  it("returns 400 on URL-encoded ../../etc/passwd", async () => {
    const res = await get("/api/wiki/pages/..%2F..%2Fetc%2Fpasswd");
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBeDefined();
    // Do NOT echo the raw slug back.
    expect(body.error).not.toContain("..");
    expect(body.error).not.toContain("/");
  });

  it("returns 400 on raw '../../.ssh/id_rsa'", async () => {
    // Hono's router treats the slug as a single path segment; encode the
    // slashes the same way a malicious client would.
    const res = await get("/api/wiki/pages/..%2F..%2F.ssh%2Fid_rsa");
    expect(res.status).toBe(400);
  });

  it("returns 400 on slug with leading dot (hidden file)", async () => {
    const res = await get("/api/wiki/pages/.bashrc");
    expect(res.status).toBe(400);
  });

  it("returns 400 on slug with uppercase/space", async () => {
    const res = await get("/api/wiki/pages/Bad%20Slug");
    expect(res.status).toBe(400);
  });

  it("returns 400 on slug with backslash (Windows traversal)", async () => {
    const res = await get("/api/wiki/pages/%5C..%5Cetc%5Cpasswd");
    expect(res.status).toBe(400);
  });

  it("returns 400 on overly-long slug (>128 chars)", async () => {
    const long = "a".repeat(200);
    const res = await get(`/api/wiki/pages/${long}`);
    expect(res.status).toBe(400);
  });

  it("does NOT return 400 on a valid slug (passes the guard)", async () => {
    // Either 200 (page exists) or 404 (it doesn't) — but NOT 400.
    const res = await get("/api/wiki/pages/valid-slug");
    expect(res.status).not.toBe(400);
  });

  it("does NOT return 400 on a slug with dot/underscore/dash", async () => {
    const res = await get("/api/wiki/pages/some_valid.slug-name");
    expect(res.status).not.toBe(400);
  });
});
