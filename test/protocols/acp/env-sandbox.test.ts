/**
 * env-sandbox.test.ts — REV-2 HIGH-3 / ADR-0033 Phase B prelaunch gate.
 *
 * Pins the contract that:
 *   - sandboxEnv() drops every secret-shaped var from process.env.
 *   - Caller-supplied `extra` overlays on top (so `am run --env X=Y` works).
 *   - The end-to-end path (AmAcpClient.connect → Bun.spawn) doesn't leak
 *     AM_CANARY into the subprocess's env.
 *
 * Failing-before evidence: at HEAD^^ the spawn line was
 * `env: { ...process.env, ...opts?.env }`. The live env-leak probe at the
 * bottom of this file would see AM_CANARY in the captured stdout; after
 * the fix it sees only the allow-listed keys (PATH, HOME, etc.).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { isDeniedEnvName, sandboxEnv } from "../../../src/protocols/acp/env-sandbox";

describe("sandboxEnv — allow-list and deny-regex", () => {
  // Save/restore env so probe tests don't pollute sibling tests.
  const savedEnv: Record<string, string | undefined> = {};
  const CANARY_VARS = [
    "AM_MCP_TOKEN",
    "AM_ENCRYPTION_KEY",
    "ANTHROPIC_API_KEY",
    "OPENAI_API_KEY",
    "AWS_SESSION_TOKEN",
    "AWS_ACCESS_KEY_ID",
    "GITHUB_TOKEN",
    "GOOGLE_API_KEY",
    "AM_CANARY",
    "SOME_PASSWORD",
    "SOME_SECRET",
    "SOME_CRED",
    "SERVICE_SESSION",
  ];
  beforeEach(() => {
    for (const k of CANARY_VARS) savedEnv[k] = process.env[k];
  });
  afterEach(() => {
    for (const k of CANARY_VARS) {
      if (savedEnv[k] === undefined) process.env[k] = undefined;
      else process.env[k] = savedEnv[k];
    }
  });

  test("includes PATH and HOME when present in process.env", () => {
    process.env.PATH = "/usr/bin:/bin";
    process.env.HOME = "/home/user";
    const env = sandboxEnv();
    expect(env.PATH).toBe("/usr/bin:/bin");
    expect(env.HOME).toBe("/home/user");
  });

  test("does NOT include AM_MCP_TOKEN from process.env", () => {
    process.env.AM_MCP_TOKEN = "super-secret-token";
    const env = sandboxEnv();
    expect(env.AM_MCP_TOKEN).toBeUndefined();
  });

  test("does NOT include AM_ENCRYPTION_KEY from process.env", () => {
    process.env.AM_ENCRYPTION_KEY = "some-key-value";
    const env = sandboxEnv();
    expect(env.AM_ENCRYPTION_KEY).toBeUndefined();
  });

  test("does NOT include OPENAI_API_KEY from process.env", () => {
    process.env.OPENAI_API_KEY = "sk-secret";
    const env = sandboxEnv();
    expect(env.OPENAI_API_KEY).toBeUndefined();
  });

  test("does NOT include ANTHROPIC_API_KEY from process.env", () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-secret";
    const env = sandboxEnv();
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
  });

  test("does NOT include any AWS_* var from process.env", () => {
    process.env.AWS_ACCESS_KEY_ID = "AKIAEXAMPLE";
    process.env.AWS_SESSION_TOKEN = "session";
    const env = sandboxEnv();
    expect(env.AWS_ACCESS_KEY_ID).toBeUndefined();
    expect(env.AWS_SESSION_TOKEN).toBeUndefined();
  });

  test("does NOT include GITHUB_TOKEN from process.env", () => {
    process.env.GITHUB_TOKEN = "ghp_secret";
    const env = sandboxEnv();
    expect(env.GITHUB_TOKEN).toBeUndefined();
  });

  test("does NOT include GOOGLE_API_KEY from process.env", () => {
    process.env.GOOGLE_API_KEY = "AIza-secret";
    const env = sandboxEnv();
    expect(env.GOOGLE_API_KEY).toBeUndefined();
  });

  test("sandboxEnv({ FOO: 'bar' }) includes FOO=bar", () => {
    const env = sandboxEnv({ FOO: "bar" });
    expect(env.FOO).toBe("bar");
  });

  test("caller-supplied extras overlay on top of allow-list (overriding even PATH)", () => {
    process.env.PATH = "/usr/bin";
    const env = sandboxEnv({ PATH: "/custom/bin" });
    expect(env.PATH).toBe("/custom/bin");
  });

  test("REV-4 MED-2: NODE_OPTIONS is NOT inherited from process.env by default", () => {
    process.env.NODE_OPTIONS = "--require /tmp/evil.js";
    try {
      const env = sandboxEnv();
      expect(env.NODE_OPTIONS).toBeUndefined();
    } finally {
      Reflect.deleteProperty(process.env, "NODE_OPTIONS");
    }
  });

  test("REV-4 MED-2: NODE_OPTIONS can be reinstated by caller via extras", () => {
    // Even with a dangerous value in process.env, only the explicit `extra`
    // passed by the caller should survive.
    process.env.NODE_OPTIONS = "--require /tmp/evil.js";
    try {
      const env = sandboxEnv({ NODE_OPTIONS: "--max-old-space-size=4096" });
      expect(env.NODE_OPTIONS).toBe("--max-old-space-size=4096");
    } finally {
      Reflect.deleteProperty(process.env, "NODE_OPTIONS");
    }
  });

  test("deny pattern matches AM_* names", () => {
    expect(isDeniedEnvName("AM_MCP_TOKEN")).toBe(true);
    expect(isDeniedEnvName("AM_KEY_PATH")).toBe(true);
    expect(isDeniedEnvName("AM_CANARY")).toBe(true);
  });

  test("deny pattern matches *_TOKEN/SECRET/KEY/PASSWORD/CRED/SESSION", () => {
    expect(isDeniedEnvName("SERVICE_TOKEN")).toBe(true);
    expect(isDeniedEnvName("SOME_SECRET")).toBe(true);
    expect(isDeniedEnvName("APPLE_KEY")).toBe(true);
    expect(isDeniedEnvName("SOME_PASSWORD")).toBe(true);
    expect(isDeniedEnvName("SOME_CRED")).toBe(true);
    expect(isDeniedEnvName("SERVICE_SESSION")).toBe(true);
  });

  test("deny pattern matches AWS_/OPENAI_/ANTHROPIC_/GOOGLE_ prefixes", () => {
    expect(isDeniedEnvName("AWS_REGION")).toBe(true);
    expect(isDeniedEnvName("OPENAI_ORGANIZATION")).toBe(true);
    expect(isDeniedEnvName("ANTHROPIC_BASE_URL")).toBe(true);
    expect(isDeniedEnvName("GOOGLE_APPLICATION_CREDENTIALS")).toBe(true);
  });

  test("deny pattern does NOT match benign names (PATH, HOME, TERM)", () => {
    expect(isDeniedEnvName("PATH")).toBe(false);
    expect(isDeniedEnvName("HOME")).toBe(false);
    expect(isDeniedEnvName("TERM")).toBe(false);
    expect(isDeniedEnvName("LANG")).toBe(false);
  });
});

describe("live env-leak probe — AmAcpClient.connect via /bin/bash", () => {
  // Real integration test: spawn a bash subprocess through the client,
  // have it echo its env, assert no secrets leaked. Skipped on Windows
  // because /bin/bash is a POSIX path.
  test.skipIf(process.platform === "win32")(
    "does NOT leak AM_CANARY from parent env into subprocess",
    async () => {
      const originalCanary = process.env.AM_CANARY;
      process.env.AM_CANARY = "leak-me-if-you-can-XYZ123";
      try {
        // Spawn `/bin/bash -c 'echo ENV=$AM_CANARY'` through the client.
        // connect() will fail (bash doesn't speak ACP and will exit once it
        // prints), but BEFORE it fails we've already spawned the child with
        // its scrubbed env. We capture stderr via `stderr: "inherit"` — but
        // that goes to our own stderr, which we can't read back. Instead we
        // spawn via Bun.spawn directly to capture stdout AND simultaneously
        // exercise the sandboxEnv() path the client uses.
        //
        // Approach: import sandboxEnv, call it exactly as the client does,
        // spawn bash with that env, capture stdout, assert no leak.
        const { sandboxEnv: sbx } = await import("../../../src/protocols/acp/env-sandbox");
        const proc = Bun.spawn(["/bin/bash", "-c", "echo ENV=$AM_CANARY"], {
          stdin: "ignore",
          stdout: "pipe",
          stderr: "pipe",
          env: sbx(),
        });
        const stdout = proc.stdout ? await new Response(proc.stdout as ReadableStream).text() : "";
        await proc.exited;
        expect(stdout).not.toContain("leak-me-if-you-can-XYZ123");
        // Expected output is "ENV=\n" because AM_CANARY is scrubbed.
        expect(stdout.trim()).toBe("ENV=");
      } finally {
        if (originalCanary === undefined) Reflect.deleteProperty(process.env, "AM_CANARY");
        else process.env.AM_CANARY = originalCanary;
      }
    },
  );

  test("REV-4 LOW-2: AmAcpClient module statically imports sandboxEnv", async () => {
    // Structural guarantee: client.ts must route every spawn through
    // sandboxEnv(). Enforced by a string match on the compiled module
    // source so a refactor that drops the import fails this test instead
    // of silently regressing the env-leak fix.
    const clientSource = await Bun.file(
      new URL("../../../src/protocols/acp/client.ts", import.meta.url),
    ).text();
    expect(clientSource).toContain('from "./env-sandbox"');
    // Both the connect() path and the terminal/spawn path must call it.
    const sandboxEnvCalls = clientSource.match(/sandboxEnv\s*\(/g) ?? [];
    expect(sandboxEnvCalls.length).toBeGreaterThanOrEqual(2);
  });

  // End-to-end integration: go through AmAcpClient.connect() itself (not
  // Bun.spawn directly) to prove the connect path calls sandboxEnv.
  //
  // Approach: the target "agent" is a shell script that dumps its env to a
  // known file, then exits (never speaks ACP). connect() will fail at the
  // protocol handshake, but the env file is written BEFORE that failure.
  // We then read the file and assert no canary secrets leaked.
  //
  // Skipped on Windows: /bin/sh, shell heredoc. See env-sandbox.test.ts:167.
  test.skipIf(process.platform === "win32")(
    "AmAcpClient.connect scrubs AM_CANARY before spawning agent subprocess",
    async () => {
      const { AmAcpClient } = await import("../../../src/protocols/acp/client");
      const { mkdtemp, writeFile, readFile, unlink, chmod } = await import("node:fs/promises");
      const { tmpdir } = await import("node:os");
      const { join } = await import("node:path");

      const workDir = await mkdtemp(join(tmpdir(), "am-env-e2e-"));
      const envFile = join(workDir, "child-env.txt");
      const script = join(workDir, "fake-agent.sh");

      // Script: write every env line to $AM_ENV_FILE then exit 1. The exit
      // prevents connect() from hanging on a handshake that will never come.
      await writeFile(
        script,
        `#!/bin/sh
env > "${envFile}"
exit 1
`,
        { mode: 0o755 },
      );
      await chmod(script, 0o755);

      const originalCanary = process.env.AM_CANARY;
      const originalToken = process.env.AM_MCP_TOKEN;
      process.env.AM_CANARY = "e2e-leak-XYZ789";
      process.env.AM_MCP_TOKEN = "e2e-token-ABC456";

      try {
        const client = new AmAcpClient();
        try {
          // connect() will throw because the fake agent exits 1 without an
          // ACP handshake. We catch the error and proceed to the assertion —
          // the env dump has already been written by the script's `env` line.
          await client.connect(script, { initTimeout: 3000 });
        } catch {
          // expected
        }
        try {
          await client.disconnect();
        } catch {
          // also fine
        }

        // Read what the child process saw in its env.
        let childEnv = "";
        try {
          childEnv = await readFile(envFile, "utf8");
        } catch {
          // If the script didn't even start, we can't make the assertion.
          throw new Error(
            "Fake agent script did not produce env file — connect() may not have spawned it at all.",
          );
        }
        expect(childEnv).not.toContain("e2e-leak-XYZ789");
        expect(childEnv).not.toContain("e2e-token-ABC456");
        // Sanity: allow-listed vars should still be there.
        expect(childEnv).toContain("PATH=");
      } finally {
        if (originalCanary === undefined) Reflect.deleteProperty(process.env, "AM_CANARY");
        else process.env.AM_CANARY = originalCanary;
        if (originalToken === undefined) Reflect.deleteProperty(process.env, "AM_MCP_TOKEN");
        else process.env.AM_MCP_TOKEN = originalToken;
        try {
          await unlink(envFile);
        } catch {
          // ignore
        }
        try {
          await unlink(script);
        } catch {
          // ignore
        }
      }
    },
    15_000,
  );
});
