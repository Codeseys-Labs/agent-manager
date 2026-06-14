import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import git from "isomorphic-git";
import {
  addRemote,
  commitAll,
  getStatus,
  initRepo,
  isSshRemote,
  log,
  pull,
  push,
  revertHead,
} from "../../src/core/git.ts";
import { AmError } from "../../src/lib/errors.ts";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "am-git-test-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("initRepo", () => {
  test("creates .git directory", async () => {
    await initRepo(dir);
    const entries = await readdir(dir, { withFileTypes: true });
    const hasGit = entries.some((e) => e.name === ".git" && e.isDirectory());
    expect(hasGit).toBe(true);
  });

  test("creates .agent-manager directory", async () => {
    await initRepo(dir);
    const entries = await readdir(dir, { withFileTypes: true });
    const hasAM = entries.some((e) => e.name === ".agent-manager" && e.isDirectory());
    expect(hasAM).toBe(true);
  });

  test("creates .gitignore with correct entries", async () => {
    await initRepo(dir);
    const content = await readFile(join(dir, ".gitignore"), "utf-8");
    expect(content).toContain("config.local.toml");
    expect(content).toContain(".agent-manager/state.toml");
    // Legacy key paths — master key now lives in OS data dir, but these
    // entries defensively ignore any stray file that lands back in the
    // config dir.
    expect(content).toContain(".agent-manager/key.txt");
    expect(content).toContain(".agent-manager/key");
    expect(content).toContain("**/key.txt");
  });

  test("creates initial commit", async () => {
    await initRepo(dir);
    const commits = await git.log({ fs, dir, depth: 10 });
    expect(commits.length).toBe(1);
    expect(commits[0].commit.message).toContain("init");
  });

  // ws3 brownfield-wipe fix: when given config.toml content, initRepo folds
  // it INTO the single init commit so the baseline tree is config-bearing.
  describe("configToml baseline (ws3)", () => {
    async function treeFiles(): Promise<string[]> {
      const out: string[] = [];
      const head = await git.resolveRef({ fs, dir, ref: "HEAD" });
      await git.walk({
        fs,
        dir,
        trees: [git.TREE({ ref: head })],
        map: async (filepath, [entry]) => {
          if (entry && filepath !== "." && (await entry.type()) === "blob") out.push(filepath);
          return filepath;
        },
      });
      return out;
    }

    test("commits config.toml in the SAME single init commit", async () => {
      await initRepo(dir, { configToml: 'key = "value"\n' });

      // Exactly ONE commit — `am undo` requires log length >= 2 to act, so a
      // fresh init must stay at one commit (immediate undo = "Nothing to undo").
      const commits = await git.log({ fs, dir, depth: 10 });
      expect(commits.length).toBe(1);
      expect(commits[0].commit.message).toContain("init");

      // The single commit's tree contains config.toml (not just .gitignore).
      const files = await treeFiles();
      expect(files).toContain("config.toml");
      expect(files).toContain(".gitignore");

      // The bytes we passed are on disk and committed.
      const onDisk = await readFile(join(dir, "config.toml"), "utf-8");
      expect(onDisk).toBe('key = "value"\n');
    });

    test("without configToml, only .gitignore is committed (legacy)", async () => {
      await initRepo(dir);
      const files = await treeFiles();
      expect(files).toContain(".gitignore");
      expect(files).not.toContain("config.toml");
    });

    test("revertHead after a config-bearing init has no parent to revert to", async () => {
      // The config-bearing init is still a single commit, so there is nothing
      // to undo immediately after init — revertHead must throw.
      await initRepo(dir, { configToml: 'key = "value"\n' });
      expect(revertHead(dir)).rejects.toThrow();
    });
  });
});

describe("commitAll", () => {
  test("stages and commits changed files, returns 40-char oid", async () => {
    await initRepo(dir);
    await fs.promises.writeFile(join(dir, "config.toml"), "key = 'value'\n");
    const oid = await commitAll(dir, "add config");
    expect(oid).toMatch(/^[0-9a-f]{40}$/);

    const commits = await git.log({ fs, dir, depth: 10 });
    expect(commits[0].commit.message.trim()).toBe("add config");
  });

  test("throws 'Nothing to commit' on clean tree", async () => {
    await initRepo(dir);
    expect(commitAll(dir, "empty")).rejects.toThrow("Nothing to commit");
  });

  test("handles deleted files", async () => {
    await initRepo(dir);
    // Create and commit a file
    await fs.promises.writeFile(join(dir, "temp.txt"), "hello\n");
    await commitAll(dir, "add temp");

    // Delete it
    await fs.promises.unlink(join(dir, "temp.txt"));
    const oid = await commitAll(dir, "remove temp");
    expect(oid).toMatch(/^[0-9a-f]{40}$/);

    // Verify file is gone from the tree
    const commits = await git.log({ fs, dir, depth: 1 });
    expect(commits[0].commit.message.trim()).toBe("remove temp");
  });
});

describe("log", () => {
  test("returns entries in reverse chronological order", async () => {
    await initRepo(dir);
    await fs.promises.writeFile(join(dir, "a.txt"), "a\n");
    await commitAll(dir, "first");
    await fs.promises.writeFile(join(dir, "b.txt"), "b\n");
    await commitAll(dir, "second");

    const entries = await log(dir);
    expect(entries.length).toBeGreaterThanOrEqual(3); // init + first + second
    expect(entries[0].message).toBe("second");
    expect(entries[1].message).toBe("first");
  });

  test("respects depth limit", async () => {
    await initRepo(dir);
    await fs.promises.writeFile(join(dir, "a.txt"), "a\n");
    await commitAll(dir, "first");
    await fs.promises.writeFile(join(dir, "b.txt"), "b\n");
    await commitAll(dir, "second");

    const entries = await log(dir, 2);
    expect(entries.length).toBe(2);
  });
});

describe("revertHead", () => {
  test("creates a revert commit restoring previous state", async () => {
    await initRepo(dir);
    await fs.promises.writeFile(join(dir, "file.txt"), "original\n");
    await commitAll(dir, "add file");

    await fs.promises.writeFile(join(dir, "file.txt"), "modified\n");
    await commitAll(dir, "modify file");

    await revertHead(dir);

    // File should be back to original content
    const content = await readFile(join(dir, "file.txt"), "utf-8");
    expect(content).toBe("original\n");

    // Should have a revert commit
    const entries = await log(dir, 1);
    expect(entries[0].message).toContain("revert");
  });

  test("throws when no parent commit", async () => {
    await initRepo(dir);
    // Only one commit (init), no parent to revert to
    expect(revertHead(dir)).rejects.toThrow();
  });
});

describe("getStatus", () => {
  test("reports clean state on fresh repo", async () => {
    await initRepo(dir);
    const status = await getStatus(dir);
    expect(status.clean).toBe(true);
    expect(status.branch).toBe("main");
    expect(status.dirty).toEqual([]);
  });

  test("reports dirty state with modified files", async () => {
    await initRepo(dir);
    await fs.promises.writeFile(join(dir, "new.txt"), "stuff\n");
    const status = await getStatus(dir);
    expect(status.clean).toBe(false);
    expect(status.dirty.length).toBeGreaterThan(0);
    expect(status.dirty).toContain("new.txt");
  });

  // R2-SEC1: am_status / am_doctor / web /api/status all consume
  // StatusResult.remotes. A raw remote URL can embed a live credential
  // (https://x-access-token:ghp_xxx@github.com/...). getStatus must scrub
  // userinfo at the boundary so no ungated, read-only consumer leaks it.
  describe("remote URL credential redaction (R2-SEC1)", () => {
    test("strips userinfo from a credential-bearing https remote", async () => {
      await initRepo(dir);
      await addRemote(dir, "https://user:ghp_secrettokenvalue@github.com/org/repo.git");
      const status = await getStatus(dir);
      const origin = status.remotes.find((r) => r.remote === "origin");
      expect(origin).toBeDefined();
      expect(origin?.url).toBe("https://[redacted]@github.com/org/repo.git");
      // Defense-in-depth: the raw token must not survive anywhere in the URL.
      expect(origin?.url).not.toContain("ghp_secrettokenvalue");
      expect(origin?.url).not.toContain("user:");
    });

    test("strips userinfo carrying only a token (no username)", async () => {
      await initRepo(dir);
      await addRemote(dir, "https://x-access-token:ghp_anothersecret@github.com/o/r.git");
      const status = await getStatus(dir);
      const origin = status.remotes.find((r) => r.remote === "origin");
      expect(origin?.url).toBe("https://[redacted]@github.com/o/r.git");
      expect(origin?.url).not.toContain("ghp_anothersecret");
      expect(origin?.url).not.toContain("x-access-token");
    });

    test("leaves a credential-free https remote unchanged", async () => {
      await initRepo(dir);
      await addRemote(dir, "https://github.com/org/repo.git");
      const status = await getStatus(dir);
      const origin = status.remotes.find((r) => r.remote === "origin");
      expect(origin?.url).toBe("https://github.com/org/repo.git");
    });

    test("leaves SCP-style shorthand (git@host:org/repo) unchanged", async () => {
      await initRepo(dir);
      // SCP shorthand has no `://` scheme; it must pass through untouched so
      // we never corrupt a legitimate non-credential remote.
      await addRemote(dir, "git@github.com:org/repo.git");
      const status = await getStatus(dir);
      const origin = status.remotes.find((r) => r.remote === "origin");
      expect(origin?.url).toBe("git@github.com:org/repo.git");
    });
  });
});

describe("addRemote", () => {
  test("adds a remote", async () => {
    await initRepo(dir);
    await addRemote(dir, "https://example.com/repo.git");
    const remotes = await git.listRemotes({ fs, dir });
    expect(remotes.length).toBe(1);
    expect(remotes[0].remote).toBe("origin");
    expect(remotes[0].url).toBe("https://example.com/repo.git");
  });

  test("adds a remote with custom name", async () => {
    await initRepo(dir);
    await addRemote(dir, "https://example.com/repo.git", "upstream");
    const remotes = await git.listRemotes({ fs, dir });
    const upstream = remotes.find((r) => r.remote === "upstream");
    expect(upstream).toBeDefined();
    expect(upstream?.url).toBe("https://example.com/repo.git");
  });
});

// ws-git-sync: close the gap where push/pull advertised transports/auth they
// could not perform. isomorphic-git's HTTP client speaks HTTPS only, has no SSH
// transport, and surfaces opaque 401/403 and FastForward errors. push()/pull()
// now reject SSH up front and translate auth/divergence failures into typed,
// actionable AmErrors.
describe("isSshRemote", () => {
  test("detects scp-style git@host:org/repo shorthand", () => {
    expect(isSshRemote("git@github.com:org/repo.git")).toBe(true);
  });

  test("detects ssh:// scheme", () => {
    expect(isSshRemote("ssh://git@github.com/org/repo.git")).toBe(true);
  });

  test("https/http/git/file/bare paths are NOT ssh", () => {
    expect(isSshRemote("https://github.com/org/repo.git")).toBe(false);
    expect(isSshRemote("http://example.com/repo.git")).toBe(false);
    expect(isSshRemote("git://example.com/repo.git")).toBe(false);
    expect(isSshRemote("file:///abs/path")).toBe(false);
    expect(isSshRemote("/abs/bare/repo.git")).toBe(false);
    expect(isSshRemote("./rel/repo")).toBe(false);
  });
});

describe("push/pull SSH guard (SSH_UNSUPPORTED)", () => {
  test("push against an scp-style remote throws SSH_UNSUPPORTED before any network", async () => {
    await initRepo(dir);
    await addRemote(dir, "git@github.com:org/repo.git");
    let caught: unknown;
    try {
      await push(dir);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(AmError);
    const e = caught as AmError;
    expect(e.code).toBe("SSH_UNSUPPORTED");
    expect(e.message).toContain("SSH");
    // Actionable: points at HTTPS and/or the system git CLI fallback.
    expect(e.suggestion).toContain("HTTPS");
  });

  test("pull against an ssh:// remote throws SSH_UNSUPPORTED with a clear message", async () => {
    await initRepo(dir);
    await addRemote(dir, "ssh://git@github.com/org/repo.git");
    let caught: unknown;
    try {
      await pull(dir);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(AmError);
    const e = caught as AmError;
    expect(e.code).toBe("SSH_UNSUPPORTED");
    expect(e.suggestion).toMatch(/https|git CLI/i);
  });
});

describe("push/pull auth failure (GIT_AUTH_REQUIRED)", () => {
  // isomorphic-git surfaces a private-repo rejection as an HttpError carrying
  // data.statusCode. Shim git.push/git.pull to inject that shape and assert the
  // translation into an actionable AmError (rather than a raw 401 stack).
  function makeHttpError(status: number): Error {
    const err = new Error(`HTTP Error: ${status} Unauthorized`);
    (err as Error & { name: string; code: string; data: { statusCode: number } }).name =
      "HttpError";
    (err as Error & { name: string; code: string; data: { statusCode: number } }).code =
      "HttpError";
    (err as Error & { data: { statusCode: number } }).data = { statusCode: status };
    return err;
  }

  test("push surfaces an actionable AmError on a 401", async () => {
    await initRepo(dir);
    await addRemote(dir, "https://github.com/private/repo.git");
    const original = git.push;
    (git as unknown as { push: typeof git.push }).push = async () => {
      throw makeHttpError(401);
    };
    try {
      let caught: unknown;
      try {
        await push(dir);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(AmError);
      const e = caught as AmError;
      expect(e.code).toBe("GIT_AUTH_REQUIRED");
      expect(e.suggestion).toContain("AM_GIT_TOKEN");
    } finally {
      (git as unknown as { push: typeof git.push }).push = original;
    }
  });

  test("pull surfaces an actionable AmError on a 403", async () => {
    await initRepo(dir);
    await addRemote(dir, "https://github.com/private/repo.git");
    const original = git.pull;
    (git as unknown as { pull: typeof git.pull }).pull = async () => {
      throw makeHttpError(403);
    };
    try {
      let caught: unknown;
      try {
        await pull(dir);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(AmError);
      const e = caught as AmError;
      expect(e.code).toBe("GIT_AUTH_REQUIRED");
      expect(e.message).toContain("403");
    } finally {
      (git as unknown as { pull: typeof git.pull }).pull = original;
    }
  });

  test("non-auth HttpError (e.g. 500) is NOT translated to GIT_AUTH_REQUIRED", async () => {
    await initRepo(dir);
    await addRemote(dir, "https://github.com/x/repo.git");
    const original = git.push;
    (git as unknown as { push: typeof git.push }).push = async () => {
      throw makeHttpError(500);
    };
    try {
      let caught: unknown;
      try {
        await push(dir);
      } catch (err) {
        caught = err;
      }
      // A 500 is not an auth failure — the raw error propagates unchanged.
      expect(caught instanceof AmError && (caught as AmError).code === "GIT_AUTH_REQUIRED").toBe(
        false,
      );
    } finally {
      (git as unknown as { push: typeof git.push }).push = original;
    }
  });
});

describe("pull merge-conflict translation (GIT_PULL_CONFLICT)", () => {
  // A non-fast-forward divergence makes isomorphic-git throw a FastForwardError
  // / MergeNotSupportedError. Shim git.pull to inject each shape and assert
  // pull() rethrows a typed, actionable AmError naming the config dir.
  test("FastForwardError becomes an actionable AmError naming the config dir", async () => {
    await initRepo(dir);
    await addRemote(dir, "https://github.com/x/repo.git");
    const original = git.pull;
    (git as unknown as { pull: typeof git.pull }).pull = async () => {
      const err = new Error("A simple fast-forward merge was not possible.");
      (err as Error & { name: string; code: string }).name = "FastForwardError";
      (err as Error & { name: string; code: string }).code = "FastForwardError";
      throw err;
    };
    try {
      let caught: unknown;
      try {
        await pull(dir);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(AmError);
      const e = caught as AmError;
      expect(e.code).toBe("GIT_PULL_CONFLICT");
      expect(e.message.toLowerCase()).toContain("diverged");
      // Actionable: tells the user where to resolve and to re-run am pull.
      expect(e.suggestion).toContain(dir);
      expect(e.suggestion).toContain("am pull");
    } finally {
      (git as unknown as { pull: typeof git.pull }).pull = original;
    }
  });

  test("MergeNotSupportedError also maps to GIT_PULL_CONFLICT", async () => {
    await initRepo(dir);
    await addRemote(dir, "https://github.com/x/repo.git");
    const original = git.pull;
    (git as unknown as { pull: typeof git.pull }).pull = async () => {
      const err = new Error("Merges with conflicts are not supported yet.");
      (err as Error & { name: string; code: string }).name = "MergeNotSupportedError";
      (err as Error & { name: string; code: string }).code = "MergeNotSupportedError";
      throw err;
    };
    try {
      let caught: unknown;
      try {
        await pull(dir);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(AmError);
      expect((caught as AmError).code).toBe("GIT_PULL_CONFLICT");
    } finally {
      (git as unknown as { pull: typeof git.pull }).pull = original;
    }
  });

  test("an unrelated pull error propagates unchanged (not wrapped)", async () => {
    await initRepo(dir);
    await addRemote(dir, "https://github.com/x/repo.git");
    const original = git.pull;
    const sentinel = new Error("network down");
    (sentinel as Error & { code: string }).code = "NetworkError";
    (git as unknown as { pull: typeof git.pull }).pull = async () => {
      throw sentinel;
    };
    try {
      let caught: unknown;
      try {
        await pull(dir);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBe(sentinel);
      expect(caught instanceof AmError).toBe(false);
    } finally {
      (git as unknown as { pull: typeof git.pull }).pull = original;
    }
  });
});
