import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { join } from "node:path";
import { crossTreeSecretHint } from "../../src/lib/secret-alias-hint";
import { bunExe } from "../helpers/bun-exe";

// ws4-6fd2 UX polish: `am secret` (values) and `am secrets` (backend ops) are
// intentionally-separate trees. A typo'd cross-tree verb must surface a
// friendly "Did you mean …" breadcrumb to the sibling tree.

describe("crossTreeSecretHint (pure)", () => {
  test("`secret migrate` points to `secrets migrate`", () => {
    expect(crossTreeSecretHint(["secret", "migrate"])).toContain("am secrets migrate");
  });

  test("`secret rotate` points to `secrets rotate`", () => {
    const hint = crossTreeSecretHint(["secret", "rotate"]);
    expect(hint).toContain("Did you mean");
    expect(hint).toContain("am secrets rotate");
  });

  test("`secrets get` points to `secret get`", () => {
    expect(crossTreeSecretHint(["secrets", "get"])).toContain("am secret get");
  });

  test("`secrets set` points to `secret set`", () => {
    expect(crossTreeSecretHint(["secrets", "set"])).toContain("am secret set");
  });

  test("no hint for a real subcommand of the invoked tree", () => {
    expect(crossTreeSecretHint(["secret", "get"])).toBeNull();
    expect(crossTreeSecretHint(["secrets", "migrate"])).toBeNull();
  });

  test("no hint for unrelated commands, bare group, flags, or --help", () => {
    expect(crossTreeSecretHint(["status"])).toBeNull();
    expect(crossTreeSecretHint(["secret"])).toBeNull();
    expect(crossTreeSecretHint(["secrets"])).toBeNull();
    expect(crossTreeSecretHint(["secret", "--json"])).toBeNull();
    expect(crossTreeSecretHint(["secret", "migrate", "--help"])).toBeNull();
  });
});

// Observable via the CLI: the breadcrumb prints on stderr ahead of citty's
// `Unknown command` error. Spawn the real entrypoint so the wiring in
// `src/cli.ts` start() is exercised end-to-end.
describe("am secret/secrets cross-pointer (CLI)", () => {
  setDefaultTimeout(60_000);

  async function runAM(...args: string[]): Promise<{ stderr: string; code: number }> {
    const proc = Bun.spawn([bunExe(), "run", "src/cli.ts", ...args], {
      cwd: join(import.meta.dir, "../.."),
      stdout: "pipe",
      stderr: "pipe",
    });
    const stderr = await new Response(proc.stderr).text();
    return { stderr, code: await proc.exited };
  }

  test("`am secret migrate` prints the secrets-tree hint", async () => {
    const { stderr } = await runAM("secret", "migrate");
    expect(stderr).toContain("am secrets migrate");
  });

  test("`am secrets get` prints the secret-tree hint", async () => {
    const { stderr } = await runAM("secrets", "get");
    expect(stderr).toContain("am secret get");
  });
});
